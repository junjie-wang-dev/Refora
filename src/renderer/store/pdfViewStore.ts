import { create } from 'zustand'
import { api } from '../ipc'
import { scheduleRendererSetting } from '../persistence'

export interface PdfReadingPosition {
  page: number
  x: number
  y: number
}

export interface PdfReadingView extends PdfReadingPosition {
  scale: number
  rotation: number
  zoomMode: 'custom' | 'width'
}

export interface PdfBookmark extends PdfReadingPosition {
  id: string
  title: string
}

interface PdfDocumentView {
  view: PdfReadingView
  bookmarks: PdfBookmark[]
}

interface PdfViewState {
  documents: Record<string, PdfDocumentView>
  loadStatus: Record<string, 'loading' | 'loaded' | 'error'>
  saveStatus: Record<string, 'saving' | 'saved' | 'error'>
  load: (documentId: string) => Promise<PdfDocumentView>
  updateView: (documentId: string, view: PdfReadingView) => void
  addBookmark: (documentId: string, position: PdfReadingPosition, title: string) => void
  renameBookmark: (documentId: string, id: string, title: string) => void
  removeBookmark: (documentId: string, id: string) => void
  retrySave: (documentId: string) => void
  reset: () => void
}

export const DEFAULT_PDF_VIEW: PdfReadingView = {
  page: 1, x: 0, y: 0, scale: 1.15, rotation: 0, zoomMode: 'custom'
}

let generation = 0
const loads = new Map<string, Promise<PdfDocumentView>>()

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function position(value: Partial<PdfReadingPosition>): PdfReadingPosition {
  return {
    page: Math.max(1, Math.floor(finite(value.page, 1))),
    x: Math.max(-2, Math.min(2, finite(value.x, 0))),
    y: Math.max(-2, Math.min(2, finite(value.y, 0)))
  }
}

function normalize(value: unknown): PdfDocumentView {
  const data = value && typeof value === 'object' ? value as Partial<PdfDocumentView> : {}
  const view = data.view && typeof data.view === 'object' ? data.view : DEFAULT_PDF_VIEW
  const ids = new Set<string>()
  return {
    view: {
      ...position(view),
      scale: Math.max(view.zoomMode === 'width' ? 0.01 : 0.25, Math.min(5, finite(view.scale, 1.15))),
      rotation: ((Math.round(finite(view.rotation, 0) / 90) * 90) % 360 + 360) % 360,
      zoomMode: view.zoomMode === 'width' ? 'width' : 'custom'
    },
    bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks.flatMap((bookmark) => {
      if (!bookmark || typeof bookmark.id !== 'string' || typeof bookmark.title !== 'string' ||
        ids.has(bookmark.id)) return []
      ids.add(bookmark.id)
      return [{ ...position(bookmark), id: bookmark.id, title: bookmark.title.slice(0, 500) }]
    }) : []
  }
}

function persist(documentId: string): void {
  const state = usePdfViewStore.getState()
  const data = state.documents[documentId]
  if (!data || state.loadStatus[documentId] !== 'loaded') return
  const currentGeneration = generation
  usePdfViewStore.setState((current) => ({
    saveStatus: { ...current.saveStatus, [documentId]: current.saveStatus[documentId] === 'error' ? 'error' : 'saving' }
  }))
  const status = (value: 'saved' | 'error') => {
    if (generation !== currentGeneration || usePdfViewStore.getState().documents[documentId] !== data) return
    usePdfViewStore.setState((current) => ({
      saveStatus: { ...current.saveStatus, [documentId]: value }
    }))
  }
  scheduleRendererSetting(`pdfReader.document.${documentId}`, data, {
    delay: 400,
    onSuccess: () => status('saved'),
    onError: () => status('error')
  })
}

export const usePdfViewStore = create<PdfViewState>((set, get) => ({
  documents: {}, loadStatus: {}, saveStatus: {},
  load: async (documentId) => {
    if (get().documents[documentId]) return get().documents[documentId]
    const existing = loads.get(documentId)
    if (existing) return existing
    const currentGeneration = generation
    set((state) => ({ loadStatus: { ...state.loadStatus, [documentId]: 'loading' } }))
    const task = api.settings.get(`pdfReader.document.${documentId}`, null)
      .then((saved) => {
        const data = normalize(saved)
        if (generation === currentGeneration) {
          set((state) => ({
            documents: { ...state.documents, [documentId]: data },
            loadStatus: { ...state.loadStatus, [documentId]: 'loaded' },
            saveStatus: { ...state.saveStatus, [documentId]: 'saved' }
          }))
        }
        return data
      }).catch((error) => {
        if (generation === currentGeneration) {
          set((state) => ({ loadStatus: { ...state.loadStatus, [documentId]: 'error' } }))
        }
        throw error
      }).finally(() => {
        if (loads.get(documentId) === task) loads.delete(documentId)
      })
    loads.set(documentId, task)
    return task
  },
  updateView: (documentId, view) => {
    const data = get().documents[documentId]
    if (!data || JSON.stringify(data.view) === JSON.stringify(view)) return
    set((state) => ({ documents: {
      ...state.documents, [documentId]: { ...data, view: normalize({ view }).view }
    } }))
    persist(documentId)
  },
  addBookmark: (documentId, point, title) => {
    const data = get().documents[documentId]
    if (!data) return
    const bookmark = { ...position(point), id: crypto.randomUUID(), title: title.trim().slice(0, 500) }
    set((state) => ({ documents: {
      ...state.documents, [documentId]: { ...data, bookmarks: [...data.bookmarks, bookmark] }
    } }))
    persist(documentId)
  },
  renameBookmark: (documentId, id, title) => {
    const data = get().documents[documentId]
    if (!data || !title.trim()) return
    set((state) => ({ documents: {
      ...state.documents,
      [documentId]: { ...data, bookmarks: data.bookmarks.map((bookmark) =>
        bookmark.id === id ? { ...bookmark, title: title.trim().slice(0, 500) } : bookmark
      ) }
    } }))
    persist(documentId)
  },
  removeBookmark: (documentId, id) => {
    const data = get().documents[documentId]
    if (!data) return
    set((state) => ({ documents: {
      ...state.documents,
      [documentId]: { ...data, bookmarks: data.bookmarks.filter((bookmark) => bookmark.id !== id) }
    } }))
    persist(documentId)
  },
  retrySave: persist,
  reset: () => {
    generation += 1
    loads.clear()
    set({ documents: {}, loadStatus: {}, saveStatus: {} })
  }
}))
