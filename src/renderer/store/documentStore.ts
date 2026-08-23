import { create } from 'zustand'
import type {
  BibImportResult,
  Document,
  DocumentCounts,
  DocumentPatch,
  ImportProgress,
  ListColumn,
  ListColumnState,
  ListFilter,
  SortField,
  Category
} from '../../shared/ipc-types'
import { errorMessage } from '../../shared/ipc-types'
import { api } from '../ipc'
import i18n from '../i18n'
import { openDocumentPdf } from '../utils/openPdf'
import { normalizeBootstrapData } from '../../shared/bootstrap'

const DEFAULT_COLUMNS: ListColumn[] = [
  { id: 'title', visible: true, width: 300, order: 0 },
  { id: 'authors', visible: true, width: 192, order: 1 },
  { id: 'year', visible: true, width: 64, order: 2 },
  { id: 'venue', visible: true, width: 128, order: 3 },
  { id: 'addedAt', visible: true, width: 96, order: 4 },
  { id: 'filePath', visible: true, width: 192, order: 5 }
]

function defaultColumnState(): ListColumnState {
  return { columns: DEFAULT_COLUMNS, sort: { field: 'addedAt', dir: 'desc' } }
}

let persistTimeout: ReturnType<typeof setTimeout> | null = null
let pendingColumnState: { state: ListColumnState; generation: number } | null = null
let persistTask: Promise<void> | null = null
let columnPersistenceGeneration = 0

function persistColumnState(state: ListColumnState): void {
  if (persistTimeout) clearTimeout(persistTimeout)
  pendingColumnState = { state, generation: columnPersistenceGeneration }
  persistTimeout = setTimeout(() => {
    persistTimeout = null
    void flushColumnState().catch(() => {
      useDocumentStore.getState().showToast(i18n.t('common.settingsSaveFailed'))
    })
  }, 500)
}

async function flushColumnState(): Promise<void> {
  if (persistTimeout) {
    clearTimeout(persistTimeout)
    persistTimeout = null
  }
  if (persistTask) await persistTask.catch(() => undefined)
  const pending = pendingColumnState
  if (!pending) return
  pendingColumnState = null
  if (pending.generation !== columnPersistenceGeneration) return
  const task = api.settings.set('listColumnState', pending.state)
  persistTask = task
  try {
    await task
  } catch (error) {
    if (!pendingColumnState && pending.generation === columnPersistenceGeneration) {
      pendingColumnState = pending
    }
    throw error
  } finally {
    if (persistTask === task) persistTask = null
  }
  if (pendingColumnState) await flushColumnState()
}

interface DocumentState {
  documents: Document[]
  documentCounts: DocumentCounts
  listMode: ListFilter
  listColumnState: ListColumnState
  selectedIds: string[]
  focusedDocId: string | null
  toastMessage: string | null
  confirmDelete: { ids: string[]; message: string } | null
  isImporting: boolean
  importProgress: { current: number; total: number } | null
  identifierImporting: number
  isLoading: boolean
  isLoadingMoreDocuments: boolean
  hasMoreDocuments: boolean
  initialized: boolean
  categories: Category[]
  isSearching: boolean
  searchQuery: string
  searchResults: Document[]
  isLoadingMoreSearchResults: boolean
  hasMoreSearchResults: boolean
  fetchDocuments: (filter?: ListFilter) => Promise<void>
  loadMoreDocuments: () => Promise<void>
  fetchDocumentCounts: () => Promise<void>
  setListMode: (filter: ListFilter) => void
  setListColumnState: (state: ListColumnState) => void
  setSort: (field: SortField) => void
  setColumns: (columns: ListColumn[]) => void
  flushPendingSettings: () => Promise<void>
  setFocusedDoc: (docId: string | null) => void
  toggleSelect: (docId: string) => void
  selectAll: () => void
  clearSelection: () => void
  toggleStar: (docId: string) => Promise<void>
  openPdf: (docId: string) => Promise<void>
  openInFinder: (docId: string) => Promise<void>
  deleteDoc: (docId: string) => Promise<void>
  bulkDelete: (ids: string[]) => Promise<void>
  bulkRefreshMetadata: (ids: string[]) => Promise<void>
  bulkCategorize: (ids: string[], catId: string) => Promise<void>
  updateDocument: (id: string, patch: DocumentPatch) => Promise<Document>
  refreshMetadata: (docId: string) => Promise<boolean>
  showToast: (message: string) => void
  clearToast: () => void
  requestDeleteConfirm: (ids: string[], message: string) => void
  confirmDeleteAction: () => Promise<void>
  cancelDelete: () => void
  patchDocument: (id: string, doc: Document) => void
  startImport: (total: number) => void
  updateImportProgress: (payload: ImportProgress) => void
  endImport: () => void
  importFromZotero: () => Promise<void>
  importFromMendeley: () => Promise<void>
  importByIdentifier: (identifier: string) => Promise<string | null>
  init: (listColumnState: ListColumnState | null) => void
  destroy: () => void
  fetchCategories: () => Promise<void>
  createCategory: (name: string) => Promise<Category | null>
  renameCategory: (id: string, name: string) => Promise<void>
  deleteCategory: (id: string) => Promise<void>
  performSearch: (q: string) => void
  loadMoreSearchResults: () => Promise<void>
  clearSearch: () => void
}

const docUpdatedCb: Array<null | ((doc: Document) => void)> = [null]
const importProgressCb: Array<null | ((payload: ImportProgress) => void)> = [null]
const importToastCb: Array<null | ((message: string) => void)> = [null]
const menuExportBibtexCb: Array<null | (() => void)> = [null]
const menuImportZoteroCb: Array<null | (() => void)> = [null]
const menuImportMendeleyCb: Array<null | (() => void)> = [null]
const librarySwitchedCb: Array<null | (() => void)> = [null]

let toastTimeout: ReturnType<typeof setTimeout> | null = null
let searchTimeout: ReturnType<typeof setTimeout> | null = null
let documentRequestVersion = 0
let searchRequestVersion = 0
let documentCountsRequestVersion = 0
let categoriesRequestVersion = 0
let starUpdateGeneration = 0
interface StarUpdateQueue {
  confirmed: boolean
  desired: boolean
  generation: number
  task: Promise<void> | null
}
const starUpdateQueues = new Map<string, StarUpdateQueue>()
const DOCUMENT_PAGE_SIZE = 100

const IDENTIFIER_NETWORK_ERROR_CODES = new Set([
  'arxiv_unreachable',
  'identifier_network_error',
  'network_error',
  'semantic_scholar_unreachable',
  'timeout',
  'unavailable'
])

function ipcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code: unknown }).code
  return typeof code === 'string' ? code : null
}

function findKnownDocument(state: DocumentState, docId: string): Document | undefined {
  return state.documents.find((doc) => doc.id === docId) ??
    state.searchResults.find((doc) => doc.id === docId)
}

function patchStarredValue(documents: Document[], docId: string, starred: boolean): Document[] {
  return documents.map((document) => document.id === docId
    ? { ...document, starred: starred ? 1 : 0 }
    : document)
}

async function runStarUpdateQueue(docId: string, queue: StarUpdateQueue): Promise<void> {
  while (queue.desired !== queue.confirmed) {
    const target = queue.desired
    try {
      await api.documents.setStarred(docId, target)
      if (queue.generation !== starUpdateGeneration) return
      queue.confirmed = target
      void useDocumentStore.getState().fetchDocumentCounts()
    } catch {
      if (queue.generation !== starUpdateGeneration) return
      if (queue.desired === target) {
        queue.desired = queue.confirmed
        useDocumentStore.setState((state) => ({
          documents: patchStarredValue(state.documents, docId, queue.confirmed),
          searchResults: patchStarredValue(state.searchResults, docId, queue.confirmed)
        }))
        useDocumentStore.getState().showToast(i18n.t('documentErrors.starFailed'))
      }
    }
  }
}

function restoreRemovedDocuments(
  current: Document[],
  before: Document[],
  ids: Set<string>
): Document[] {
  const restored = [...current]
  for (const [index, document] of before.entries()) {
    if (!ids.has(document.id) || restored.some((item) => item.id === document.id)) continue
    restored.splice(Math.min(index, restored.length), 0, document)
  }
  return restored
}

function restoreSelection(current: string[], before: string[], ids: Set<string>): string[] {
  const restored = new Set(current)
  for (const id of before) {
    if (ids.has(id)) restored.add(id)
  }
  return [...restored]
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documents: [],
  documentCounts: { all: 0, recentlyRead: 0, recentlyAdded: 0, starred: 0 },
  listMode: { mode: 'all' },
  listColumnState: defaultColumnState(),
  selectedIds: [],
  focusedDocId: null,
  toastMessage: null,
  confirmDelete: null,
  isImporting: false,
  importProgress: null,
  identifierImporting: 0,
  isLoading: false,
  isLoadingMoreDocuments: false,
  hasMoreDocuments: false,
  initialized: false,
  categories: [],
  isSearching: false,
  searchQuery: '',
  searchResults: [],
  isLoadingMoreSearchResults: false,
  hasMoreSearchResults: false,

  fetchDocuments: async (filter?: ListFilter) => {
    const requestVersion = ++documentRequestVersion
    const f = filter ?? get().listMode
    const sort = get().listColumnState.sort
    set({
      isLoading: true,
      isLoadingMoreDocuments: false,
      hasMoreDocuments: false
    })
    try {
      const docs = await api.documents.list({
        ...f,
        sort,
        limit: DOCUMENT_PAGE_SIZE,
        offset: 0
      })
      if (requestVersion === documentRequestVersion) {
        set({ documents: docs, hasMoreDocuments: docs.length === DOCUMENT_PAGE_SIZE })
      }
    } catch (error) {
      if (requestVersion === documentRequestVersion) {
        get().showToast(errorMessage(error, i18n.t('documentErrors.loadFailed')))
      }
      throw error
    } finally {
      if (requestVersion === documentRequestVersion) {
        set({ isLoading: false })
      }
    }
  },

  loadMoreDocuments: async () => {
    const state = get()
    if (
      state.isLoading ||
      state.isLoadingMoreDocuments ||
      !state.hasMoreDocuments ||
      state.isSearching
    ) return
    const requestVersion = documentRequestVersion
    const offset = state.documents.length
    set({ isLoadingMoreDocuments: true })
    try {
      const docs = await api.documents.list({
        ...state.listMode,
        sort: state.listColumnState.sort,
        limit: DOCUMENT_PAGE_SIZE,
        offset
      })
      if (requestVersion !== documentRequestVersion) return
      set((current) => {
        const knownIds = new Set(current.documents.map((document) => document.id))
        return {
          documents: [
            ...current.documents,
            ...docs.filter((document) => !knownIds.has(document.id))
          ],
          hasMoreDocuments: docs.length === DOCUMENT_PAGE_SIZE
        }
      })
    } catch (error) {
      if (requestVersion === documentRequestVersion) {
        get().showToast(errorMessage(error, i18n.t('documentErrors.loadFailed')))
      }
    } finally {
      if (requestVersion === documentRequestVersion) {
        set({ isLoadingMoreDocuments: false })
      }
    }
  },

  fetchDocumentCounts: async () => {
    const requestVersion = ++documentCountsRequestVersion
    try {
      const counts = await api.documents.counts()
      if (requestVersion === documentCountsRequestVersion) {
        set({ documentCounts: counts })
      }
    } catch (error) {
      if (requestVersion === documentCountsRequestVersion) {
        get().showToast(errorMessage(error, i18n.t('documentErrors.countsLoadFailed')))
      }
    }
  },

  setListMode: (filter: ListFilter) => {
    set({ listMode: filter, selectedIds: [], focusedDocId: null })
    void get().fetchDocuments(filter)
  },

  setListColumnState: (state: ListColumnState) => {
    set({ listColumnState: state })
    persistColumnState(state)
  },

  setSort: (field: SortField) => {
    set((s) => {
      const cs = s.listColumnState
      const curSort = cs.sort
      const dir = curSort.field === field && curSort.dir === 'asc' ? 'desc' : 'asc'
      const newState = { ...cs, sort: { field, dir: dir as 'asc' | 'desc' } }
      persistColumnState(newState)
      return { listColumnState: newState }
    })
    void get().fetchDocuments()
  },

  setColumns: (columns: ListColumn[]) => {
    set((s) => {
      const newState = { ...s.listColumnState, columns }
      persistColumnState(newState)
      return { listColumnState: newState }
    })
  },

  flushPendingSettings: flushColumnState,

  setFocusedDoc: (docId: string | null) => {
    set({ focusedDocId: docId })
  },

  toggleSelect: (docId: string) => {
    set((s) => {
      const idx = s.selectedIds.indexOf(docId)
      if (idx === -1) {
        return { selectedIds: [...s.selectedIds, docId] }
      }
      return { selectedIds: s.selectedIds.filter((id) => id !== docId) }
    })
  },

  selectAll: () => {
    set((s) => ({
      selectedIds: (s.isSearching ? s.searchResults : s.documents).map((d) => d.id)
    }))
  },

  clearSelection: () => {
    set({ selectedIds: [] })
  },

  toggleStar: async (docId: string) => {
    const doc = findKnownDocument(get(), docId)
    if (!doc) return
    const newValue = !doc.starred
    set((state) => ({
      documents: patchStarredValue(state.documents, docId, newValue),
      searchResults: patchStarredValue(state.searchResults, docId, newValue)
    }))
    let queue = starUpdateQueues.get(docId)
    if (!queue || queue.generation !== starUpdateGeneration) {
      queue = {
        confirmed: Boolean(doc.starred),
        desired: newValue,
        generation: starUpdateGeneration,
        task: null
      }
      starUpdateQueues.set(docId, queue)
    } else {
      queue.desired = newValue
    }
    if (!queue.task) {
      const activeQueue = queue
      const task = runStarUpdateQueue(docId, activeQueue).finally(() => {
        if (starUpdateQueues.get(docId) === activeQueue) starUpdateQueues.delete(docId)
      })
      activeQueue.task = task
    }
    await queue.task
  },

  openPdf: async (docId: string) => {
    const doc = findKnownDocument(get(), docId)
    if (!doc || doc.fileMissing) return
    try {
      const updated = await openDocumentPdf(docId)
      get().patchDocument(docId, updated)
      void get().fetchDocumentCounts()
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('documentErrors.openPdfFailed')))
    }
  },

  openInFinder: async (docId: string) => {
    try {
      await api.documents.openInFinder(docId)
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('documentErrors.revealFailed')))
    }
  },

  deleteDoc: async (docId: string) => {
    const before = get()
    const doc = findKnownDocument(before, docId)
    if (!doc) return
    set((s) => ({
      documents: s.documents.filter((d) => d.id !== docId),
      searchResults: s.searchResults.filter((d) => d.id !== docId),
      selectedIds: s.selectedIds.filter((id) => id !== docId),
      focusedDocId: s.focusedDocId === docId ? null : s.focusedDocId
    }))
    try {
      await api.documents.delete(docId)
      get().showToast(i18n.t('common.movedToTrash', { count: 1 }))
      void get().fetchCategories()
      void get().fetchDocumentCounts()
    } catch {
      const selected = new Set([docId])
      set((current) => ({
        documents: restoreRemovedDocuments(current.documents, before.documents, selected),
        searchResults: restoreRemovedDocuments(
          current.searchResults,
          before.searchResults,
          selected
        ),
        selectedIds: restoreSelection(current.selectedIds, before.selectedIds, selected),
        focusedDocId: current.focusedDocId === null && before.focusedDocId === docId
          ? docId
          : current.focusedDocId
      }))
      get().showToast(i18n.t('common.deleteFailed'))
    }
  },

  refreshMetadata: async (docId: string) => {
    try {
      const updated = await api.documents.refreshMetadata(docId)
      get().patchDocument(docId, updated)
      return true
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('documentErrors.metadataFailed')))
      return false
    }
  },

  bulkDelete: async (ids: string[]) => {
    const before = get()
    const selected = new Set(ids)
    set((s) => ({
      documents: s.documents.filter((d) => !selected.has(d.id)),
      searchResults: s.searchResults.filter((d) => !selected.has(d.id)),
      selectedIds: [],
      focusedDocId: selected.has(s.focusedDocId ?? '') ? null : s.focusedDocId
    }))
    try {
      await api.documents.bulkDelete(ids)
      get().showToast(i18n.t('common.movedToTrash', { count: ids.length }))
      void get().fetchCategories()
      void get().fetchDocumentCounts()
    } catch {
      set((current) => ({
        documents: restoreRemovedDocuments(current.documents, before.documents, selected),
        searchResults: restoreRemovedDocuments(
          current.searchResults,
          before.searchResults,
          selected
        ),
        selectedIds: restoreSelection(current.selectedIds, before.selectedIds, selected),
        focusedDocId: current.focusedDocId === null &&
          before.focusedDocId !== null &&
          selected.has(before.focusedDocId)
          ? before.focusedDocId
          : current.focusedDocId
      }))
      get().showToast(i18n.t('common.deleteFailed'))
    }
  },

  bulkRefreshMetadata: async (ids: string[]) => {
    const before = get()
    const selected = new Set(ids)
    const markPending = (documents: Document[]) => documents.map((document) =>
      selected.has(document.id) ? { ...document, metadataStatus: 'pending' as const } : document
    )
    set((s) => ({
      documents: markPending(s.documents),
      searchResults: markPending(s.searchResults)
    }))
    try {
      await api.documents.bulkRefreshMetadata(ids)
    } catch (e) {
      const restoreStatuses = (current: Document[], previous: Document[]) => {
        const previousById = new Map(previous.map((document) => [document.id, document]))
        return current.map((document) => {
          const original = previousById.get(document.id)
          return selected.has(document.id) &&
            document.metadataStatus === 'pending' &&
            original
            ? { ...document, metadataStatus: original.metadataStatus }
            : document
        })
      }
      set((current) => ({
        documents: restoreStatuses(current.documents, before.documents),
        searchResults: restoreStatuses(current.searchResults, before.searchResults)
      }))
      get().showToast(errorMessage(e, i18n.t('documentErrors.metadataFailed')))
    }
  },

  bulkCategorize: async (ids: string[], catId: string) => {
    try {
      await api.documents.bulkCategorize(ids, catId)
      get().clearSelection()
      await get().fetchCategories()
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('documentErrors.categorizeFailed')))
    }
  },

  updateDocument: async (id: string, patch: DocumentPatch): Promise<Document> => {
    const updated = await api.documents.update(id, patch)
    get().patchDocument(id, updated)
    return updated
  },

  showToast: (message: string) => {
    if (toastTimeout) clearTimeout(toastTimeout)
    set({ toastMessage: message })
    toastTimeout = setTimeout(() => set({ toastMessage: null }), 4000)
  },

  clearToast: () => {
    if (toastTimeout) clearTimeout(toastTimeout)
    set({ toastMessage: null })
  },

  requestDeleteConfirm: (ids: string[], message: string) => {
    set({ confirmDelete: { ids, message } })
  },

  confirmDeleteAction: async () => {
    const cd = get().confirmDelete
    if (!cd) return
    set({ confirmDelete: null })
    if (cd.ids.length === 1) {
      await get().deleteDoc(cd.ids[0])
    } else {
      await get().bulkDelete(cd.ids)
    }
  },

  cancelDelete: () => {
    set({ confirmDelete: null })
  },

  patchDocument: (id: string, doc: Document) => {
    set((state) => ({
      documents: state.documents.map((d) => (d.id === id ? doc : d)),
      searchResults: state.isSearching
        ? state.searchResults.map((d) => (d.id === id ? doc : d))
        : state.searchResults
    }))
  },

  startImport: (total: number) => {
    set({ isImporting: true, importProgress: { current: 0, total } })
  },

  updateImportProgress: (payload: ImportProgress) => {
    if (payload.current >= payload.total) {
      if (!get().isImporting) return
      set({ importProgress: { current: payload.current, total: payload.total } })
      set({ isImporting: false, importProgress: null })
      void get().fetchDocuments()
      void get().fetchDocumentCounts()
      return
    }
    set({ importProgress: { current: payload.current, total: payload.total } })
  },

  endImport: () => {
    set({ isImporting: false, importProgress: null })
    void get().fetchDocuments()
    void get().fetchDocumentCounts()
  },

  importFromZotero: async () => {
    try {
      const result: BibImportResult = await api.import.fromZotero()
      get().showToast(
        i18n.t('topbar.zoteroImported', {
          added: result.added,
          skipped: result.skipped
        }) as string
      )
      if (result.added > 0 || result.skipped > 0) {
        void get().fetchDocuments()
        void get().fetchDocumentCounts()
      }
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('topbar.importFailed') as string))
    }
  },

  importFromMendeley: async () => {
    try {
      const result: BibImportResult = await api.import.fromMendeley()
      get().showToast(
        i18n.t('topbar.mendeleyImported', {
          added: result.added,
          skipped: result.skipped
        }) as string
      )
      if (result.added > 0 || result.skipped > 0) {
        void get().fetchDocuments()
        void get().fetchDocumentCounts()
      }
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('topbar.importFailed') as string))
    }
  },

  importByIdentifier: async (identifier: string) => {
    set((s) => ({ identifierImporting: s.identifierImporting + 1 }))
    try {
      const result = await api.import.fromIdentifier(identifier)
      if (result.added.length > 0) {
        get().showToast(i18n.t('identifierImport.success') as string)
        return null
      }
      const message =
        result.message ?? i18n.t('identifierImport.failed', { message: '' }) as string
      get().showToast(message)
      return message
    } catch (e) {
      const code = ipcErrorCode(e)
      const message = code && IDENTIFIER_NETWORK_ERROR_CODES.has(code)
        ? i18n.t('identifierImport.networkFailed') as string
        : i18n.t(
          'identifierImport.failed',
          { message: errorMessage(e, '') }
        ) as string
      get().showToast(message)
      return message
    } finally {
      set((s) => ({ identifierImporting: Math.max(0, s.identifierImporting - 1) }))
      void get().fetchDocuments()
      void get().fetchDocumentCounts()
    }
  },

  init: (listColumnState: ListColumnState | null) => {
    if (get().initialized) return
    set({
      initialized: true,
      listColumnState: listColumnState ?? defaultColumnState()
    })

    docUpdatedCb[0] = (doc: Document) => {
      set((state) => {
        return {
          documents: state.documents.map((d) => (d.id === doc.id ? doc : d)),
          searchResults: state.isSearching
            ? state.searchResults.map((d) => (d.id === doc.id ? doc : d))
            : state.searchResults
        }
      })
    }
    api.events.onDocumentUpdated(docUpdatedCb[0])

    importProgressCb[0] = (payload: ImportProgress) => {
      if (!get().isImporting) {
        get().startImport(payload.total)
      }
      get().updateImportProgress(payload)
    }
    api.events.onImportProgress(importProgressCb[0])

    importToastCb[0] = (message: string) => {
      get().showToast(message)
    }
    api.events.onImportToast(importToastCb[0])

    menuExportBibtexCb[0] = () => {
      const ids = get().selectedIds
      if (ids.length === 0) return
      api.export.toBibtex(ids).catch((e: unknown) => {
        get().showToast(errorMessage(e, i18n.t('topbar.exportBibtexFailed') as string))
      })
    }
    api.events.onMenuExportBibtex(menuExportBibtexCb[0])

    menuImportZoteroCb[0] = () => {
      void get().importFromZotero()
    }
    api.events.onMenuImportZotero(menuImportZoteroCb[0])

    menuImportMendeleyCb[0] = () => {
      void get().importFromMendeley()
    }
    api.events.onMenuImportMendeley(menuImportMendeleyCb[0])

    librarySwitchedCb[0] = () => {
      columnPersistenceGeneration += 1
      starUpdateGeneration += 1
      starUpdateQueues.clear()
      if (persistTimeout) clearTimeout(persistTimeout)
      persistTimeout = null
      pendingColumnState = null
      if (searchTimeout) clearTimeout(searchTimeout)
      searchTimeout = null
      documentRequestVersion++
      searchRequestVersion++
      documentCountsRequestVersion++
      categoriesRequestVersion++
      set({
        documents: [],
        documentCounts: { all: 0, recentlyRead: 0, recentlyAdded: 0, starred: 0 },
        listMode: { mode: 'all' },
        selectedIds: [],
        focusedDocId: null,
        confirmDelete: null,
        isImporting: false,
        importProgress: null,
        identifierImporting: 0,
        isLoading: false,
        isLoadingMoreDocuments: false,
        hasMoreDocuments: false,
        categories: [],
        isSearching: false,
        searchQuery: '',
        searchResults: [],
        isLoadingMoreSearchResults: false,
        hasMoreSearchResults: false,
        listColumnState: defaultColumnState()
      })
      const generation = columnPersistenceGeneration
      void Promise.resolve().then(() => {
        if (generation !== columnPersistenceGeneration) return
        void get().fetchDocuments().catch(() => undefined)
        void get().fetchCategories()
        void get().fetchDocumentCounts()
      })
      void api.getBootstrap()
        .then(normalizeBootstrapData)
        .then((bootstrap) => {
          if (generation !== columnPersistenceGeneration) return
          set({ listColumnState: bootstrap.listColumnState ?? defaultColumnState() })
        })
        .catch(() => {
          if (generation !== columnPersistenceGeneration) return
          get().showToast(i18n.t('common.settingsLoadFailed'))
        })
    }
    api.events.onLibrarySwitched(librarySwitchedCb[0])

    void get().fetchDocuments().catch(() => undefined)
    void get().fetchDocumentCounts()
  },

  fetchCategories: async () => {
    const requestVersion = ++categoriesRequestVersion
    try {
      const cats = await api.categories.list()
      if (requestVersion === categoriesRequestVersion) {
        set({ categories: cats })
      }
    } catch (error) {
      if (requestVersion === categoriesRequestVersion) {
        get().showToast(errorMessage(error, i18n.t('documentErrors.categoriesLoadFailed')))
      }
    }
  },

  createCategory: async (name: string): Promise<Category | null> => {
    try {
      const cat = await api.categories.create(name)
      set((s) => ({ categories: [...s.categories, { ...cat, count: 0 }] }))
      return cat
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('documentErrors.categoryCreateFailed')))
      return null
    }
  },

  renameCategory: async (id: string, name: string) => {
    try {
      await api.categories.rename(id, name)
      set((s) => ({
        categories: s.categories.map((c) => (c.id === id ? { ...c, name } : c))
      }))
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('documentErrors.categoryRenameFailed')))
    }
  },

  deleteCategory: async (id: string) => {
    try {
      await api.categories.delete(id)
      set((s) => ({
        categories: s.categories.filter((c) => c.id !== id)
      }))
    } catch (e) {
      get().showToast(errorMessage(e, i18n.t('documentErrors.categoryDeleteFailed')))
    }
  },

  performSearch: (q: string) => {
    const trimmed = q.trim()
    const requestVersion = ++searchRequestVersion
    if (searchTimeout) clearTimeout(searchTimeout)
    if (!trimmed) {
      get().clearSearch()
      return
    }
    set({
      searchQuery: q,
      isSearching: true,
      isLoadingMoreSearchResults: false,
      hasMoreSearchResults: false
    })
    searchTimeout = setTimeout(async () => {
      try {
        const results = await api.documents.search(trimmed, {
          limit: DOCUMENT_PAGE_SIZE,
          offset: 0
        })
        if (
          requestVersion === searchRequestVersion &&
          get().isSearching &&
          get().searchQuery.trim() === trimmed
        ) {
          set({
            searchResults: results,
            hasMoreSearchResults: results.length === DOCUMENT_PAGE_SIZE
          })
        }
      } catch (error) {
        if (requestVersion === searchRequestVersion) {
          set({ searchResults: [] })
          get().showToast(errorMessage(error, i18n.t('documentErrors.searchFailed')))
        }
      }
    }, 200)
  },

  loadMoreSearchResults: async () => {
    const state = get()
    if (
      !state.isSearching ||
      state.isLoadingMoreSearchResults ||
      !state.hasMoreSearchResults
    ) return
    const trimmed = state.searchQuery.trim()
    if (!trimmed) return
    const requestVersion = searchRequestVersion
    const offset = state.searchResults.length
    set({ isLoadingMoreSearchResults: true })
    try {
      const results = await api.documents.search(trimmed, {
        limit: DOCUMENT_PAGE_SIZE,
        offset
      })
      if (
        requestVersion !== searchRequestVersion ||
        !get().isSearching ||
        get().searchQuery.trim() !== trimmed
      ) return
      set((current) => {
        const knownIds = new Set(current.searchResults.map((document) => document.id))
        return {
          searchResults: [
            ...current.searchResults,
            ...results.filter((document) => !knownIds.has(document.id))
          ],
          hasMoreSearchResults: results.length === DOCUMENT_PAGE_SIZE
        }
      })
    } catch (error) {
      if (requestVersion === searchRequestVersion) {
        get().showToast(errorMessage(error, i18n.t('documentErrors.searchFailed')))
      }
    } finally {
      if (requestVersion === searchRequestVersion) {
        set({ isLoadingMoreSearchResults: false })
      }
    }
  },

  clearSearch: () => {
    searchRequestVersion++
    if (searchTimeout) clearTimeout(searchTimeout)
    searchTimeout = null
    set({
      isSearching: false,
      searchQuery: '',
      searchResults: [],
      isLoadingMoreSearchResults: false,
      hasMoreSearchResults: false
    })
    void get().fetchDocuments()
  },

  destroy: () => {
    columnPersistenceGeneration++
    starUpdateGeneration++
    starUpdateQueues.clear()
    documentRequestVersion++
    searchRequestVersion++
    documentCountsRequestVersion++
    categoriesRequestVersion++
    if (persistTimeout) clearTimeout(persistTimeout)
    persistTimeout = null
    pendingColumnState = null
    if (docUpdatedCb[0]) {
      api.events.off('document:updated', docUpdatedCb[0])
      docUpdatedCb[0] = null
    }
    if (importProgressCb[0]) {
      api.events.off('import:progress', importProgressCb[0])
      importProgressCb[0] = null
    }
    if (importToastCb[0]) {
      api.events.off('import:toast', importToastCb[0])
      importToastCb[0] = null
    }
    if (menuExportBibtexCb[0]) {
      api.events.off('menu:export-bibtex', menuExportBibtexCb[0])
      menuExportBibtexCb[0] = null
    }
    if (menuImportZoteroCb[0]) {
      api.events.off('menu:import-zotero', menuImportZoteroCb[0])
      menuImportZoteroCb[0] = null
    }
    if (menuImportMendeleyCb[0]) {
      api.events.off('menu:import-mendeley', menuImportMendeleyCb[0])
      menuImportMendeleyCb[0] = null
    }
    if (librarySwitchedCb[0]) {
      api.events.off('library:switched', librarySwitchedCb[0])
      librarySwitchedCb[0] = null
    }
    if (toastTimeout) clearTimeout(toastTimeout)
    if (searchTimeout) clearTimeout(searchTimeout)
    searchTimeout = null
    set({ initialized: false })
  }
}))
