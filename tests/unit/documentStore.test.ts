import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useDocumentStore } from '../../src/renderer/store/documentStore'
import { useConfirmStore } from '../../src/renderer/store/confirmStore'
import { initI18n } from '../../src/renderer/i18n'
import type { Category, Document, ListColumnState } from '../../src/shared/ipc-types'

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    filePath: '/tmp/test.pdf',
    originalFolderPath: '/tmp',
    fileName: 'test.pdf',
    fileSize: 1024,
    fileHash: 'abc',
    title: 'Test Title',
    authors: 'Author',
    affiliations: null,
    year: '2024',
    venue: 'Test Venue',
    volume: null,
    issue: null,
    pages: null,
    abstract: null,
    keywords: null,
    url: null,
    doi: null,
    arxivId: null,
    note: null,
    starred: 0,
    addedAt: 1700000000000,
    lastReadAt: null,
    updatedAt: 1700000000000,
    metadataSource: null,
    metadataStatus: 'pending',
    metadataAttempts: 0,
    editedFields: [],
    remoteValues: null,
    fileMissing: 0,
    ...overrides
  }
}

const mockList = vi.fn()
const mockCounts = vi.fn()
const mockSetStarred = vi.fn()
const mockSettingsSet = vi.fn()
const mockGetBootstrap = vi.fn()
const mockOpenPdf = vi.fn()
const mockOpenInFinder = vi.fn()
const mockDelete = vi.fn()
const mockBulkDelete = vi.fn()
const mockRefreshMetadata = vi.fn()
const mockBulkRefreshMetadata = vi.fn()
const mockBulkCategorize = vi.fn()
const mockUpdate = vi.fn()
const mockImportFromZotero = vi.fn()
const mockImportFromMendeley = vi.fn()
const mockFromIdentifier = vi.fn()
const mockExportBibtex = vi.fn()
const mockCategoriesList = vi.fn()
const mockCategoriesCreate = vi.fn()
const mockCategoriesRename = vi.fn()
const mockCategoriesDelete = vi.fn()
const mockCategoriesAssign = vi.fn()
const mockCategoriesUnassign = vi.fn()
const mockOnDocUpdated = vi.fn()
const mockOnImportProgress = vi.fn()
const mockOnImportToast = vi.fn()
const mockOnMenuExportBibtex = vi.fn()
const mockOnMenuImportZotero = vi.fn()
const mockOnMenuImportMendeley = vi.fn()
const mockOnLibrarySwitched = vi.fn()
const mockOnLibraryContentsChanged = vi.fn()
const mockDisposeDocUpdated = vi.fn()
const mockDisposeImportProgress = vi.fn()
const mockDisposeImportToast = vi.fn()
const mockDisposeMenuExportBibtex = vi.fn()
const mockDisposeMenuImportZotero = vi.fn()
const mockDisposeMenuImportMendeley = vi.fn()
const mockDisposeLibrarySwitched = vi.fn()
const mockDisposeLibraryContentsChanged = vi.fn()

const defaultListColumnState: ListColumnState = {
  columns: [
    { id: 'title', visible: true, width: 300, order: 0 },
    { id: 'authors', visible: true, width: 192, order: 1 },
    { id: 'year', visible: true, width: 64, order: 2 },
    { id: 'venue', visible: true, width: 128, order: 3 },
    { id: 'addedAt', visible: true, width: 96, order: 4 },
    { id: 'filePath', visible: true, width: 192, order: 5 }
  ],
  sort: { field: 'addedAt', dir: 'desc' }
}

function resetStoreState(): void {
  useDocumentStore.setState({
    documents: [],
    documentCounts: { all: 0, recentlyRead: 0, recentlyAdded: 0, starred: 0 },
    selectedIds: [],
    focusedDocId: null,
    initialized: false,
    isSearching: false,
    searchQuery: '',
    searchResults: [],
    isLoading: false,
    isLoadingMoreDocuments: false,
    hasMoreDocuments: false,
    listMode: { mode: 'all' },
    listColumnState: defaultListColumnState,
    isImporting: false,
    importProgress: null,
    identifierImporting: 0,
    toastMessage: null,
    categories: []
  })
}

beforeEach(() => {
  useDocumentStore.getState().destroy()
  initI18n('en')
  mockList.mockReset()
  mockCounts.mockReset()
  mockSetStarred.mockReset()
  mockSettingsSet.mockReset()
  mockGetBootstrap.mockReset()
  mockOpenPdf.mockReset()
  mockOpenInFinder.mockReset()
  mockDelete.mockReset()
  mockBulkDelete.mockReset()
  mockRefreshMetadata.mockReset()
  mockBulkRefreshMetadata.mockReset()
  mockBulkCategorize.mockReset()
  mockUpdate.mockReset()
  mockImportFromZotero.mockReset()
  mockImportFromMendeley.mockReset()
  mockFromIdentifier.mockReset()
  mockExportBibtex.mockReset()
  mockCategoriesList.mockReset()
  mockCategoriesCreate.mockReset()
  mockCategoriesRename.mockReset()
  mockCategoriesDelete.mockReset()
  mockOnDocUpdated.mockReset()
  mockOnImportProgress.mockReset()
  mockOnImportToast.mockReset()
  mockOnMenuExportBibtex.mockReset()
  mockOnMenuImportZotero.mockReset()
  mockOnMenuImportMendeley.mockReset()
  mockOnLibrarySwitched.mockReset()
  mockOnLibraryContentsChanged.mockReset()
  mockDisposeDocUpdated.mockReset()
  mockDisposeImportProgress.mockReset()
  mockDisposeImportToast.mockReset()
  mockDisposeMenuExportBibtex.mockReset()
  mockDisposeMenuImportZotero.mockReset()
  mockDisposeMenuImportMendeley.mockReset()
  mockDisposeLibrarySwitched.mockReset()
  mockDisposeLibraryContentsChanged.mockReset()

  mockOnDocUpdated.mockReturnValue(mockDisposeDocUpdated)
  mockOnImportProgress.mockReturnValue(mockDisposeImportProgress)
  mockOnImportToast.mockReturnValue(mockDisposeImportToast)
  mockOnMenuExportBibtex.mockReturnValue(mockDisposeMenuExportBibtex)
  mockOnMenuImportZotero.mockReturnValue(mockDisposeMenuImportZotero)
  mockOnMenuImportMendeley.mockReturnValue(mockDisposeMenuImportMendeley)
  mockOnLibrarySwitched.mockReturnValue(mockDisposeLibrarySwitched)
  mockOnLibraryContentsChanged.mockReturnValue(mockDisposeLibraryContentsChanged)

  mockList.mockResolvedValue([])
  mockCounts.mockResolvedValue({ all: 0, recentlyRead: 0, recentlyAdded: 0, starred: 0 })
  mockSetStarred.mockResolvedValue(undefined)
  mockSettingsSet.mockResolvedValue(undefined)
  mockGetBootstrap.mockResolvedValue({
    language: 'en',
    theme: 'dark',
    windowBounds: null,
    listColumnState: null,
    sidebarCollapsed: false,
    firstRun: false,
    libraryFolderPath: '/fake/library'
  })
  mockOpenPdf.mockImplementation(async (id: string) => makeDoc({ id, lastReadAt: 1 }))
  mockOpenInFinder.mockResolvedValue(undefined)
  mockDelete.mockResolvedValue(undefined)
  mockBulkDelete.mockResolvedValue(undefined)
  mockRefreshMetadata.mockImplementation(async (id: string) => makeDoc({ id, metadataStatus: 'done' }))
  mockBulkRefreshMetadata.mockResolvedValue(undefined)
  mockBulkCategorize.mockResolvedValue(undefined)
  mockUpdate.mockImplementation(async (id: string, patch: Partial<Document>) => makeDoc({ id, ...patch }))
  mockImportFromZotero.mockResolvedValue({ added: 1, skipped: 0, errors: [] })
  mockImportFromMendeley.mockResolvedValue({ added: 1, skipped: 0, errors: [] })
  mockFromIdentifier.mockResolvedValue({ added: [] })
  mockExportBibtex.mockResolvedValue('')
  mockCategoriesList.mockResolvedValue([])
  mockCategoriesCreate.mockImplementation(async (name: string) => ({
    id: 'cat-new',
    name,
    sortOrder: 0,
    createdAt: 0
  }))
  mockCategoriesRename.mockResolvedValue(undefined)
  mockCategoriesDelete.mockResolvedValue(undefined)
  mockCategoriesAssign.mockReset().mockResolvedValue(undefined)
  mockCategoriesUnassign.mockReset().mockResolvedValue(undefined)

  const api = window.api as unknown as Record<string, unknown>
  api.getBootstrap = mockGetBootstrap
  const docs = api.documents as Record<string, unknown>
  docs.list = mockList
  docs.counts = mockCounts
  docs.setStarred = mockSetStarred
  docs.openPdf = mockOpenPdf
  docs.openInFinder = mockOpenInFinder
  docs.delete = mockDelete
  docs.bulkDelete = mockBulkDelete
  docs.refreshMetadata = mockRefreshMetadata
  docs.bulkRefreshMetadata = mockBulkRefreshMetadata
  docs.bulkCategorize = mockBulkCategorize
  docs.update = mockUpdate

  const settings = api.settings as Record<string, unknown>
  settings.set = mockSettingsSet

  const importApi = api.import as Record<string, unknown>
  importApi.fromZotero = mockImportFromZotero
  importApi.fromMendeley = mockImportFromMendeley
  importApi.fromIdentifier = mockFromIdentifier

  const exportApi = api.export as Record<string, unknown>
  exportApi.toBibtex = mockExportBibtex

  const categories = api.categories as Record<string, unknown>
  categories.list = mockCategoriesList
  categories.create = mockCategoriesCreate
  categories.rename = mockCategoriesRename
  categories.delete = mockCategoriesDelete
  categories.assign = mockCategoriesAssign
  categories.unassign = mockCategoriesUnassign

  const events = api.events as Record<string, unknown>
  events.onDocumentUpdated = mockOnDocUpdated
  events.onImportProgress = mockOnImportProgress
  events.onImportToast = mockOnImportToast
  events.onMenuExportBibtex = mockOnMenuExportBibtex
  events.onMenuImportZotero = mockOnMenuImportZotero
  events.onMenuImportMendeley = mockOnMenuImportMendeley
  events.onLibrarySwitched = mockOnLibrarySwitched
  events.onLibraryContentsChanged = mockOnLibraryContentsChanged

  resetStoreState()
  useConfirmStore.setState({ request: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllTimers()
})

describe('DocumentStore', () => {
  describe('fetchDocuments', () => {
    it('sets isLoading true during the call and false after', async () => {
      const docs = [makeDoc()]
      mockList.mockResolvedValue(docs)

      const promise = useDocumentStore.getState().fetchDocuments()
      expect(useDocumentStore.getState().isLoading).toBe(true)

      await promise
      expect(useDocumentStore.getState().isLoading).toBe(false)
    })

    it('populates documents and passes filter + sort to api', async () => {
      const docs = [makeDoc(), makeDoc({ id: 'doc-2', title: 'Second' })]
      mockList.mockResolvedValue(docs)

      await useDocumentStore.getState().fetchDocuments()

      expect(useDocumentStore.getState().documents).toEqual(docs)
      expect(mockList).toHaveBeenCalledWith({
        mode: 'all',
        sort: { field: 'addedAt', dir: 'desc' },
        limit: 100,
        offset: 0
      })
    })

    it('sets isLoading to false on error and keeps documents unchanged', async () => {
      useDocumentStore.setState({ documents: [makeDoc()] })
      mockList.mockRejectedValue({ code: 'ERR', message: 'fail' })

      await expect(useDocumentStore.getState().fetchDocuments()).rejects.toEqual({
        code: 'ERR',
        message: 'fail'
      })

      expect(useDocumentStore.getState().isLoading).toBe(false)
      expect(useDocumentStore.getState().documents).toHaveLength(1)
    })

    it('ignores an older list response that resolves after a newer request', async () => {
      let resolveFirst!: (docs: Document[]) => void
      let resolveSecond!: (docs: Document[]) => void
      mockList
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))

      const first = useDocumentStore.getState().fetchDocuments({ mode: 'starred' })
      const second = useDocumentStore.getState().fetchDocuments({ mode: 'recentlyRead' })
      const latest = [makeDoc({ id: 'latest' })]
      resolveSecond(latest)
      await second
      resolveFirst([makeDoc({ id: 'stale' })])
      await first

      expect(useDocumentStore.getState().documents).toEqual(latest)
    })

    it('loads large libraries in pages and appends the next page', async () => {
      const firstPage = Array.from({ length: 100 }, (_, index) => (
        makeDoc({ id: `doc-${index}` })
      ))
      const nextPage = [makeDoc({ id: 'doc-100' })]
      mockList.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(nextPage)

      await useDocumentStore.getState().fetchDocuments()
      expect(useDocumentStore.getState().hasMoreDocuments).toBe(true)

      await useDocumentStore.getState().loadMoreDocuments()

      expect(mockList).toHaveBeenLastCalledWith({
        mode: 'all',
        sort: { field: 'addedAt', dir: 'desc' },
        limit: 100,
        offset: 100
      })
      expect(useDocumentStore.getState().documents).toHaveLength(101)
      expect(useDocumentStore.getState().hasMoreDocuments).toBe(false)
    })
  })

  describe('global search state', () => {
    it('accepts resolved global-search documents through the store action', () => {
      const results = [makeDoc({ title: 'Found' })]
      useDocumentStore.getState().setSearchResults('  hello  ', results)

      expect(useDocumentStore.getState()).toMatchObject({
        isSearching: true,
        searchQuery: '  hello  ',
        searchResults: results
      })
    })

    it('clears global-search state and returns to the document list', () => {
      mockList.mockResolvedValue([makeDoc()])
      useDocumentStore.getState().setSearchResults('hello', [makeDoc()])

      useDocumentStore.getState().clearSearch()

      expect(useDocumentStore.getState()).toMatchObject({
        isSearching: false,
        searchQuery: '',
        searchResults: []
      })
      expect(mockList).toHaveBeenCalled()
    })
  })

  describe('init', () => {
    it('subscribes to all event channels and sets initialized', () => {
      useDocumentStore.getState().init(null)

      expect(mockOnDocUpdated).toHaveBeenCalledWith(expect.any(Function))
      expect(mockOnImportProgress).toHaveBeenCalledWith(expect.any(Function))
      expect(mockOnImportToast).toHaveBeenCalledWith(expect.any(Function))
      expect(mockOnMenuExportBibtex).toHaveBeenCalledWith(expect.any(Function))
      expect(useDocumentStore.getState().initialized).toBe(true)
    })

    it('calls fetchDocuments on init', () => {
      useDocumentStore.getState().init(null)
      expect(mockList).toHaveBeenCalled()
    })

    it('does not re-subscribe if already initialized', () => {
      useDocumentStore.getState().init(null)
      const listCalls = mockList.mock.calls.length

      useDocumentStore.getState().init(null)

      expect(mockList).toHaveBeenCalledTimes(listCalls)
    })
  })

  describe('destroy', () => {
    it('unsubscribes all event channels and sets initialized to false', () => {
      useDocumentStore.getState().init(null)
      useDocumentStore.getState().destroy()

      expect(mockDisposeDocUpdated).toHaveBeenCalledOnce()
      expect(mockDisposeImportProgress).toHaveBeenCalledOnce()
      expect(mockDisposeImportToast).toHaveBeenCalledOnce()
      expect(mockDisposeMenuExportBibtex).toHaveBeenCalledOnce()
      expect(mockDisposeMenuImportZotero).toHaveBeenCalledOnce()
      expect(mockDisposeMenuImportMendeley).toHaveBeenCalledOnce()
      expect(mockDisposeLibrarySwitched).toHaveBeenCalledOnce()
      expect(mockDisposeLibraryContentsChanged).toHaveBeenCalledOnce()
      expect(useDocumentStore.getState().initialized).toBe(false)
    })

    it('refreshes synced documents without clearing the current reading context', async () => {
      const synced = makeDoc({ id: 'doc-1', title: 'Synced title' })
      mockList.mockResolvedValue([synced])
      useDocumentStore.setState({
        documents: [makeDoc({ id: 'doc-1', title: 'Old title' })],
        selectedIds: ['doc-1'],
        focusedDocId: 'doc-1',
        listMode: { mode: 'starred' }
      })

      useDocumentStore.getState().init(null)
      const refresh = mockOnLibraryContentsChanged.mock.calls[0]?.[0] as (() => void)
      refresh()

      await vi.waitFor(() => {
        expect(useDocumentStore.getState().documents).toEqual([synced])
      })
      expect(useDocumentStore.getState()).toMatchObject({
        selectedIds: ['doc-1'],
        focusedDocId: 'doc-1',
        listMode: { mode: 'starred' }
      })
    })

    it('library:switched event refetches documents and clears selection', async () => {
      const fetchedDocs = [makeDoc({ id: 'a1' }), makeDoc({ id: 'a2' })]
      mockList.mockResolvedValue(fetchedDocs)
      useDocumentStore.setState({
        selectedIds: ['old'],
        focusedDocId: 'old',
        documents: [makeDoc({ id: 'old' })]
      })

      useDocumentStore.getState().init(null)
      const cb = mockOnLibrarySwitched.mock.calls[0]?.[0] as (() => void) | undefined
      expect(cb).toBeDefined()
      cb!()

      expect(useDocumentStore.getState().selectedIds).toEqual([])
      expect(useDocumentStore.getState().focusedDocId).toBeNull()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(mockList).toHaveBeenCalled()
      expect(useDocumentStore.getState().listColumnState).toEqual(defaultListColumnState)
      expect(mockGetBootstrap).not.toHaveBeenCalled()
    })

    it('drops a stale debounced column write after an external library switch', async () => {
      vi.useFakeTimers()
      useDocumentStore.getState().init(null)
      const nextColumns: ListColumnState = {
        ...defaultListColumnState,
        sort: { field: 'venue', dir: 'asc' }
      }
      useDocumentStore.getState().setListColumnState(nextColumns)
      const cb = mockOnLibrarySwitched.mock.calls[0]?.[0] as (() => void) | undefined

      cb!()
      await vi.advanceTimersByTimeAsync(500)

      expect(mockSettingsSet).not.toHaveBeenCalledWith('listColumnState', nextColumns)
      vi.useRealTimers()
    })

    it('clears library state immediately and ignores delayed responses from the previous library', async () => {
      let resolveOldDocuments!: (documents: Document[]) => void
      let resolveNewDocuments!: (documents: Document[]) => void
      let resolveOldCategories!: (categories: Category[]) => void
      let resolveNewCategories!: (categories: Category[]) => void
      let resolveOldCounts!: (counts: {
        all: number
        recentlyRead: number
        recentlyAdded: number
        starred: number
      }) => void
      let resolveNewCounts!: typeof resolveOldCounts
      mockList
        .mockImplementationOnce(() => new Promise((resolve) => { resolveOldDocuments = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveNewDocuments = resolve }))
      mockCategoriesList
        .mockImplementationOnce(() => new Promise((resolve) => { resolveOldCategories = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveNewCategories = resolve }))
      mockCounts
        .mockImplementationOnce(() => new Promise((resolve) => { resolveOldCounts = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveNewCounts = resolve }))
      useDocumentStore.setState({
        documents: [makeDoc({ id: 'old' })],
        documentCounts: { all: 4, recentlyRead: 3, recentlyAdded: 2, starred: 1 },
        listMode: { mode: 'category', categoryId: 'old-category' },
        selectedIds: ['old'],
        focusedDocId: 'old',
        isImporting: true,
        importProgress: { current: 1, total: 2 },
        identifierImporting: 1,
        isLoading: true,
        isLoadingMoreDocuments: true,
        hasMoreDocuments: true,
        categories: [{ id: 'old-category', name: 'Old', sortOrder: 0, createdAt: 0, count: 1 }]
      })

      useDocumentStore.getState().init(null)
      const cb = mockOnLibrarySwitched.mock.calls[0]?.[0] as (() => void)
      cb()

      expect(useDocumentStore.getState()).toMatchObject({
        documents: [],
        documentCounts: { all: 0, recentlyRead: 0, recentlyAdded: 0, starred: 0 },
        listMode: { mode: 'all' },
        selectedIds: [],
        focusedDocId: null,
        isImporting: false,
        importProgress: null,
        identifierImporting: 0,
        isLoading: false,
        isLoadingMoreDocuments: false,
        hasMoreDocuments: false,
        categories: []
      })

      await vi.waitFor(() => {
        expect(mockList).toHaveBeenCalledTimes(2)
        expect(mockCategoriesList).toHaveBeenCalledTimes(2)
        expect(mockCounts).toHaveBeenCalledTimes(2)
      })
      const newDocuments = [makeDoc({ id: 'new' })]
      const newCategories = [
        { id: 'new-category', name: 'New', sortOrder: 0, createdAt: 1, count: 1 }
      ]
      const newCounts = { all: 1, recentlyRead: 0, recentlyAdded: 1, starred: 0 }
      resolveNewDocuments(newDocuments)
      resolveNewCategories(newCategories)
      resolveNewCounts(newCounts)
      await vi.waitFor(() => {
        expect(useDocumentStore.getState().documents).toEqual(newDocuments)
        expect(useDocumentStore.getState().categories).toEqual(newCategories)
        expect(useDocumentStore.getState().documentCounts).toEqual(newCounts)
      })

      resolveOldDocuments([makeDoc({ id: 'stale' })])
      resolveOldCategories([
        { id: 'stale-category', name: 'Stale', sortOrder: 0, createdAt: 0, count: 9 }
      ])
      resolveOldCounts({ all: 99, recentlyRead: 99, recentlyAdded: 99, starred: 99 })
      await Promise.resolve()

      expect(useDocumentStore.getState().documents).toEqual(newDocuments)
      expect(useDocumentStore.getState().categories).toEqual(newCategories)
      expect(useDocumentStore.getState().documentCounts).toEqual(newCounts)
    })
  })

  describe('startImport / updateImportProgress', () => {
    it('startImport sets isImporting and importProgress', () => {
      useDocumentStore.getState().startImport(5)
      expect(useDocumentStore.getState().isImporting).toBe(true)
      expect(useDocumentStore.getState().importProgress).toEqual({ current: 0, total: 5 })
    })

    it('updateImportProgress updates current without completing when current < total', () => {
      useDocumentStore.getState().startImport(3)
      mockList.mockClear()

      useDocumentStore.getState().updateImportProgress({ current: 1, total: 3 })

      expect(useDocumentStore.getState().importProgress).toEqual({ current: 1, total: 3 })
      expect(useDocumentStore.getState().isImporting).toBe(true)
      expect(mockList).not.toHaveBeenCalled()
    })

    it('clears import state and fetches documents when current reaches total', async () => {
      useDocumentStore.getState().startImport(2)
      mockList.mockClear()
      mockList.mockResolvedValue([makeDoc({ id: 'imported-1' })])

      useDocumentStore.getState().updateImportProgress({ current: 2, total: 2 })

      expect(useDocumentStore.getState().isImporting).toBe(false)
      expect(useDocumentStore.getState().importProgress).toBeNull()
      expect(mockList).toHaveBeenCalledTimes(1)
    })

    it('does not re-trigger fetchDocuments on a second completion event', async () => {
      useDocumentStore.getState().startImport(2)
      mockList.mockClear()
      mockList.mockResolvedValue([])

      useDocumentStore.getState().updateImportProgress({ current: 2, total: 2 })
      await new Promise((r) => setTimeout(r, 0))
      const callsAfterFirst = mockList.mock.calls.length

      useDocumentStore.getState().updateImportProgress({ current: 0, total: 0 })

      await new Promise((r) => setTimeout(r, 0))
      expect(mockList.mock.calls.length).toBe(callsAfterFirst)
    })

    it('fetches documents on completion even when nothing was imported (total=0)', async () => {
      useDocumentStore.getState().startImport(0)
      mockList.mockClear()
      mockList.mockResolvedValue([])

      useDocumentStore.getState().updateImportProgress({ current: 0, total: 0 })

      expect(useDocumentStore.getState().isImporting).toBe(false)
      expect(mockList).toHaveBeenCalledTimes(1)
    })
  })

  describe('setFocusedDoc', () => {
    it('updates focusedDocId', () => {
      useDocumentStore.getState().setFocusedDoc('doc-1')
      expect(useDocumentStore.getState().focusedDocId).toBe('doc-1')
    })

    it('clears focusedDocId when passed null', () => {
      useDocumentStore.getState().setFocusedDoc('doc-1')
      useDocumentStore.getState().setFocusedDoc(null)
      expect(useDocumentStore.getState().focusedDocId).toBeNull()
    })
  })

  describe('toggleSelect', () => {
    it('adds docId to selectedIds array', () => {
      useDocumentStore.getState().toggleSelect('doc-1')
      expect(useDocumentStore.getState().selectedIds).toEqual(['doc-1'])
    })

    it('removes docId from selectedIds on second call', () => {
      useDocumentStore.getState().toggleSelect('doc-1')
      useDocumentStore.getState().toggleSelect('doc-1')
      expect(useDocumentStore.getState().selectedIds).toEqual([])
    })

    it('supports selecting multiple documents', () => {
      useDocumentStore.getState().toggleSelect('doc-1')
      useDocumentStore.getState().toggleSelect('doc-2')
      expect(useDocumentStore.getState().selectedIds).toEqual(['doc-1', 'doc-2'])
    })
  })

  describe('toggleStar', () => {
    it('optimistically updates starred field and calls api', async () => {
      useDocumentStore.setState({ documents: [makeDoc({ starred: 0 })] })

      const promise = useDocumentStore.getState().toggleStar('doc-1')

      expect(useDocumentStore.getState().documents[0].starred).toBe(1)

      await promise

      expect(mockSetStarred).toHaveBeenCalledWith('doc-1', true)
      expect(useDocumentStore.getState().documents[0].starred).toBe(1)
    })

    it('reverts starred field on api failure and shows toast', async () => {
      useDocumentStore.setState({ documents: [makeDoc({ starred: 0 })] })
      mockSetStarred.mockRejectedValue(new Error('fail'))

      await useDocumentStore.getState().toggleStar('doc-1')

      expect(useDocumentStore.getState().documents[0].starred).toBe(0)
      expect(useDocumentStore.getState().toastMessage).toBe('Failed to update star')
    })

    it('serializes rapid toggles so the final backend value matches the UI', async () => {
      let resolveFirst!: () => void
      mockSetStarred
        .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve }))
        .mockResolvedValueOnce(undefined)
      useDocumentStore.setState({ documents: [makeDoc({ starred: 0 })] })

      const first = useDocumentStore.getState().toggleStar('doc-1')
      const second = useDocumentStore.getState().toggleStar('doc-1')

      expect(useDocumentStore.getState().documents[0].starred).toBe(0)
      expect(mockSetStarred).toHaveBeenCalledTimes(1)
      expect(mockSetStarred).toHaveBeenNthCalledWith(1, 'doc-1', true)

      resolveFirst()
      await Promise.all([first, second])

      expect(mockSetStarred).toHaveBeenCalledTimes(2)
      expect(mockSetStarred).toHaveBeenNthCalledWith(2, 'doc-1', false)
      expect(useDocumentStore.getState().documents[0].starred).toBe(0)
    })

    it('rolls the UI back to the last confirmed value when the queued toggle fails', async () => {
      let resolveFirst!: () => void
      mockSetStarred
        .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve }))
        .mockRejectedValueOnce(new Error('second update failed'))
      useDocumentStore.setState({ documents: [makeDoc({ starred: 0 })] })

      const first = useDocumentStore.getState().toggleStar('doc-1')
      const second = useDocumentStore.getState().toggleStar('doc-1')
      resolveFirst()
      await Promise.all([first, second])

      expect(mockSetStarred).toHaveBeenNthCalledWith(1, 'doc-1', true)
      expect(mockSetStarred).toHaveBeenNthCalledWith(2, 'doc-1', false)
      expect(useDocumentStore.getState().documents[0].starred).toBe(1)
      expect(useDocumentStore.getState().toastMessage).toBe('Failed to update star')
    })

    it('rolls back only the starred field when a document update arrives in flight', async () => {
      let rejectStar!: (error: Error) => void
      const original = makeDoc({ starred: 0, title: 'Original title' })
      mockSetStarred.mockReturnValue(new Promise((_resolve, reject) => { rejectStar = reject }))
      useDocumentStore.getState().init(null)
      await Promise.resolve()
      useDocumentStore.setState({ documents: [original] })

      const pending = useDocumentStore.getState().toggleStar(original.id)
      const documentUpdated = mockOnDocUpdated.mock.calls[0][0] as (doc: Document) => void
      documentUpdated({ ...original, starred: 1, title: 'Updated title' })
      rejectStar(new Error('fail'))
      await pending

      expect(useDocumentStore.getState().documents[0]).toMatchObject({
        title: 'Updated title',
        starred: 0
      })
    })

    it('does nothing if docId is not in documents', async () => {
      await useDocumentStore.getState().toggleStar('nonexistent')

      expect(mockSetStarred).not.toHaveBeenCalled()
    })
  })

  describe('list controls', () => {
    it('updates filters, selection, columns, and sort state', async () => {
      vi.useFakeTimers()
      const docs = [makeDoc(), makeDoc({ id: 'doc-2' })]
      useDocumentStore.setState({
        documents: docs,
        selectedIds: ['doc-1'],
        focusedDocId: 'doc-1'
      })

      useDocumentStore.getState().setListMode({ mode: 'starred' })
      expect(useDocumentStore.getState().listMode).toEqual({ mode: 'starred' })
      expect(useDocumentStore.getState().selectedIds).toEqual([])
      expect(useDocumentStore.getState().focusedDocId).toBeNull()
      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ mode: 'starred' }))

      useDocumentStore.getState().selectAll()
      expect(useDocumentStore.getState().selectedIds).toEqual(['doc-1', 'doc-2'])
      useDocumentStore.getState().clearSelection()
      expect(useDocumentStore.getState().selectedIds).toEqual([])

      const columns = defaultListColumnState.columns.map((column) => ({
        ...column,
        visible: column.id !== 'filePath'
      }))
      useDocumentStore.getState().setColumns(columns)
      expect(useDocumentStore.getState().listColumnState.columns).toEqual(columns)

      useDocumentStore.getState().setSort('title')
      expect(useDocumentStore.getState().listColumnState.sort).toEqual({ field: 'title', dir: 'asc' })
      useDocumentStore.getState().setSort('title')
      expect(useDocumentStore.getState().listColumnState.sort).toEqual({ field: 'title', dir: 'desc' })
      useDocumentStore.getState().setSort('title')
      expect(useDocumentStore.getState().listColumnState.sort).toEqual({ field: 'title', dir: 'asc' })

      useDocumentStore.getState().setListColumnState({
        columns,
        sort: { field: 'year', dir: 'asc' }
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(mockSettingsSet).toHaveBeenLastCalledWith('listColumnState', {
        columns,
        sort: { field: 'year', dir: 'asc' }
      })
      vi.useRealTimers()
    })

    it('toggles addedAt sort from the default desc state without no-op', () => {
      expect(useDocumentStore.getState().listColumnState.sort).toEqual({
        field: 'addedAt',
        dir: 'desc'
      })

      useDocumentStore.getState().setSort('addedAt')
      expect(useDocumentStore.getState().listColumnState.sort).toEqual({
        field: 'addedAt',
        dir: 'asc'
      })

      useDocumentStore.getState().setSort('addedAt')
      expect(useDocumentStore.getState().listColumnState.sort).toEqual({
        field: 'addedAt',
        dir: 'desc'
      })
    })

    it('flushes a pending column layout without waiting for the debounce', async () => {
      vi.useFakeTimers()
      const next = {
        ...defaultListColumnState,
        sort: { field: 'year', dir: 'asc' } as const
      }

      useDocumentStore.getState().setListColumnState(next)
      await useDocumentStore.getState().flushPendingSettings()

      expect(mockSettingsSet).toHaveBeenCalledOnce()
      expect(mockSettingsSet).toHaveBeenCalledWith('listColumnState', next)
      await vi.advanceTimersByTimeAsync(500)
      expect(mockSettingsSet).toHaveBeenCalledOnce()
      vi.useRealTimers()
    })
  })

  describe('document actions', () => {
    it('opens, stars, and deletes documents that exist only in search results', async () => {
      const searchDoc = makeDoc({ id: 'search-only' })
      useDocumentStore.setState({
        documents: [],
        searchResults: [searchDoc],
        isSearching: true
      })

      await useDocumentStore.getState().openPdf(searchDoc.id)
      await useDocumentStore.getState().toggleStar(searchDoc.id)
      await useDocumentStore.getState().deleteDoc(searchDoc.id)

      expect(mockOpenPdf).toHaveBeenCalledWith(searchDoc.id)
      expect(mockSetStarred).toHaveBeenCalledWith(searchDoc.id, true)
      expect(mockDelete).toHaveBeenCalledWith(searchDoc.id)
      expect(useDocumentStore.getState().searchResults).toEqual([])
    })

    it('updates documents through individual and bulk actions', async () => {
      const first = makeDoc()
      const second = makeDoc({ id: 'doc-2', title: 'Second' })
      useDocumentStore.setState({ documents: [first, second], selectedIds: ['doc-1'] })

      await useDocumentStore.getState().openPdf('doc-1')
      expect(mockOpenPdf).toHaveBeenCalledWith('doc-1')
      expect(useDocumentStore.getState().documents[0].lastReadAt).toBe(1)

      await useDocumentStore.getState().openInFinder('doc-1')
      expect(mockOpenInFinder).toHaveBeenCalledWith('doc-1')

      expect(await useDocumentStore.getState().refreshMetadata('doc-1')).toBe(true)
      expect(useDocumentStore.getState().documents[0].metadataStatus).toBe('done')

      const updated = await useDocumentStore.getState().updateDocument('doc-1', { title: 'Updated' })
      expect(updated.title).toBe('Updated')
      expect(useDocumentStore.getState().documents[0].title).toBe('Updated')

      await useDocumentStore.getState().bulkRefreshMetadata(['doc-1'])
      expect(useDocumentStore.getState().documents[0].metadataStatus).toBe('pending')
      expect(mockBulkRefreshMetadata).toHaveBeenCalledWith(['doc-1'])

      await useDocumentStore.getState().bulkCategorize(['doc-1'], 'cat-1')
      expect(mockBulkCategorize).toHaveBeenCalledWith(['doc-1'], 'cat-1')
      expect(mockCategoriesList).toHaveBeenCalled()
      expect(useDocumentStore.getState().selectedIds).toEqual([])

      await useDocumentStore.getState().deleteDoc('doc-1')
      expect(mockDelete).toHaveBeenCalledWith('doc-1')
      expect(useDocumentStore.getState().documents.map((doc) => doc.id)).toEqual(['doc-2'])

      await useDocumentStore.getState().bulkDelete(['doc-2'])
      expect(mockBulkDelete).toHaveBeenCalledWith(['doc-2'])
      expect(useDocumentStore.getState().documents).toEqual([])
    })

    it('restores optimistic state and surfaces action failures', async () => {
      const doc = makeDoc()
      useDocumentStore.setState({
        documents: [doc],
        selectedIds: ['doc-1'],
        focusedDocId: 'doc-1'
      })
      mockOpenPdf.mockRejectedValueOnce(new Error('open failed'))
      mockOpenInFinder.mockRejectedValueOnce(new Error('finder failed'))
      mockRefreshMetadata.mockRejectedValueOnce(new Error('refresh failed'))
      mockBulkRefreshMetadata.mockRejectedValueOnce(new Error('bulk refresh failed'))
      mockBulkCategorize.mockRejectedValueOnce(new Error('categorize failed'))
      mockDelete.mockRejectedValueOnce(new Error('delete failed'))

      await useDocumentStore.getState().openPdf('doc-1')
      expect(useDocumentStore.getState().toastMessage).toBe('open failed')
      await useDocumentStore.getState().openInFinder('doc-1')
      expect(await useDocumentStore.getState().refreshMetadata('doc-1')).toBe(false)
      await useDocumentStore.getState().bulkRefreshMetadata(['doc-1'])
      await useDocumentStore.getState().bulkCategorize(['doc-1'], 'cat-1')
      await useDocumentStore.getState().deleteDoc('doc-1')

      expect(useDocumentStore.getState().documents).toContainEqual(doc)
      expect(useDocumentStore.getState().selectedIds).toEqual(['doc-1'])
      expect(useDocumentStore.getState().focusedDocId).toBe('doc-1')

      mockBulkDelete.mockRejectedValueOnce(new Error('bulk delete failed'))
      await useDocumentStore.getState().bulkDelete(['doc-1'])
      expect(useDocumentStore.getState().documents).toContainEqual(doc)
      expect(useDocumentStore.getState().selectedIds).toEqual(['doc-1'])
      expect(useDocumentStore.getState().focusedDocId).toBe('doc-1')
    })

    it('restores metadata state in lists when a bulk refresh fails', async () => {
      const doc = makeDoc({ metadataStatus: 'done' })
      useDocumentStore.setState({ documents: [doc], searchResults: [doc] })
      mockBulkRefreshMetadata.mockRejectedValueOnce(new Error('bulk refresh failed'))

      await useDocumentStore.getState().bulkRefreshMetadata(['doc-1'])

      expect(useDocumentStore.getState().documents[0].metadataStatus).toBe('done')
      expect(useDocumentStore.getState().searchResults[0].metadataStatus).toBe('done')
    })

    it('preserves newer UI state while rolling back a failed delete', async () => {
      const doc = makeDoc()
      const newer = makeDoc({ id: 'doc-newer' })
      let rejectDelete: (error: Error) => void = () => undefined
      mockDelete.mockImplementationOnce(() => new Promise((_, reject) => {
        rejectDelete = reject
      }))
      useDocumentStore.setState({
        documents: [doc],
        selectedIds: ['doc-1'],
        focusedDocId: 'doc-1'
      })

      const deletion = useDocumentStore.getState().deleteDoc('doc-1')
      useDocumentStore.setState({
        documents: [newer],
        selectedIds: ['doc-newer'],
        focusedDocId: 'doc-newer'
      })
      rejectDelete(new Error('delete failed'))
      await deletion

      expect(useDocumentStore.getState().documents).toEqual([doc, newer])
      expect(useDocumentStore.getState().selectedIds).toEqual(['doc-newer', 'doc-1'])
      expect(useDocumentStore.getState().focusedDocId).toBe('doc-newer')
    })

    it('skips opening missing or unknown documents', async () => {
      useDocumentStore.setState({ documents: [makeDoc({ fileMissing: 1 })] })
      await useDocumentStore.getState().openPdf('doc-1')
      await useDocumentStore.getState().openPdf('unknown')
      expect(mockOpenPdf).not.toHaveBeenCalled()
    })
  })

  describe('confirmation, toast, and import actions', () => {
    it('routes deletion confirmations through the shared confirm store', async () => {
      useDocumentStore.getState().showToast('Saved')
      expect(useDocumentStore.getState().toastMessage).toBe('Saved')
      useDocumentStore.getState().clearToast()
      expect(useDocumentStore.getState().toastMessage).toBeNull()

      useDocumentStore.getState().requestDeleteConfirm(['doc-1'], 'Delete it?')
      expect(useConfirmStore.getState().request).toMatchObject({
        title: 'Delete Document',
        message: 'Delete it?',
        danger: true
      })

      useDocumentStore.setState({ documents: [makeDoc()] })
      useDocumentStore.getState().requestDeleteConfirm(['doc-1'], '')
      await useConfirmStore.getState().request?.onConfirm()
      expect(mockDelete).toHaveBeenCalledWith('doc-1')

      useDocumentStore.setState({ documents: [makeDoc(), makeDoc({ id: 'doc-2' })] })
      useDocumentStore.getState().requestDeleteConfirm(['doc-1', 'doc-2'], '')
      await useConfirmStore.getState().request?.onConfirm()
      expect(mockBulkDelete).toHaveBeenCalledWith(['doc-1', 'doc-2'])
    })

    it('ends imports and handles Zotero and Mendeley results', async () => {
      useDocumentStore.getState().startImport(3)
      useDocumentStore.getState().endImport()
      expect(useDocumentStore.getState().isImporting).toBe(false)
      expect(useDocumentStore.getState().importProgress).toBeNull()

      await useDocumentStore.getState().importFromZotero()
      await useDocumentStore.getState().importFromMendeley()
      expect(mockImportFromZotero).toHaveBeenCalledOnce()
      expect(mockImportFromMendeley).toHaveBeenCalledOnce()

      mockImportFromZotero.mockRejectedValueOnce(new Error('zotero failed'))
      mockImportFromMendeley.mockRejectedValueOnce(new Error('mendeley failed'))
      await useDocumentStore.getState().importFromZotero()
      await useDocumentStore.getState().importFromMendeley()
      expect(useDocumentStore.getState().toastMessage).toBeTruthy()
    })
  })

  describe('importByIdentifier', () => {
    it('sets identifierImporting and shows success toast on success', async () => {
      mockFromIdentifier.mockResolvedValueOnce({ added: ['doc-1'] })
      mockList.mockResolvedValueOnce([])

      const importPromise = useDocumentStore.getState().importByIdentifier('10.1000/test')
      expect(useDocumentStore.getState().identifierImporting).toBeGreaterThan(0)

      await expect(importPromise).resolves.toBeNull()
      expect(useDocumentStore.getState().identifierImporting).toBe(0)
      expect(useDocumentStore.getState().toastMessage).toBe('Imported successfully')
      expect(mockList).toHaveBeenCalled()
    })

    it('shows the service message when no document was added', async () => {
      mockFromIdentifier.mockResolvedValueOnce({ added: [], message: 'Already imported' })

      const importPromise = useDocumentStore.getState().importByIdentifier('2401.12345')

      await expect(importPromise).resolves.toBe('Already imported')
      expect(useDocumentStore.getState().identifierImporting).toBe(0)
      expect(useDocumentStore.getState().toastMessage).toBe('Already imported')
    })

    it('shows error toast and clears identifierImporting on failure', async () => {
      mockFromIdentifier.mockRejectedValueOnce(new Error('lookup failed'))

      const importPromise = useDocumentStore.getState().importByIdentifier('2401.12345')
      expect(useDocumentStore.getState().identifierImporting).toBeGreaterThan(0)

      await expect(importPromise).resolves.toBe('Import failed: lookup failed')
      expect(useDocumentStore.getState().identifierImporting).toBe(0)
      expect(useDocumentStore.getState().toastMessage).toBe('Import failed: lookup failed')
    })

    it('shows a friendly retry message for network failures', async () => {
      mockFromIdentifier.mockRejectedValueOnce(
        Object.assign(new Error('Could not resolve the download host'), {
          code: 'identifier_network_error'
        })
      )

      await expect(useDocumentStore.getState().importByIdentifier('2401.12345')).resolves.toBe(
        'The network is unavailable or too slow. Check your connection and try again.'
      )
      expect(useDocumentStore.getState().identifierImporting).toBe(0)
      expect(useDocumentStore.getState().toastMessage).toBe(
        'The network is unavailable or too slow. Check your connection and try again.'
      )
    })

    it('does not clobber state when multiple imports run concurrently', async () => {
      let resolveFirst: (value: { added: string[] }) => void = () => {}
      let resolveSecond: (value: { added: string[] }) => void = () => {}
      mockFromIdentifier.mockReturnValueOnce(new Promise((r) => { resolveFirst = r }))
      mockFromIdentifier.mockReturnValueOnce(new Promise((r) => { resolveSecond = r }))

      useDocumentStore.getState().importByIdentifier('10.1000/a')
      useDocumentStore.getState().importByIdentifier('10.1000/b')
      expect(useDocumentStore.getState().identifierImporting).toBe(2)

      resolveFirst({ added: ['doc-1'] })
      await vi.waitFor(() => {
        expect(useDocumentStore.getState().identifierImporting).toBe(1)
      })

      resolveSecond({ added: ['doc-2'] })
      await vi.waitFor(() => {
        expect(useDocumentStore.getState().identifierImporting).toBe(0)
      })
    })
  })

  describe('event callbacks', () => {
    it('routes document, import, export, and menu events into store actions', async () => {
      const original = makeDoc()
      const updated = makeDoc({ title: 'Updated by event' })
      useDocumentStore.setState({ documents: [original], selectedIds: ['doc-1'] })
      useDocumentStore.getState().init(null)

      const documentUpdated = mockOnDocUpdated.mock.calls[0][0] as (doc: Document) => void
      const importProgress = mockOnImportProgress.mock.calls[0][0] as (progress: { current: number; total: number }) => void
      const importToast = mockOnImportToast.mock.calls[0][0] as (message: string) => void
      const exportBibtex = mockOnMenuExportBibtex.mock.calls[0][0] as () => void
      const importZotero = mockOnMenuImportZotero.mock.calls[0][0] as () => void
      const importMendeley = mockOnMenuImportMendeley.mock.calls[0][0] as () => void

      documentUpdated(updated)
      expect(useDocumentStore.getState().documents[0].title).toBe('Updated by event')
      importProgress({ current: 1, total: 2 })
      expect(useDocumentStore.getState().importProgress).toEqual({ current: 1, total: 2 })
      importToast('Imported')
      expect(useDocumentStore.getState().toastMessage).toBe('Imported')
      exportBibtex()
      expect(mockExportBibtex).toHaveBeenCalledWith(['doc-1'])
      importZotero()
      importMendeley()
      await vi.waitFor(() => {
        expect(mockImportFromZotero).toHaveBeenCalled()
        expect(mockImportFromMendeley).toHaveBeenCalled()
      })

      useDocumentStore.getState().destroy()
    })

    it('shows a toast when the menu BibTeX export fails', async () => {
      useDocumentStore.setState({ documents: [makeDoc()], selectedIds: ['doc-1'] })
      useDocumentStore.getState().init(null)

      const exportBibtex = mockOnMenuExportBibtex.mock.calls[0][0] as () => void
      mockExportBibtex.mockRejectedValueOnce(new Error(''))

      exportBibtex()

      await vi.waitFor(() => {
        expect(useDocumentStore.getState().toastMessage).toBe('BibTeX export failed')
      })

      useDocumentStore.getState().destroy()
    })
  })

  describe('category actions', () => {
    it('fetches, creates, renames, and deletes categories', async () => {
      const category: Category = {
        id: 'cat-1',
        name: 'Reading',
        sortOrder: 0,
        createdAt: 0,
        count: 2
      }
      mockCategoriesList.mockResolvedValue([category])
      await useDocumentStore.getState().fetchCategories()
      expect(useDocumentStore.getState().categories).toEqual([category])

      const created = await useDocumentStore.getState().createCategory('New')
      expect(created?.name).toBe('New')
      expect(useDocumentStore.getState().categories.at(-1)).toMatchObject({ name: 'New', count: 0 })

      const categorizedDocument = makeDoc({ categories: [category] })
      useDocumentStore.setState({
        documents: [categorizedDocument],
        searchResults: [categorizedDocument]
      })
      await useDocumentStore.getState().renameCategory('cat-1', 'Renamed')
      expect(useDocumentStore.getState().categories[0]?.name).toBe('Renamed')
      expect(useDocumentStore.getState().documents[0]?.categories?.[0]?.name).toBe('Renamed')
      expect(useDocumentStore.getState().searchResults[0]?.categories?.[0]?.name).toBe('Renamed')
      await useDocumentStore.getState().deleteCategory('cat-1')
      expect(useDocumentStore.getState().categories.some((item) => item.id === 'cat-1')).toBe(false)
      expect(useDocumentStore.getState().documents[0].categories).toEqual([])
      expect(useDocumentStore.getState().searchResults[0].categories).toEqual([])
    })

    it('returns null and shows errors when category mutations fail', async () => {
      mockCategoriesCreate.mockRejectedValueOnce(new Error('create failed'))
      mockCategoriesRename.mockRejectedValueOnce(new Error('rename failed'))
      mockCategoriesDelete.mockRejectedValueOnce(new Error('delete failed'))

      expect(await useDocumentStore.getState().createCategory('Bad')).toBeNull()
      await useDocumentStore.getState().renameCategory('cat-1', 'Bad')
      await useDocumentStore.getState().deleteCategory('cat-1')
      expect(useDocumentStore.getState().toastMessage).toBeTruthy()
    })

    it('updates document categories through shared store actions', async () => {
      const category: Category = {
        id: 'cat-1',
        name: 'Reading',
        sortOrder: 0,
        createdAt: 0,
        count: 2
      }
      const document = makeDoc({ categories: [] })
      useDocumentStore.setState({
        categories: [category],
        documents: [document],
        searchResults: [document],
        isSearching: true
      })

      await useDocumentStore.getState().assignDocumentsToCategory(['doc-1'], category.id)

      expect(mockCategoriesAssign).toHaveBeenCalledWith('doc-1', category.id)
      expect(useDocumentStore.getState().documents[0].categories).toEqual([
        expect.objectContaining({ id: category.id, name: category.name })
      ])
      expect(useDocumentStore.getState().searchResults[0].categories).toEqual([
        expect.objectContaining({ id: category.id, name: category.name })
      ])

      await useDocumentStore.getState().unassignDocumentFromCategory('doc-1', category.id)

      expect(mockCategoriesUnassign).toHaveBeenCalledWith('doc-1', category.id)
      expect(useDocumentStore.getState().documents[0].categories).toEqual([])
      expect(useDocumentStore.getState().searchResults[0].categories).toEqual([])
    })
  })
})
