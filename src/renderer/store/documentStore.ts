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

function persistColumnState(state: ListColumnState): void {
  if (persistTimeout) clearTimeout(persistTimeout)
  persistTimeout = setTimeout(() => {
    api.settings.set('listColumnState', state).catch(() => {})
  }, 500)
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
  initialized: boolean
  categories: Category[]
  isSearching: boolean
  searchQuery: string
  searchResults: Document[]
  fetchDocuments: (filter?: ListFilter) => Promise<void>
  fetchDocumentCounts: () => Promise<void>
  setListMode: (filter: ListFilter) => void
  setListColumnState: (state: ListColumnState) => void
  setSort: (field: SortField) => void
  setColumns: (columns: ListColumn[]) => void
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

function findKnownDocument(state: DocumentState, docId: string): Document | undefined {
  return state.documents.find((doc) => doc.id === docId) ??
    state.searchResults.find((doc) => doc.id === docId)
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
  initialized: false,
  categories: [],
  isSearching: false,
  searchQuery: '',
  searchResults: [],

  fetchDocuments: async (filter?: ListFilter) => {
    const requestVersion = ++documentRequestVersion
    const f = filter ?? get().listMode
    const sort = get().listColumnState.sort
    set({ isLoading: true })
    try {
      const docs = await api.documents.list({ ...f, sort })
      if (requestVersion === documentRequestVersion) {
        set({ documents: docs })
      }
    } catch (error) {
      if (requestVersion === documentRequestVersion) {
        get().showToast(errorMessage(error, 'Failed to load documents'))
      }
      throw error
    } finally {
      if (requestVersion === documentRequestVersion) {
        set({ isLoading: false })
      }
    }
  },

  fetchDocumentCounts: async () => {
    try {
      const counts = await api.documents.counts()
      set({ documentCounts: counts })
    } catch {
      void 0
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
    get().patchDocument(docId, { ...doc, starred: newValue ? 1 : 0 })
    try {
      await api.documents.setStarred(docId, newValue)
      void get().fetchDocumentCounts()
    } catch {
      get().patchDocument(docId, doc)
      get().showToast('Failed to update star')
    }
  },

  openPdf: async (docId: string) => {
    const doc = findKnownDocument(get(), docId)
    if (!doc || doc.fileMissing) return
    try {
      const updated = await openDocumentPdf(docId)
      get().patchDocument(docId, updated)
      void get().fetchDocumentCounts()
    } catch (e) {
      get().showToast(errorMessage(e, 'Failed to open PDF'))
    }
  },

  openInFinder: async (docId: string) => {
    try {
      await api.documents.openInFinder(docId)
    } catch (e) {
      get().showToast(errorMessage(e, 'Failed to open in Finder'))
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
      set((s) => ({
        documents: before.documents.some((item) => item.id === docId)
          ? before.documents
          : s.documents,
        searchResults: before.searchResults.some((item) => item.id === docId)
          ? before.searchResults
          : s.searchResults
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
      get().showToast(errorMessage(e, 'Failed to refresh metadata'))
      return false
    }
  },

  bulkDelete: async (ids: string[]) => {
    const before = get()
    set((s) => ({
      documents: s.documents.filter((d) => !ids.includes(d.id)),
      searchResults: s.searchResults.filter((d) => !ids.includes(d.id)),
      selectedIds: [],
      focusedDocId: ids.includes(s.focusedDocId ?? '') ? null : s.focusedDocId
    }))
    try {
      await api.documents.bulkDelete(ids)
      get().showToast(i18n.t('common.movedToTrash', { count: ids.length }))
      void get().fetchCategories()
      void get().fetchDocumentCounts()
    } catch {
      set({ documents: before.documents, searchResults: before.searchResults })
      get().showToast(i18n.t('common.deleteFailed'))
    }
  },

  bulkRefreshMetadata: async (ids: string[]) => {
    set((s) => ({
      documents: s.documents.map((d) =>
        ids.includes(d.id) ? { ...d, metadataStatus: 'pending' } : d
      )
    }))
    try {
      await api.documents.bulkRefreshMetadata(ids)
    } catch (e) {
      get().showToast(errorMessage(e, 'Failed to refresh metadata'))
    }
  },

  bulkCategorize: async (ids: string[], catId: string) => {
    try {
      await api.documents.bulkCategorize(ids, catId)
      get().clearSelection()
      await get().fetchCategories()
    } catch (e) {
      get().showToast(errorMessage(e, 'Failed to categorize'))
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
      const message = i18n.t(
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
      void api.export.toBibtex(ids)
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
      searchRequestVersion++
      set({
        selectedIds: [],
        focusedDocId: null,
        isSearching: false,
        searchQuery: '',
        searchResults: []
      })
      void get().fetchDocuments()
      void get().fetchCategories()
      void get().fetchDocumentCounts()
    }
    api.events.onLibrarySwitched(librarySwitchedCb[0])

    void get().fetchDocuments()
    void get().fetchDocumentCounts()
  },

  fetchCategories: async () => {
    try {
      const cats = await api.categories.list()
      set({ categories: cats })
    } catch {
      void 0
    }
  },

  createCategory: async (name: string): Promise<Category | null> => {
    try {
      const cat = await api.categories.create(name)
      set((s) => ({ categories: [...s.categories, { ...cat, count: 0 }] }))
      return cat
    } catch (e) {
      get().showToast(errorMessage(e, 'Failed to create category'))
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
      get().showToast(errorMessage(e, 'Failed to rename category'))
    }
  },

  deleteCategory: async (id: string) => {
    try {
      await api.categories.delete(id)
      set((s) => ({
        categories: s.categories.filter((c) => c.id !== id)
      }))
    } catch (e) {
      get().showToast(errorMessage(e, 'Failed to delete category'))
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
    set({ searchQuery: q, isSearching: true })
    searchTimeout = setTimeout(async () => {
      try {
        const results = await api.documents.search(trimmed)
        if (
          requestVersion === searchRequestVersion &&
          get().isSearching &&
          get().searchQuery.trim() === trimmed
        ) {
          set({ searchResults: results })
        }
      } catch {
        if (requestVersion === searchRequestVersion) {
          set({ searchResults: [] })
        }
      }
    }, 200)
  },

  clearSearch: () => {
    searchRequestVersion++
    if (searchTimeout) clearTimeout(searchTimeout)
    searchTimeout = null
    set({ isSearching: false, searchQuery: '', searchResults: [] })
    void get().fetchDocuments()
  },

  destroy: () => {
    documentRequestVersion++
    searchRequestVersion++
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
