import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPdfTextService } from '../../src/main/services/pdfText'
import {
  MAX_PDF_PREVIEW_CACHE_BYTES,
  pdfPreviewCachePath
} from '../../src/main/services/pdfPreviewCache'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('electron', () => ({
  utilityProcess: { fork: mocks.fork }
}))

vi.mock('../../src/main/services/logger', () => ({
  default: {},
  logger: mocks.logger
}))

interface MockWorker {
  on: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  stderr: { on: ReturnType<typeof vi.fn> }
}

function makeWorker(): MockWorker {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {}
  return {
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      ;(handlers[event] ??= []).push(cb)
    }),
    postMessage: vi.fn((msg: { correlationId: string }) => {
      for (const cb of handlers['message'] ?? []) {
        cb({
          correlationId: msg.correlationId,
          preview: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
        })
      }
    }),
    kill: vi.fn(),
    stderr: { on: vi.fn() }
  }
}

function makeControlledWorker(
  onStart: (complete: () => void) => void
): MockWorker {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {}
  return {
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      ;(handlers[event] ??= []).push(cb)
    }),
    postMessage: vi.fn((msg: { correlationId: string }) => {
      onStart(() => {
        for (const cb of handlers['message'] ?? []) {
          cb({
            correlationId: msg.correlationId,
            preview: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
          })
        }
      })
    }),
    kill: vi.fn(),
    stderr: { on: vi.fn() }
  }
}

let libraryFolder = ''
let service: ReturnType<typeof createPdfTextService>

beforeEach(() => {
  vi.clearAllMocks()
  libraryFolder = mkdtempSync(join(tmpdir(), 'refora-pdf-preview-'))
  mocks.fork.mockImplementation(makeWorker)
  service = createPdfTextService()
})

afterEach(() => {
  service.destroy()
  rmSync(libraryFolder, { recursive: true, force: true })
})

describe('PDF preview cache', () => {
  function document(filePath: string) {
    return {
      id: 'd1',
      filePath,
      fileName: 'doc.pdf',
      fileHash: null
    }
  }

  it('renders and caches a validated PDF preview', async () => {
    const pdfPath = join(libraryFolder, 'doc.pdf')
    writeFileSync(pdfPath, 'pdf')

    const preview = await service.getPreviewForDocument(document(pdfPath), libraryFolder)

    expect(preview).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]))
    const worker = mocks.fork.mock.results[0].value as MockWorker
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      filePath: pdfPath,
      action: 'preview'
    }))
    const sourceStats = statSync(pdfPath)
    expect(existsSync(pdfPreviewCachePath(
      libraryFolder,
      'd1',
      `unhashed:${sourceStats.size}:${sourceStats.mtimeMs}`
    ))).toBe(true)
  })

  it('reuses a valid cached preview', async () => {
    const pdfPath = join(libraryFolder, 'doc.pdf')
    writeFileSync(pdfPath, 'pdf')

    await service.getPreviewForDocument(document(pdfPath), libraryFolder)
    await service.getPreviewForDocument(document(pdfPath), libraryFolder)

    expect(mocks.fork).toHaveBeenCalledTimes(1)
    const worker = mocks.fork.mock.results[0].value as MockWorker
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
  })

  it('regenerates the preview after the PDF changes', async () => {
    const pdfPath = join(libraryFolder, 'doc.pdf')
    writeFileSync(pdfPath, 'pdf')

    await service.getPreviewForDocument(document(pdfPath), libraryFolder)
    const firstStats = statSync(pdfPath)
    const firstCache = pdfPreviewCachePath(
      libraryFolder,
      'd1',
      `unhashed:${firstStats.size}:${firstStats.mtimeMs}`
    )
    writeFileSync(pdfPath, 'updated-pdf')
    await service.getPreviewForDocument(document(pdfPath), libraryFolder)
    const secondStats = statSync(pdfPath)
    const secondCache = pdfPreviewCachePath(
      libraryFolder,
      'd1',
      `unhashed:${secondStats.size}:${secondStats.mtimeMs}`
    )

    const worker = mocks.fork.mock.results[0].value as MockWorker
    expect(worker.postMessage).toHaveBeenCalledTimes(2)
    expect(existsSync(firstCache)).toBe(false)
    expect(existsSync(secondCache)).toBe(true)
  })

  it('regenerates an oversized cache entry without reading it into memory', async () => {
    const pdfPath = join(libraryFolder, 'oversized.pdf')
    writeFileSync(pdfPath, 'pdf')
    const sourceStats = statSync(pdfPath)
    const cachePath = pdfPreviewCachePath(
      libraryFolder,
      'd1',
      `unhashed:${sourceStats.size}:${sourceStats.mtimeMs}`
    )
    const oversized = Buffer.alloc(MAX_PDF_PREVIEW_CACHE_BYTES + 1)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized)
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, oversized)

    await service.getPreviewForDocument(document(pdfPath), libraryFolder)

    const worker = mocks.fork.mock.results[0].value as MockWorker
    expect(worker.postMessage).toHaveBeenCalledOnce()
    expect(statSync(cachePath).size).toBeLessThan(MAX_PDF_PREVIEW_CACHE_BYTES)
  })

  it('removes every preview version when a document is deleted', async () => {
    const pdfPath = join(libraryFolder, 'deleted.pdf')
    writeFileSync(pdfPath, 'pdf')
    await service.getPreviewForDocument(document(pdfPath), libraryFolder)
    const sourceStats = statSync(pdfPath)
    const cachePath = pdfPreviewCachePath(
      libraryFolder,
      'd1',
      `unhashed:${sourceStats.size}:${sourceStats.mtimeMs}`
    )

    await service.removePreviewCacheForDocument('d1', libraryFolder)

    expect(existsSync(cachePath)).toBe(false)
  })

  it('does not recreate a deleted document cache after an in-flight preview completes', async () => {
    service.destroy()
    let completePreview: (() => void) | null = null
    mocks.fork.mockImplementation(() => makeControlledWorker((complete) => {
      completePreview = complete
    }))
    service = createPdfTextService()
    const pdfPath = join(libraryFolder, 'in-flight.pdf')
    writeFileSync(pdfPath, 'pdf')
    const sourceStats = statSync(pdfPath)
    const cachePath = pdfPreviewCachePath(
      libraryFolder,
      'd1',
      `unhashed:${sourceStats.size}:${sourceStats.mtimeMs}`
    )
    const preview = service.getPreviewForDocument(document(pdfPath), libraryFolder)
    await vi.waitFor(() => expect(completePreview).not.toBeNull())

    await service.removePreviewCacheForDocument('d1', libraryFolder)
    const finishPreview = completePreview as (() => void) | null
    finishPreview?.()
    await expect(preview).resolves.toBeInstanceOf(Uint8Array)

    expect(existsSync(cachePath)).toBe(false)
    await expect(service.getPreviewForDocument(document(pdfPath), libraryFolder))
      .rejects.toMatchObject({ code: 'preview_unavailable' })
  })

  it('runs at most three previews concurrently with one request per worker', async () => {
    service.destroy()
    let active = 0
    let maximumActive = 0
    let started = 0
    const completions: Array<() => void> = []
    mocks.fork.mockImplementation(() => makeControlledWorker((complete) => {
      started += 1
      active += 1
      maximumActive = Math.max(maximumActive, active)
      completions.push(() => {
        active -= 1
        complete()
      })
    }))
    service = createPdfTextService()
    const requests = Array.from({ length: 5 }, (_, index) => {
      const pdfPath = join(libraryFolder, `doc-${index}.pdf`)
      writeFileSync(pdfPath, `pdf-${index}`)
      return service.getPreviewForDocument({
        id: `d${index}`,
        filePath: pdfPath,
        fileName: `doc-${index}.pdf`,
        fileHash: null
      }, libraryFolder)
    })

    await vi.waitFor(() => expect(started).toBe(3))
    expect(mocks.fork).toHaveBeenCalledTimes(3)
    expect(maximumActive).toBe(3)
    completions.shift()?.()
    await vi.waitFor(() => expect(started).toBe(4))
    completions.shift()?.()
    await vi.waitFor(() => expect(started).toBe(5))
    while (completions.length > 0) completions.shift()?.()

    await expect(Promise.all(requests)).resolves.toHaveLength(5)
    expect(maximumActive).toBe(3)
    for (const result of mocks.fork.mock.results) {
      expect((result.value as MockWorker).postMessage).toHaveBeenCalledTimes(
        result === mocks.fork.mock.results[0] || result === mocks.fork.mock.results[1] ? 2 : 1
      )
    }
  })

  it('kills a worker whose preview request times out', async () => {
    service.destroy()
    vi.useFakeTimers()
    mocks.fork.mockImplementation(() => makeControlledWorker(() => undefined))
    service = createPdfTextService({ workerTimeoutMs: 50 })
    const pdfPath = join(libraryFolder, 'timeout.pdf')
    writeFileSync(pdfPath, 'pdf')
    const preview = service.getPreviewForDocument({
      id: 'timeout',
      filePath: pdfPath,
      fileName: 'timeout.pdf',
      fileHash: null
    }, libraryFolder)
    const rejection = expect(preview).rejects.toThrow(/timed out/)

    await vi.advanceTimersByTimeAsync(51)
    await rejection

    const worker = mocks.fork.mock.results[0].value as MockWorker
    expect(worker.kill).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('fails the timed-out slot immediately and isolates its stale exit from the replacement worker', async () => {
    service.destroy()
    vi.useFakeTimers()
    try {
      const emitExit: Array<((code: number | null) => void) | undefined> = []
      const workers: MockWorker[] = []
      let autoRespondFrom = Number.POSITIVE_INFINITY
      mocks.fork.mockImplementation(() => {
        const index = workers.length
        const handlers: Record<string, Array<(arg: unknown) => void>> = {}
        const worker: MockWorker = {
          on: vi.fn((event: string, cb: (arg: unknown) => void) => {
            ;(handlers[event] ??= []).push(cb)
          }),
          postMessage: vi.fn((msg: { correlationId: string }) => {
            if (index >= autoRespondFrom) {
              for (const cb of handlers['message'] ?? []) {
                cb({ correlationId: msg.correlationId, preview: new Uint8Array([137]) })
              }
            }
          }),
          kill: vi.fn(),
          stderr: { on: vi.fn() }
        }
        emitExit[index] = (code) => {
          for (const cb of handlers['exit'] ?? []) cb(code)
        }
        workers.push(worker)
        return worker
      })
      service = createPdfTextService({ workerTimeoutMs: 50 })
      const paths = [0, 1, 2, 3].map((index) => join(libraryFolder, `gen-${index}.pdf`))
      for (const path of paths) writeFileSync(path, 'pdf')
      const preview = (id: string, index: number) => service.getPreviewForDocument({
        id,
        filePath: paths[index],
        fileName: `gen-${index}.pdf`,
        fileHash: null
      }, libraryFolder)

      const first = preview('g1', 0)
      const firstDone = expect(first).rejects.toThrow(/timed out/)
      let firstFailed = false
      void first.catch(() => {
        firstFailed = true
      })
      for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(1)
      expect(workers).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(2)
      const second = preview('g2', 1)
      const secondDone = expect(second).rejects.toThrow(/timed out/)
      const third = preview('g3', 2)
      const thirdDone = expect(third).rejects.toThrow(/timed out/)
      for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(1)
      expect(workers).toHaveLength(3)
      expect(workers.map((worker) => worker.postMessage.mock.calls.length)).toEqual([1, 1, 1])

      let guard = 0
      while (!firstFailed && guard < 90) {
        guard += 1
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(firstFailed).toBe(true)
      await firstDone
      expect(workers[0].kill).toHaveBeenCalledTimes(1)
      expect(workers[1].kill).not.toHaveBeenCalled()
      expect(workers[2].kill).not.toHaveBeenCalled()

      emitExit[0]?.(1)

      autoRespondFrom = 3
      const fourth = preview('g4', 0)
      for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(1)
      await expect(fourth).resolves.toBeInstanceOf(Uint8Array)
      expect(mocks.fork).toHaveBeenCalledTimes(4)
      expect(workers[3].postMessage).toHaveBeenCalledTimes(1)
      expect(workers[0].kill).toHaveBeenCalledTimes(1)

      for (let i = 0; i < 90; i += 1) await vi.advanceTimersByTimeAsync(1)
      await secondDone
      await thirdDone
      expect(workers[1].kill).toHaveBeenCalledTimes(1)
      expect(workers[2].kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
