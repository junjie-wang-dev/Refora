import { randomUUID } from 'node:crypto'
import { utilityProcess } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import type { Document } from '../../shared/ipc-types'
import { MainProcessError } from './errors'
import { logger } from './logger'
import {
  pdfPreviewCachePath,
  prunePdfPreviewCacheVersions,
  readPdfPreviewCache,
  removePdfPreviewCacheForDocument,
  writePdfPreviewCache
} from './pdfPreviewCache'
import { resolvePdfFilePath } from './pdfPath'

interface WorkerResponse {
  correlationId: string
  error?: { type: string; message: string }
  text?: string
  preview?: Uint8Array
}

interface PendingRequest {
  resolve: (value: WorkerResponse) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface WorkerSlot {
  proc: ReturnType<typeof utilityProcess.fork> | null
  killed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  pending: Map<string, PendingRequest>
  active: number
  generation: number
}

interface ExecutionWaiter {
  resolve: () => void
  reject: (reason: Error) => void
}

interface PdfTextServiceDeps {
  workerTimeoutMs?: number
}

const WORKER_TIMEOUT_MS = 120_000
const WORKER_IDLE_TIMEOUT_MS = 60_000
const MAX_WORKERS = 3

export function createPdfTextService(deps: PdfTextServiceDeps = {}) {
  const workerTimeoutMs = deps.workerTimeoutMs ?? WORKER_TIMEOUT_MS
  let destroyed = false
  let executionCount = 0
  const executionWaiters: ExecutionWaiter[] = []
  const previewRequests = new Map<string, Promise<Uint8Array>>()
  const previewGenerations = new Map<string, number>()
  const deletedPreviewDocuments = new Set<string>()
  const pool: WorkerSlot[] = Array.from({ length: MAX_WORKERS }, () => ({
    proc: null,
    killed: false,
    idleTimer: null,
    pending: new Map<string, PendingRequest>(),
    active: 0,
    generation: 0
  }))

  function failSlotPending(slot: WorkerSlot, error: Error): void {
    for (const [, req] of slot.pending) {
      clearTimeout(req.timer)
      req.reject(error)
    }
    slot.pending.clear()
  }

  function scheduleIdleKill(slot: WorkerSlot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    slot.idleTimer = setTimeout(() => {
      if (slot.pending.size === 0 && slot.active === 0) {
        if (slot.proc && !slot.killed) {
          logger.info('pdfText-worker:idle-kill')
          slot.proc.kill()
          slot.killed = true
          slot.proc = null
        }
      }
    }, WORKER_IDLE_TIMEOUT_MS)
  }

  function ensureWorkerSlot(index: number): WorkerSlot {
    const slot = pool[index]
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer)
      slot.idleTimer = null
    }
    if (slot.proc && !slot.killed) return slot
    const generation = slot.generation + 1
    slot.generation = generation
    const proc = utilityProcess.fork(join(__dirname, 'worker/pdf-worker.js'), [], {
      serviceName: `PDF Text Worker ${index + 1}`,
      stdio: 'pipe'
    })
    slot.proc = proc
    slot.killed = false
    proc.on('message', (msg: WorkerResponse) => {
      if (slot.proc !== proc) return
      const req = slot.pending.get(msg.correlationId)
      if (req) {
        clearTimeout(req.timer)
        slot.pending.delete(msg.correlationId)
        req.resolve(msg)
      }
    })
    proc.on('exit', (code) => {
      if (slot.proc !== proc || slot.generation !== generation) return
      logger.warn(`pdfText-worker:exit idx=${index} code=${code} pending=${slot.pending.size}`)
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer)
        slot.idleTimer = null
      }
      failSlotPending(slot, new Error('PDF text worker exited unexpectedly'))
      slot.proc = null
      slot.killed = true
    })
    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        logger.error(`pdfText-worker:stderr idx=${index} ${chunk.toString().trim()}`)
      })
    }
    logger.info(`pdfText-worker:started idx=${index}`)
    return slot
  }

  function acquireSlot(): WorkerSlot {
    let best: WorkerSlot | null = null
    let bestLoad = Infinity
    for (const slot of pool) {
      if (slot.proc && !slot.killed) {
        const load = slot.pending.size + slot.active
        if (load < bestLoad) {
          bestLoad = load
          best = slot
        }
      }
    }
    if (best && bestLoad === 0) return best
    for (const slot of pool) {
      if (!slot.proc || slot.killed) {
        return ensureWorkerSlot(pool.indexOf(slot))
      }
    }
    return best ?? ensureWorkerSlot(0)
  }

  function requestWorker(
    slot: WorkerSlot,
    filePath: string,
    payload: { action: 'preview' }
  ): Promise<WorkerResponse> {
    const correlationId = randomUUID()
    const proc = slot.proc
    if (!proc || slot.killed) return Promise.reject(new Error('PDF text worker is unavailable'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(correlationId)
        if (slot.proc === proc && !slot.killed) {
          slot.generation += 1
          slot.proc = null
          slot.killed = true
          try {
            proc.kill()
          } catch (error) {
            logger.warn(`pdfText-worker:timeout-kill ${error instanceof Error ? error.message : String(error)}`)
          }
          failSlotPending(slot, new Error(`PDF text worker request timed out: ${filePath}`))
        }
        reject(new Error(`PDF text worker request timed out: ${filePath}`))
      }, workerTimeoutMs)
      slot.pending.set(correlationId, { resolve, reject, timer })
      try {
        proc.postMessage({ correlationId, filePath, ...payload })
      } catch (error) {
        clearTimeout(timer)
        slot.pending.delete(correlationId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function acquireExecution(): Promise<void> {
    if (destroyed) return Promise.reject(new Error('PDF text service destroyed'))
    if (executionCount < MAX_WORKERS) {
      executionCount += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      executionWaiters.push({ resolve, reject })
    })
  }

  function releaseExecution(): void {
    const waiter = executionWaiters.shift()
    if (waiter) {
      waiter.resolve()
      return
    }
    executionCount = Math.max(0, executionCount - 1)
  }

  async function renderPreview(filePath: string, fileName: string): Promise<Uint8Array> {
    await acquireExecution()
    if (destroyed) {
      releaseExecution()
      throw new Error('PDF text service destroyed')
    }
    const slot = acquireSlot()
    slot.active++
    try {
      const response = await requestWorker(slot, filePath, { action: 'preview' })
      if (response.error) throw new Error(response.error.message)
      if (!response.preview || response.preview.length === 0) {
        throw new MainProcessError('preview_unavailable', `Unable to preview PDF: ${fileName}`)
      }
      return response.preview
    } finally {
      slot.active--
      if (slot.active === 0 && slot.pending.size === 0) scheduleIdleKill(slot)
      releaseExecution()
    }
  }

  async function getPreviewForDocument(
    doc: Pick<Document, 'id' | 'filePath' | 'fileName' | 'fileHash'>,
    configuredLibrary: string
  ): Promise<Uint8Array> {
    if (destroyed) throw new Error('PDF text service destroyed')
    const libraryFolder = resolvePath(configuredLibrary.trim())
    if (!configuredLibrary.trim() || !existsSync(libraryFolder) || !statSync(libraryFolder).isDirectory()) {
      throw new MainProcessError('invalid_library', 'Library folder is not configured or unavailable')
    }
    const documentKey = `${libraryFolder}\0${doc.id}`
    if (deletedPreviewDocuments.has(documentKey)) {
      throw new MainProcessError('preview_unavailable', `Unable to preview deleted document: ${doc.fileName}`)
    }
    const generation = previewGenerations.get(documentKey) ?? 0
    const filePath = resolvePdfFilePath(doc.filePath)
    const sourceStats = statSync(filePath)
    const sourceIdentity = `${doc.fileHash ?? 'unhashed'}:${sourceStats.size}:${sourceStats.mtimeMs}`
    const cachePath = pdfPreviewCachePath(libraryFolder, doc.id, sourceIdentity)
    const cached = await readPdfPreviewCache(cachePath)
    if (cached) {
      await prunePdfPreviewCacheVersions(cachePath)
      return cached
    }

    const pending = previewRequests.get(cachePath)
    if (pending) return pending
    const request = renderPreview(filePath, doc.fileName).then(async (preview) => {
      if (
        !destroyed &&
        !deletedPreviewDocuments.has(documentKey) &&
        (previewGenerations.get(documentKey) ?? 0) === generation
      ) {
        await writePdfPreviewCache(cachePath, preview)
      }
      if (
        destroyed ||
        deletedPreviewDocuments.has(documentKey) ||
        (previewGenerations.get(documentKey) ?? 0) !== generation
      ) {
        await removePdfPreviewCacheForDocument(libraryFolder, doc.id)
      }
      return preview
    }).finally(() => {
      previewRequests.delete(cachePath)
    })
    previewRequests.set(cachePath, request)
    return request
  }

  async function removePreviewCacheForDocument(
    documentId: string,
    configuredLibrary: string
  ): Promise<void> {
    const libraryFolder = resolvePath(configuredLibrary.trim())
    if (!configuredLibrary.trim() || !existsSync(libraryFolder) || !statSync(libraryFolder).isDirectory()) {
      throw new MainProcessError('invalid_library', 'Library folder is not configured or unavailable')
    }
    const documentKey = `${libraryFolder}\0${documentId}`
    previewGenerations.set(documentKey, (previewGenerations.get(documentKey) ?? 0) + 1)
    deletedPreviewDocuments.add(documentKey)
    await removePdfPreviewCacheForDocument(libraryFolder, documentId)
  }

  function destroy(): void {
    destroyed = true
    previewGenerations.clear()
    deletedPreviewDocuments.clear()
    for (const waiter of executionWaiters.splice(0)) {
      waiter.reject(new Error('PDF text service destroyed'))
    }
    for (const slot of pool) {
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer)
        slot.idleTimer = null
      }
      if (slot.proc && !slot.killed) {
        slot.proc.kill()
        slot.killed = true
        slot.proc = null
      }
      for (const [, req] of slot.pending) {
        clearTimeout(req.timer)
        req.reject(new Error('PDF text service destroyed'))
      }
      slot.pending.clear()
      slot.active = 0
    }
  }

  return { getPreviewForDocument, removePreviewCacheForDocument, destroy }
}

export type PdfTextService = ReturnType<typeof createPdfTextService>
