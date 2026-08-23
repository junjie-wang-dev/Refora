import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import DetailPanel from '../../src/renderer/components/DetailPanel'
import type { Document, Category, ReforaApi } from '../../src/shared/ipc-types'
import type { MineruEngineStatus, OcrDocumentState } from '../../src/shared/mineru-types'
import { flushRendererPersistence } from '../../src/renderer/persistence'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))

const mockCat: Category = { id: 'c1', name: 'ML', sortOrder: 0, createdAt: 0 }

const mockDoc: Document = {
  id: '1',
  filePath: '/pdfs/test.pdf',
  originalFolderPath: '/pdfs',
  fileName: 'test.pdf',
  fileSize: 1024,
  fileHash: 'abc',
  title: 'Test Paper',
  authors: 'Smith, J.',
  year: '2024',
  venue: 'Nature',
  volume: '10',
  issue: '3',
  pages: '100--120',
  abstract: 'An important study.',
  keywords: 'ML, AI',
  url: 'https://example.com',
  doi: '10.1234/test',
  arxivId: '2401.12345',
  note: 'Good read',
  affiliations: 'MIT; Stanford University',
  starred: 1,
  addedAt: 1700000000000,
  lastReadAt: null,
  updatedAt: 1700000000000,
  metadataSource: null,
  metadataStatus: 'done',
  metadataAttempts: 0,
  editedFields: [],
  remoteValues: {},
  fileMissing: 0,
  categories: [mockCat]
}

const notInstalledEngine: MineruEngineStatus = {
  state: 'notInstalled',
  installRoot: '/models',
  installPath: null,
  version: null,
  architecture: 'arm64',
  pythonPath: null,
  modelConfigPath: null,
  installedAt: null,
  diskBytes: null,
  error: null,
  progress: null
}

const installedEngine: MineruEngineStatus = {
  ...notInstalledEngine,
  state: 'installed',
  installPath: '/models/Refora/MinerU/3.4.4/darwin-arm64',
  version: '3.4.4',
  pythonPath: '/models/python',
  modelConfigPath: '/models/mineru.json',
  installedAt: 1
}

const api = (window as unknown as { api: ReforaApi }).api

const mockStoreState = vi.hoisted(() => ({
  focusedDocId: null as string | null,
  documents: [] as Document[],
  searchResults: [] as Document[],
  isSearching: false,
  selectedIds: [] as string[],
  categories: [] as Category[],
  updateDocument: vi.fn().mockResolvedValue(undefined),
  fetchCategories: vi.fn().mockResolvedValue(undefined),
  bulkRefreshMetadata: vi.fn().mockResolvedValue(undefined),
  bulkCategorize: vi.fn().mockResolvedValue(undefined),
  deleteDoc: vi.fn().mockResolvedValue(undefined),
  openInFinder: vi.fn().mockResolvedValue(undefined),
  refreshMetadata: vi.fn().mockResolvedValue(undefined),
  requestDeleteConfirm: vi.fn(),
  showToast: vi.fn(),
  patchDocument: vi.fn(),
  flushPendingSettings: vi.fn().mockResolvedValue(undefined),
  toastMessage: null as string | null
}))

vi.mock('../../src/renderer/store/documentStore', () => ({
  useDocumentStore: Object.assign(
    (selector?: (s: typeof mockStoreState) => unknown) => {
      if (typeof selector === 'function') {
        return selector(mockStoreState)
      }
      return mockStoreState
    },
    { getState: () => mockStoreState }
  )
}))

function resetStore(): void {
  mockStoreState.focusedDocId = null
  mockStoreState.documents = []
  mockStoreState.searchResults = []
  mockStoreState.isSearching = false
  mockStoreState.selectedIds = []
  mockStoreState.categories = []
  mockStoreState.toastMessage = null
  mockStoreState.updateDocument.mockReset().mockResolvedValue(undefined)
  mockStoreState.fetchCategories.mockReset().mockResolvedValue(undefined)
  mockStoreState.bulkRefreshMetadata.mockReset().mockResolvedValue(undefined)
  mockStoreState.bulkCategorize.mockReset().mockResolvedValue(undefined)
  mockStoreState.requestDeleteConfirm.mockReset()
  mockStoreState.showToast.mockReset()
  mockStoreState.patchDocument.mockReset()
  mockStoreState.flushPendingSettings.mockReset().mockResolvedValue(undefined)
  mockStoreState.openInFinder.mockReset()
  mockStoreState.refreshMetadata.mockReset()
}

let mockUpdateDoc: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockUpdateDoc = vi.fn().mockResolvedValue(mockDoc)
  const winApi = (window as Record<string, unknown>).api as Record<string, unknown>
  if (winApi) {
    const docs = winApi.documents as Record<string, unknown>
    docs.update = mockUpdateDoc
    docs.relocateFile = vi.fn().mockResolvedValue(mockDoc)
    docs.restoreFile = vi.fn().mockResolvedValue(mockDoc)
    const cats = winApi.categories as Record<string, unknown>
    cats.assign = vi.fn().mockResolvedValue(undefined)
    cats.unassign = vi.fn().mockResolvedValue(undefined)
  }
  api.ocr.getState = vi.fn().mockResolvedValue({
    engine: notInstalledEngine,
    activeJob: null,
    result: null
  } satisfies OcrDocumentState)
  api.events.onMineruInstallProgress = vi.fn()
  resetStore()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DetailPanel', () => {
  it('reports a failed bulk BibTeX export', async () => {
    mockStoreState.selectedIds = ['doc-1', 'doc-2']
    vi.spyOn(api.export, 'toBibtex').mockRejectedValue(new Error('export unavailable'))
    render(<DetailPanel />)

    fireEvent.click(screen.getByRole('button', { name: /common.exportBibtexTitle/ }))

    await waitFor(() => {
      expect(mockStoreState.showToast).toHaveBeenCalledWith('export unavailable')
    })
  })

  describe('no selection — empty state', () => {
    it('shows placeholder when focusedDocId is null', () => {
      mockStoreState.focusedDocId = null
      render(<DetailPanel />)
      expect(screen.getByText('common.selectDocHint')).toBeInTheDocument()
    })

    it('renders no InlineFields when no doc selected', () => {
      mockStoreState.focusedDocId = null
      render(<DetailPanel />)
      expect(screen.queryByText('detail.title')).not.toBeInTheDocument()
      expect(screen.queryByText('detail.authors')).not.toBeInTheDocument()
    })
  })

  describe('selected doc — fields rendered', () => {
    beforeEach(() => {
      mockStoreState.focusedDocId = '1'
      mockStoreState.documents = [mockDoc]
      mockStoreState.categories = [{ ...mockCat, count: 5 }]
    })

    it('renders all document fields', () => {
      render(<DetailPanel />)
      expect(screen.getByRole('button', { name: 'Test Paper' })).toBeInTheDocument()
      expect(screen.getByText('J. Smith')).toBeInTheDocument()
      expect(screen.getByText('2024')).toBeInTheDocument()
      expect(screen.getByText('Nature')).toBeInTheDocument()
      expect(screen.getByText('10')).toBeInTheDocument()
      expect(screen.getByText('An important study.')).toBeInTheDocument()
      expect(screen.getByText('ML, AI')).toBeInTheDocument()
      expect(screen.getByText('https://example.com')).toBeInTheDocument()
      expect(screen.getByText('10.1234/test')).toBeInTheDocument()
      expect(screen.getByText('2401.12345')).toBeInTheDocument()
      expect(screen.getByText('Good read')).toBeInTheDocument()
    })

    it('renders category chips', () => {
      render(<DetailPanel />)
      expect(screen.getByText('ML')).toBeInTheDocument()
    })

    it('keeps an existing OCR result available without the MinerU runtime', async () => {
      api.ocr.getState = vi.fn().mockResolvedValue({
        engine: notInstalledEngine,
        activeJob: null,
        result: {
          id: 'result-1',
          documentId: '1',
          resultKey: 'key-1',
          sourceHash: 'abc',
          mineruVersion: '3.4.4',
          modelRevision: 'models-1',
          profile: 'balanced',
          optionsHash: 'options-1',
          schemaVersion: 1,
          relativeRoot: '.refora/derived/OCR/1/key-1',
          markdownRelativePath: '.refora/derived/OCR/1/key-1/document.md',
          blocksRelativePath: '.refora/derived/OCR/1/key-1/blocks.jsonl',
          manifestRelativePath: '.refora/derived/OCR/1/key-1/manifest.json',
          createdAt: 1,
          stale: false
        }
      } satisfies OcrDocumentState)

      render(<DetailPanel />)

      expect(await screen.findByText('ocr.open')).toBeInTheDocument()
      expect(screen.getByText('ocr.engineRequired')).toBeInTheDocument()
    })

    it('refreshes OCR state when MinerU installation completes', async () => {
      let installProgress: ((payload: {
        installId: string
        startedAt: number
        stage: 'completed'
        currentArtifact: null
        bytesReceived: number
        bytesTotal: null
        percent: number
        cancellable: boolean
        message: string
      }) => void) | null = null
      api.events.onMineruInstallProgress = vi.fn((callback) => {
        installProgress = callback
      })
      api.ocr.getState = vi.fn()
        .mockResolvedValueOnce({ engine: notInstalledEngine, activeJob: null, result: null })
        .mockResolvedValueOnce({ engine: installedEngine, activeJob: null, result: null })

      render(<DetailPanel />)
      expect(await screen.findByText('ocr.engineRequired')).toBeInTheDocument()

      act(() => {
        installProgress?.({
          installId: 'install-1',
          startedAt: Date.now(),
          stage: 'completed',
          currentArtifact: null,
          bytesReceived: 0,
          bytesTotal: null,
          percent: 100,
          cancellable: false,
          message: 'ready'
        })
      })

      expect(await screen.findByText('ocr.convert')).toBeInTheDocument()
      expect(api.ocr.getState).toHaveBeenCalledTimes(2)
    }, 15_000)

    it('ignores an earlier document OCR refresh after the selection changes', async () => {
      const secondDoc = {
        ...mockDoc,
        id: '2',
        filePath: '/pdfs/second.pdf',
        fileName: 'second.pdf',
        title: 'Second Paper',
        fileHash: 'def'
      }
      let resolveFirst: (state: OcrDocumentState) => void = () => undefined
      let resolveSecond: (state: OcrDocumentState) => void = () => undefined
      const firstState = new Promise<OcrDocumentState>((resolvePromise) => {
        resolveFirst = resolvePromise
      })
      const secondState = new Promise<OcrDocumentState>((resolvePromise) => {
        resolveSecond = resolvePromise
      })
      api.ocr.getState = vi.fn((documentId: string) =>
        documentId === '1' ? firstState : secondState)

      const { rerender } = render(<DetailPanel />)
      await waitFor(() => expect(api.ocr.getState).toHaveBeenCalledWith('1'))

      mockStoreState.focusedDocId = '2'
      mockStoreState.documents = [mockDoc, secondDoc]
      rerender(<DetailPanel />)
      await waitFor(() => expect(api.ocr.getState).toHaveBeenCalledWith('2'))

      await act(async () => {
        resolveSecond({ engine: installedEngine, activeJob: null, result: null })
        await secondState
      })
      expect(await screen.findByText('ocr.convert')).toBeInTheDocument()

      await act(async () => {
        resolveFirst({
          engine: installedEngine,
          activeJob: null,
          result: {
            id: 'result-1',
            documentId: '1',
            resultKey: 'key-1',
            sourceHash: 'abc',
            mineruVersion: '3.4.4',
            modelRevision: 'models-1',
            profile: 'balanced',
            optionsHash: 'options-1',
            schemaVersion: 1,
            relativeRoot: '.refora/derived/OCR/1/key-1',
            markdownRelativePath: '.refora/derived/OCR/1/key-1/document.md',
            blocksRelativePath: '.refora/derived/OCR/1/key-1/blocks.jsonl',
            manifestRelativePath: '.refora/derived/OCR/1/key-1/manifest.json',
            createdAt: 1,
            stale: false
          }
        })
        await firstState
      })

      expect(screen.getByText('ocr.convert')).toBeInTheDocument()
      expect(screen.queryByText('ocr.open')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Second Paper' })).toBeInTheDocument()
    }, 30_000)

    it('shows active indeterminate progress instead of a frozen parsing percentage', async () => {
      api.ocr.getState = vi.fn().mockResolvedValue({
        engine: installedEngine,
        activeJob: {
          id: 'job-1',
          documentId: '1',
          resultKey: 'key-1',
          sourceHash: 'abc',
          profile: 'balanced',
          status: 'running',
          stage: 'parsing',
          progress: null,
          errorCode: null,
          errorMessage: null,
          createdAt: Date.now() - 5000,
          startedAt: Date.now() - 5000,
          finishedAt: null,
          updatedAt: Date.now()
        },
        result: null
      } satisfies OcrDocumentState)

      const { container } = render(<DetailPanel />)

      expect(await screen.findByText('ocr.stage.parsing')).toBeInTheDocument()
      expect(screen.getByText('ocr.stageDescription.parsing')).toBeInTheDocument()
      expect(screen.getByRole('progressbar', { name: 'ocr.progress' }))
        .not.toHaveAttribute('aria-valuenow')
      expect(container.querySelector('.mineru-progress-indeterminate')).toBeInTheDocument()
      expect(screen.getByText('ocr.elapsed')).toBeInTheDocument()
      expect(screen.queryByText('12%')).not.toBeInTheDocument()
    })

    it('renders semicolon-separated authors as individual chips', () => {
      mockStoreState.documents = [{
        ...mockDoc,
        authors: 'Pu, Yewen; Narasimhan, Karthik; Solar-Lezama, Armando'
      }]

      render(<DetailPanel />)

      expect(screen.getByText('Yewen Pu')).toBeInTheDocument()
      expect(screen.getByText('Karthik Narasimhan')).toBeInTheDocument()
      expect(screen.getByText('Armando Solar-Lezama')).toBeInTheDocument()
    })

    it('places the close action in the document header', () => {
      const onClose = vi.fn()
      render(<DetailPanel onClose={onClose} />)

      fireEvent.click(screen.getByRole('button', { name: 'common.close' }))

      expect(onClose).toHaveBeenCalledTimes(1)
      expect(screen.getAllByText('Test Paper')).toHaveLength(1)
    })

    it('does not clamp long abstracts', () => {
      const longAbstract = 'Long abstract '.repeat(80).trim()
      mockStoreState.documents = [{ ...mockDoc, abstract: longAbstract }]

      render(<DetailPanel />)

      expect(screen.getByRole('button', { name: longAbstract })).not.toHaveClass('line-clamp-[7]')
    })
  })

  describe('inline edit — blur saves', () => {
    beforeEach(() => {
      mockStoreState.focusedDocId = '1'
      mockStoreState.documents = [mockDoc]
      mockStoreState.categories = [{ ...mockCat, count: 5 }]
    })

    it('enters edit mode on click and saves on blur', async () => {
      mockUpdateDoc.mockResolvedValue({ ...mockDoc, title: 'New Title' })
      render(<DetailPanel />)

      const titleDisplay = screen.getByRole('button', { name: 'Test Paper' })
      await act(async () => {
        fireEvent.click(titleDisplay)
      })

      const input = screen.getByDisplayValue('Test Paper') as HTMLTextAreaElement
      expect(input.tagName).toBe('TEXTAREA')

      await act(async () => {
        fireEvent.change(input, { target: { value: 'New Title' } })
      })

      await act(async () => {
        fireEvent.blur(input)
      })

      expect(mockUpdateDoc).toHaveBeenCalledWith('1', { title: 'New Title' })
    })

    it('shows saved indicator after save', async () => {
      mockUpdateDoc.mockResolvedValue({ ...mockDoc, title: 'New Title' })
      render(<DetailPanel />)

      const titleDisplay = screen.getByRole('button', { name: 'Test Paper' })
      fireEvent.click(titleDisplay)

      const input = screen.getByDisplayValue('Test Paper') as HTMLTextAreaElement
      fireEvent.change(input, { target: { value: 'New Title' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(screen.getByText('common.saved')).toBeInTheDocument()
      })
    })

    it('shows the backend verification error when an arXiv ID is rejected', async () => {
      mockUpdateDoc.mockRejectedValue(new Error('The arXiv record does not match this paper metadata'))
      render(<DetailPanel />)

      fireEvent.click(screen.getByRole('button', { name: '2401.12345' }))
      const input = screen.getByDisplayValue('2401.12345') as HTMLTextAreaElement
      fireEvent.change(input, { target: { value: '2401.99999' } })
      fireEvent.blur(input)

      expect(await screen.findByText('The arXiv record does not match this paper metadata')).toBeInTheDocument()
      expect(mockUpdateDoc).toHaveBeenCalledWith('1', { arxivId: '2401.99999' })
    })
  })

  describe('inline edit — Escape cancels', () => {
    beforeEach(() => {
      mockStoreState.focusedDocId = '1'
      mockStoreState.documents = [mockDoc]
      mockStoreState.categories = [{ ...mockCat, count: 5 }]
    })

    it('restores original value on Escape and does not call API', async () => {
      render(<DetailPanel />)

      const titleDisplay = screen.getByRole('button', { name: 'Test Paper' })
      await act(async () => {
        fireEvent.click(titleDisplay)
      })

      const input = screen.getByDisplayValue('Test Paper') as HTMLTextAreaElement
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Changed Value' } })
        fireEvent.keyDown(input, { key: 'Escape' })
      })

      expect(screen.getByRole('button', { name: 'Test Paper' })).toBeInTheDocument()
      expect(screen.queryByDisplayValue('Changed Value')).not.toBeInTheDocument()
      expect(mockUpdateDoc).not.toHaveBeenCalled()
    })
  })

  describe('inline edit — Enter saves', () => {
    beforeEach(() => {
      mockStoreState.focusedDocId = '1'
      mockStoreState.documents = [mockDoc]
      mockStoreState.categories = [{ ...mockCat, count: 5 }]
    })

    it('saves via API on Enter key', async () => {
      mockUpdateDoc.mockResolvedValue({ ...mockDoc, title: 'Enter Saved' })
      render(<DetailPanel />)

      const titleDisplay = screen.getByRole('button', { name: 'Test Paper' })
      await act(async () => {
        fireEvent.click(titleDisplay)
      })

      const input = screen.getByDisplayValue('Test Paper') as HTMLTextAreaElement
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Enter Saved' } })
        fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
      })

      expect(mockUpdateDoc).toHaveBeenCalledWith('1', { title: 'Enter Saved' })
    })

    it('prevents additional edits while an Enter save is in flight', async () => {
      let resolveSave!: (doc: Document) => void
      mockUpdateDoc.mockReturnValue(new Promise((resolve) => { resolveSave = resolve }))
      render(<DetailPanel />)
      fireEvent.click(screen.getByRole('button', { name: 'Test Paper' }))
      const input = screen.getByDisplayValue('Test Paper') as HTMLTextAreaElement
      fireEvent.change(input, { target: { value: 'Submitted title' } })

      fireEvent.keyDown(input, { key: 'Enter', metaKey: true })

      expect(input).toBeDisabled()
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1)
      await act(async () => {
        resolveSave({ ...mockDoc, title: 'Submitted title' })
        await Promise.resolve()
      })
      expect(input).not.toBeInTheDocument()
    })
  })

  describe('NoteField autosave', () => {
    beforeEach(() => {
      mockStoreState.focusedDocId = '1'
      mockStoreState.documents = [mockDoc]
      mockStoreState.categories = [{ ...mockCat, count: 5 }]
    })

    it('saves on blur after typing', async () => {
      mockUpdateDoc.mockResolvedValue({ ...mockDoc, note: 'Updated note' })
      render(<DetailPanel />)

      const textarea = screen.getByDisplayValue('Good read') as HTMLTextAreaElement

      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'Updated note' } })
        fireEvent.blur(textarea)
      })

      expect(mockUpdateDoc).toHaveBeenCalledWith('1', { note: 'Updated note' })
    })

    it('debounces by clearing pending timeout on blur', async () => {
      vi.useFakeTimers()
      mockUpdateDoc.mockResolvedValue({ ...mockDoc, note: 'Saved' })
      render(<DetailPanel />)

      const textarea = screen.getByDisplayValue('Good read') as HTMLTextAreaElement

      await act(async () => {
        fireEvent.change(textarea, { target: { value: 'Saved' } })
      })

      await act(async () => {
        fireEvent.blur(textarea)
      })

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1)
      expect(mockUpdateDoc).toHaveBeenCalledWith('1', { note: 'Saved' })

      vi.useRealTimers()
    })

    it('autosaves the latest note value after the debounce without blur', async () => {
      vi.useFakeTimers()
      mockUpdateDoc.mockResolvedValue({ ...mockDoc, note: 'Latest note' })
      render(<DetailPanel />)

      const textarea = screen.getByDisplayValue('Good read') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Latest note' } })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })

      expect(mockUpdateDoc).toHaveBeenCalledWith('1', { note: 'Latest note' })
      vi.useRealTimers()
    })

    it('keeps a failed note draft visible and retries it', async () => {
      mockUpdateDoc
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValueOnce({ ...mockDoc, note: 'Unsaved draft' })
      render(<DetailPanel />)

      const textarea = screen.getByDisplayValue('Good read') as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Unsaved draft' } })
      fireEvent.blur(textarea)

      expect(await screen.findByText('detail.saveFailed')).toBeInTheDocument()
      expect(textarea).toHaveValue('Unsaved draft')

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'pdfReader.retrySave' }))
      })

      expect(mockUpdateDoc).toHaveBeenCalledTimes(2)
      expect(textarea).toHaveValue('Unsaved draft')
      expect(await screen.findByText('common.saved')).toBeInTheDocument()
    })

    it('waits for a pending note from the previous document during a renderer flush', async () => {
      let release: (document: Document) => void = () => undefined
      mockUpdateDoc.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
      const secondDocument = { ...mockDoc, id: '2', note: 'Second note' }
      const { rerender } = render(<DetailPanel />)

      fireEvent.change(screen.getByDisplayValue('Good read'), {
        target: { value: 'Draft for first document' }
      })
      mockStoreState.focusedDocId = '2'
      mockStoreState.documents = [mockDoc, secondDocument]
      rerender(<DetailPanel />)
      await Promise.resolve()

      expect(mockUpdateDoc).toHaveBeenCalledWith('1', { note: 'Draft for first document' })
      let flushed = false
      const flush = flushRendererPersistence().then(() => { flushed = true })
      await Promise.resolve()
      expect(flushed).toBe(false)

      release({ ...mockDoc, note: 'Draft for first document' })
      await flush
      expect(flushed).toBe(true)
    })
  })

  describe('refresh metadata result', () => {
    beforeEach(() => {
      mockStoreState.focusedDocId = '1'
      mockStoreState.documents = [{ ...mockDoc, metadataStatus: 'pending' }]
      mockStoreState.categories = [{ ...mockCat, count: 5 }]
    })

    it('shows failed indicator when metadata status becomes failed', async () => {
      mockStoreState.refreshMetadata.mockResolvedValue(true)
      const { rerender } = render(<DetailPanel />)

      const refreshBtn = screen.getByText('detail.refreshMetadata')
      await act(async () => {
        fireEvent.click(refreshBtn)
      })

      mockStoreState.documents = [{ ...mockDoc, metadataStatus: 'failed' }]
      rerender(<DetailPanel />)

      expect(screen.getByText('detail.refreshFailed')).toBeInTheDocument()
    })

    it('shows success indicator when metadata status becomes done', async () => {
      mockStoreState.refreshMetadata.mockResolvedValue(true)
      const { rerender } = render(<DetailPanel />)

      const refreshBtn = screen.getByText('detail.refreshMetadata')
      await act(async () => {
        fireEvent.click(refreshBtn)
      })

      mockStoreState.documents = [{ ...mockDoc, metadataStatus: 'done' }]
      rerender(<DetailPanel />)

      expect(screen.getByText('detail.refreshSuccess')).toBeInTheDocument()
    })

    it('keeps the refresh icon spinning until refreshed metadata is rendered', async () => {
      mockStoreState.documents = [{ ...mockDoc, metadataStatus: 'done' }]
      mockStoreState.refreshMetadata.mockResolvedValue(true)
      const { rerender } = render(<DetailPanel />)

      const refreshBtn = screen.getByRole('button', { name: 'detail.refreshMetadata' })
      await act(async () => {
        fireEvent.click(refreshBtn)
      })

      expect(refreshBtn.querySelector('svg')).toHaveClass('animate-spin')
      expect(screen.getByText('detail.refreshMetadata')).toBeInTheDocument()
      expect(screen.queryByText('detail.refreshing')).not.toBeInTheDocument()
      expect(screen.queryByText('detail.refreshSuccess')).not.toBeInTheDocument()

      mockStoreState.documents = [{ ...mockDoc, metadataStatus: 'pending', updatedAt: mockDoc.updatedAt + 1 }]
      rerender(<DetailPanel />)

      expect(refreshBtn.querySelector('svg')).toHaveClass('animate-spin')
      expect(screen.queryByText('detail.refreshSuccess')).not.toBeInTheDocument()

      mockStoreState.documents = [{
        ...mockDoc,
        title: 'Refreshed Paper',
        metadataStatus: 'done',
        updatedAt: mockDoc.updatedAt + 2
      }]
      rerender(<DetailPanel />)

      expect(screen.getByRole('button', { name: 'Refreshed Paper' })).toBeInTheDocument()
      expect(screen.getByText('detail.refreshMetadata')).toBeInTheDocument()
      expect(screen.getByText('detail.refreshSuccess')).toBeInTheDocument()
      expect(refreshBtn.querySelector('svg')).not.toHaveClass('animate-spin')
    })
  })

  describe('empty fields shown as placeholder', () => {
    it('displays em-dash for null abstract and allows click to edit', async () => {
      const docWithNull = { ...mockDoc, abstract: null }
      mockStoreState.focusedDocId = '1'
      mockStoreState.documents = [docWithNull]
      mockStoreState.categories = [{ ...mockCat, count: 5 }]

      render(<DetailPanel />)

      const placeholder = screen.getAllByText('\u2014').find((element) =>
        element.className.includes('text-justify')
      )
      expect(placeholder).toBeDefined()
      expect(placeholder).toBeInTheDocument()

      await act(async () => {
        fireEvent.click(placeholder as HTMLElement)
      })

      const input = screen.getByDisplayValue('') as HTMLTextAreaElement
      expect(input).toBeInTheDocument()
    })
  })
})

export {}
