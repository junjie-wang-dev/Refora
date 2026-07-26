import { type BrowserWindow, utilityProcess } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import type { Repositories } from '../db/repositories'
import type { Document } from '../../shared/ipc-types'
import { RepoError } from '../db/repositories/errors'
import { newId } from '../db/repositories/documents'
import { logger } from './logger'
import {
  pdfPreviewCachePath,
  readPdfPreviewCache,
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
}

const WORKER_TIMEOUT_MS = 120_000
const WORKER_IDLE_TIMEOUT_MS = 60_000
const MAX_WORKERS = 3

export function createPdfTextService(
  repos: Repositories | null,
  _win: BrowserWindow | (() => BrowserWindow | null)
) {
  let destroyed = false
  const previewRequests = new Map<string, Promise<Uint8Array>>()
  const pool: WorkerSlot[] = Array.from({ length: MAX_WORKERS }, () => ({
    proc: null,
    killed: false,
    idleTimer: null,
    pending: new Map<string, PendingRequest>(),
    active: 0
  }))

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
    slot.proc = utilityProcess.fork(join(__dirname, 'worker/pdf-worker.js'), [], {
      serviceName: `PDF Text Worker ${index + 1}`,
      stdio: 'pipe'
    })
    slot.killed = false
    slot.proc.on('message', (msg: WorkerResponse) => {
      const req = slot.pending.get(msg.correlationId)
      if (req) {
        clearTimeout(req.timer)
        slot.pending.delete(msg.correlationId)
        req.resolve(msg)
      }
    })
    slot.proc.on('exit', (code) => {
      logger.warn(`pdfText-worker:exit idx=${index} code=${code} pending=${slot.pending.size}`)
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer)
        slot.idleTimer = null
      }
      for (const [, req] of slot.pending) {
        clearTimeout(req.timer)
        req.reject(new Error('PDF text worker exited unexpectedly'))
      }
      slot.pending.clear()
      slot.proc = null
      slot.killed = true
    })
    if (slot.proc.stderr) {
      slot.proc.stderr.on('data', (chunk: Buffer) => {
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
    if (best && bestLoad > 0) {
      for (const slot of pool) {
        if (!slot.proc || slot.killed) {
          return ensureWorkerSlot(pool.indexOf(slot))
        }
      }
    }
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
    payload: { action: 'extract'; maxPages: number } | { action: 'preview' }
  ): Promise<WorkerResponse> {
    const correlationId = newId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(correlationId)
        reject(new Error(`PDF text worker request timed out: ${filePath}`))
      }, WORKER_TIMEOUT_MS)
      slot.pending.set(correlationId, { resolve, reject, timer })
      slot.proc!.postMessage({ correlationId, filePath, ...payload })
    })
  }

  async function getOrExtract(docId: string): Promise<string> {
    if (destroyed) throw new Error('PDF text service destroyed')
    if (!repos) throw new Error('PDF text extraction repository is unavailable')

    const doc = repos.documents.get(docId)
    if (!doc) throw new RepoError('not_found', `Document ${docId} not found`)

    const cached = repos.aiSummaries.getFullText(docId)
    if (cached !== null) {
      const docHash = doc.fileHash ?? null
      if (docHash === null || cached.hash === null || cached.hash === docHash) {
        return cached.text
      }
    }

    const filePath = resolvePath(doc.filePath)
    if (!filePath.toLowerCase().endsWith('.pdf')) {
      throw new RepoError('invalid_path', `Not a PDF file: ${filePath}`)
    }

    const slot = acquireSlot()
    slot.active++
    try {
      const response = await requestWorker(slot, filePath, { action: 'extract', maxPages: 0 })
      if (response.error) {
        throw new Error(response.error.message)
      }
      const text = response.text ?? ''
      repos.aiSummaries.setFullText(docId, text, doc.fileHash ?? null)
      return text
    } finally {
      slot.active--
      if (slot.active === 0 && slot.pending.size === 0) {
        scheduleIdleKill(slot)
      }
    }
  }

  async function renderPreview(filePath: string, fileName: string): Promise<Uint8Array> {
    const slot = acquireSlot()
    slot.active++
    try {
      const response = await requestWorker(slot, filePath, { action: 'preview' })
      if (response.error) throw new Error(response.error.message)
      if (!response.preview || response.preview.length === 0) {
        throw new RepoError('preview_unavailable', `Unable to preview PDF: ${fileName}`)
      }
      return response.preview
    } finally {
      slot.active--
      if (slot.active === 0 && slot.pending.size === 0) scheduleIdleKill(slot)
    }
  }

  async function getPreviewForDocument(
    doc: Pick<Document, 'id' | 'filePath' | 'fileName' | 'fileHash'>,
    configuredLibrary: string
  ): Promise<Uint8Array> {
    if (destroyed) throw new Error('PDF text service destroyed')
    const filePath = resolvePdfFilePath(doc.filePath)
    const libraryFolder = resolvePath(configuredLibrary.trim())
    if (!configuredLibrary.trim() || !existsSync(libraryFolder) || !statSync(libraryFolder).isDirectory()) {
      throw new RepoError('invalid_library', 'Library folder is not configured or unavailable')
    }
    const sourceStats = statSync(filePath)
    const sourceIdentity = `${doc.fileHash ?? 'unhashed'}:${sourceStats.size}:${sourceStats.mtimeMs}`
    const cachePath = pdfPreviewCachePath(libraryFolder, doc.id, sourceIdentity)
    const cached = await readPdfPreviewCache(cachePath)
    if (cached) return cached

    const pending = previewRequests.get(cachePath)
    if (pending) return pending
    const request = renderPreview(filePath, doc.fileName).then(async (preview) => {
      await writePdfPreviewCache(cachePath, preview)
      return preview
    }).finally(() => {
      previewRequests.delete(cachePath)
    })
    previewRequests.set(cachePath, request)
    return request
  }

  async function getPreview(docId: string): Promise<Uint8Array> {
    if (!repos) throw new Error('PDF preview repository is unavailable')
    const doc = repos.documents.get(docId)
    if (!doc) throw new RepoError('not_found', `Document ${docId} not found`)
    return getPreviewForDocument(
      doc,
      repos.settings.get<string>('libraryFolderPath', '')
    )
  }

  function destroy(): void {
    destroyed = true
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

  return { getOrExtract, getPreview, getPreviewForDocument, destroy }
}

export type PdfTextService = ReturnType<typeof createPdfTextService>
