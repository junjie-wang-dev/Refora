import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPdfTextService } from '../../src/main/services/pdfText'
import { pdfPreviewCachePath } from '../../src/main/services/pdfPreviewCache'

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
    writeFileSync(pdfPath, 'updated-pdf')
    await service.getPreviewForDocument(document(pdfPath), libraryFolder)

    const worker = mocks.fork.mock.results[0].value as MockWorker
    expect(worker.postMessage).toHaveBeenCalledTimes(2)
  })
})
