import { create } from 'zustand'
import type {
  Document,
  PdfAnnotation,
  PdfAnnotationKind,
  PdfAnnotationPoint,
  PdfAnnotationRect
} from '../../shared/ipc-types'
import { api } from '../ipc'

export type { PdfAnnotation, PdfAnnotationKind }
export type PdfRect = PdfAnnotationRect
export type PdfPoint = PdfAnnotationPoint

export type PdfAnnotationDraft = Omit<PdfAnnotation, 'id' | 'createdAt'>

export type PdfTool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'note'
  | 'text'
  | 'ink'
  | 'eraser'

export type PdfAnnotationSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface PdfAnnotationDeletion {
  documentId: string
  annotations: Array<{
    annotation: PdfAnnotation
    index: number
  }>
}

interface PdfReaderState {
  tabs: Document[]
  activeDocumentId: string | null
  annotations: Record<string, PdfAnnotation[]>
  saveStatus: Record<string, PdfAnnotationSaveStatus>
  tool: PdfTool | null
  color: string
  fontSize: number
  strokeWidth: number
  sidebarOpen: boolean
  selectedAnnotationId: string | null
  selectedAnnotationIds: string[]
  pendingCommentFocusId: string | null
  lastDeletion: PdfAnnotationDeletion | null
  open: (document: Document) => Promise<void>
  close: (documentId: string) => void
  closeAll: () => void
  activate: (documentId: string) => void
  setTool: (tool: PdfTool | null) => void
  setColor: (color: string) => void
  setFontSize: (fontSize: number) => void
  setStrokeWidth: (strokeWidth: number) => void
  toggleSidebar: () => void
  selectAnnotation: (id: string | null) => void
  selectAnnotations: (ids: string[]) => void
  addAnnotation: (documentId: string, annotation: PdfAnnotationDraft) => PdfAnnotation
  updateAnnotation: (
    documentId: string,
    annotationId: string,
    patch: Partial<Pick<
      PdfAnnotation,
      'comment' | 'color' | 'text' | 'fontSize' | 'strokeWidth'
    >>
  ) => void
  removeAnnotation: (documentId: string, annotationId: string) => void
  removeAnnotations: (documentId: string, annotationIds: string[]) => void
  consumeCommentFocus: () => void
  retrySave: (documentId: string) => void
  undoLastDeletion: () => void
  clearLastDeletion: () => void
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const persistVersions = new Map<string, number>()

function isAnnotation(value: unknown): value is PdfAnnotation {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PdfAnnotation>
  return typeof item.id === 'string' &&
    ['highlight', 'underline', 'strikeout', 'note', 'text', 'ink'].includes(item.kind ?? '') &&
    typeof item.page === 'number' &&
    item.page >= 1 &&
    typeof item.color === 'string' &&
    typeof item.text === 'string' &&
    typeof item.comment === 'string' &&
    typeof item.createdAt === 'number'
}

function persist(documentId: string, annotations: PdfAnnotation[]): void {
  const existing = persistTimers.get(documentId)
  if (existing) clearTimeout(existing)
  const version = (persistVersions.get(documentId) ?? 0) + 1
  persistVersions.set(documentId, version)
  usePdfReaderStore.setState((state) => ({
    saveStatus: { ...state.saveStatus, [documentId]: 'saving' }
  }))
  persistTimers.set(documentId, setTimeout(() => {
    persistTimers.delete(documentId)
    void api.documents.setPdfAnnotations(documentId, annotations)
      .then(() => {
        if (persistVersions.get(documentId) !== version) return
        usePdfReaderStore.setState((state) => ({
          saveStatus: { ...state.saveStatus, [documentId]: 'saved' }
        }))
      })
      .catch(() => {
        if (persistVersions.get(documentId) !== version) return
        usePdfReaderStore.setState((state) => ({
          saveStatus: { ...state.saveStatus, [documentId]: 'error' }
        }))
      })
  }, 250))
}

function createAnnotationId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const usePdfReaderStore = create<PdfReaderState>((set, get) => ({
  tabs: [],
  activeDocumentId: null,
  annotations: {},
  saveStatus: {},
  tool: null,
  color: '#f2c94c',
  fontSize: 14,
  strokeWidth: 2,
  sidebarOpen: true,
  selectedAnnotationId: null,
  selectedAnnotationIds: [],
  pendingCommentFocusId: null,
  lastDeletion: null,

  open: async (document) => {
    const alreadyLoaded = Object.hasOwn(get().annotations, document.id)
    set((state) => ({
      tabs: state.tabs.some((tab) => tab.id === document.id)
        ? state.tabs.map((tab) => tab.id === document.id ? document : tab)
        : [...state.tabs, document],
      activeDocumentId: document.id,
      selectedAnnotationId: null,
      selectedAnnotationIds: [],
      pendingCommentFocusId: null
    }))
    if (alreadyLoaded) return
    try {
      const saved = await api.documents.pdfAnnotations(document.id)
      const annotations = Array.isArray(saved) ? saved.filter(isAnnotation) : []
      set((state) => ({
        annotations: Object.hasOwn(state.annotations, document.id)
          ? state.annotations
          : { ...state.annotations, [document.id]: annotations },
        saveStatus: { ...state.saveStatus, [document.id]: 'saved' }
      }))
    } catch {
      set((state) => ({
        annotations: Object.hasOwn(state.annotations, document.id)
          ? state.annotations
          : { ...state.annotations, [document.id]: [] },
        saveStatus: { ...state.saveStatus, [document.id]: 'error' }
      }))
    }
  },

  close: (documentId) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === documentId)
      const tabs = state.tabs.filter((tab) => tab.id !== documentId)
      const activeDocumentId = state.activeDocumentId === documentId
        ? tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id ?? null
        : state.activeDocumentId
      return {
        tabs,
        activeDocumentId,
        selectedAnnotationId: null,
        selectedAnnotationIds: [],
        pendingCommentFocusId: null
      }
    })
  },

  closeAll: () => set({
    tabs: [],
    activeDocumentId: null,
    selectedAnnotationId: null,
    selectedAnnotationIds: [],
    pendingCommentFocusId: null
  }),

  activate: (documentId) => set({
    activeDocumentId: documentId,
    selectedAnnotationId: null,
    selectedAnnotationIds: [],
    pendingCommentFocusId: null
  }),

  setTool: (tool) => set((state) => ({
    tool,
    selectedAnnotationId: tool === 'select' ? state.selectedAnnotationId : null,
    selectedAnnotationIds: tool === 'select' ? state.selectedAnnotationIds : []
  })),
  setColor: (color) => set({ color }),
  setFontSize: (fontSize) => set({
    fontSize: Math.max(8, Math.min(72, fontSize))
  }),
  setStrokeWidth: (strokeWidth) => set({
    strokeWidth: Math.max(1, Math.min(12, strokeWidth))
  }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  selectAnnotation: (id) => set({
    selectedAnnotationId: id,
    selectedAnnotationIds: id ? [id] : []
  }),
  selectAnnotations: (ids) => set({
    selectedAnnotationId: ids.at(-1) ?? null,
    selectedAnnotationIds: ids
  }),

  addAnnotation: (documentId, draft) => {
    const annotation: PdfAnnotation = {
      ...draft,
      id: createAnnotationId(),
      createdAt: Date.now()
    }
    const annotations = [...(get().annotations[documentId] ?? []), annotation]
    set((state) => ({
      annotations: { ...state.annotations, [documentId]: annotations },
      selectedAnnotationId: null,
      selectedAnnotationIds: [],
      sidebarOpen: true,
      pendingCommentFocusId: annotation.kind === 'note' ? annotation.id : null,
      lastDeletion: null
    }))
    persist(documentId, annotations)
    return annotation
  },

  updateAnnotation: (documentId, annotationId, patch) => {
    const annotations = (get().annotations[documentId] ?? []).map((annotation) =>
      annotation.id === annotationId ? { ...annotation, ...patch } : annotation
    )
    set((state) => ({
      annotations: { ...state.annotations, [documentId]: annotations }
    }))
    persist(documentId, annotations)
  },

  removeAnnotation: (documentId, annotationId) => {
    get().removeAnnotations(documentId, [annotationId])
  },

  removeAnnotations: (documentId, annotationIds) => {
    const ids = new Set(annotationIds)
    const currentAnnotations = get().annotations[documentId] ?? []
    const deleted = currentAnnotations.flatMap((annotation, index) =>
      ids.has(annotation.id) ? [{ annotation, index }] : []
    )
    if (deleted.length === 0) return
    const annotations = currentAnnotations.filter((annotation) => !ids.has(annotation.id))
    set((state) => {
      const selectedAnnotationIds = state.selectedAnnotationIds.filter(
        (id) => !ids.has(id)
      )
      return {
        annotations: { ...state.annotations, [documentId]: annotations },
        selectedAnnotationId: selectedAnnotationIds.at(-1) ?? null,
        selectedAnnotationIds,
        pendingCommentFocusId: ids.has(state.pendingCommentFocusId ?? '')
          ? null
          : state.pendingCommentFocusId,
        lastDeletion: { documentId, annotations: deleted }
      }
    })
    persist(documentId, annotations)
  },

  consumeCommentFocus: () => set({ pendingCommentFocusId: null }),

  retrySave: (documentId) => {
    persist(documentId, get().annotations[documentId] ?? [])
  },

  undoLastDeletion: () => {
    const deletion = get().lastDeletion
    if (!deletion) return
    const current = [...(get().annotations[deletion.documentId] ?? [])]
    deletion.annotations
      .slice()
      .sort((first, second) => first.index - second.index)
      .forEach(({ annotation, index }) => {
        current.splice(Math.min(index, current.length), 0, annotation)
      })
    const restoredIds = deletion.annotations.map(({ annotation }) => annotation.id)
    set((state) => ({
      annotations: { ...state.annotations, [deletion.documentId]: current },
      activeDocumentId: deletion.documentId,
      selectedAnnotationId: restoredIds.at(-1) ?? null,
      selectedAnnotationIds: restoredIds,
      sidebarOpen: true,
      tool: 'select',
      lastDeletion: null
    }))
    persist(deletion.documentId, current)
  },

  clearLastDeletion: () => set({ lastDeletion: null })
}))
