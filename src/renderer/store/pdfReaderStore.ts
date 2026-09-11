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
type PdfAnnotationPatch = Partial<Pick<
  PdfAnnotation,
  | 'comment'
  | 'color'
  | 'text'
  | 'fontSize'
  | 'strokeWidth'
  | 'point'
  | 'size'
  | 'points'
  | 'rects'
>>

export type PdfTool =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'note'
  | 'text'
  | 'ink'
  | 'eraser'

export type PdfAnnotationSaveStatus = 'idle' | 'saving' | 'saved' | 'error'
export type PdfAnnotationLoadStatus = 'idle' | 'loading' | 'loaded' | 'error'

export interface PdfNavigationTarget {
  page?: number
  search?: string
}

interface PdfNavigationRequest extends PdfNavigationTarget {
  documentId: string
}

interface PdfAnnotationHistory {
  past: PdfAnnotation[][]
  future: PdfAnnotation[][]
}

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
  loadStatus: Record<string, PdfAnnotationLoadStatus>
  saveStatus: Record<string, PdfAnnotationSaveStatus>
  annotationHistory: Record<string, PdfAnnotationHistory>
  tool: PdfTool | null
  toolColors: Record<PdfAnnotationKind, string>
  fontSize: number
  strokeWidth: number
  sidebarOpen: boolean
  selectedAnnotationId: string | null
  selectedAnnotationIds: string[]
  textEditor: { documentId: string; annotationId: string } | null
  pendingCommentFocusId: string | null
  lastDeletion: PdfAnnotationDeletion | null
  navigationRequest: PdfNavigationRequest | null
  open: (document: Document, target?: PdfNavigationTarget) => Promise<void>
  consumeNavigationRequest: (request: PdfNavigationRequest) => void
  close: (documentId: string) => void
  closeAll: () => void
  activate: (documentId: string) => void
  setTool: (tool: PdfTool | null) => void
  setColor: (color: string, tool: PdfAnnotationKind) => void
  setFontSize: (fontSize: number) => void
  setStrokeWidth: (strokeWidth: number) => void
  toggleSidebar: () => void
  selectAnnotation: (id: string | null) => void
  selectAnnotations: (ids: string[]) => void
  startTextEditing: (documentId: string, annotationId: string, continueHistory?: boolean) => void
  finishTextEditing: (documentId?: string, annotationId?: string) => void
  addAnnotation: (documentId: string, annotation: PdfAnnotationDraft) => PdfAnnotation | null
  updateAnnotation: (
    documentId: string,
    annotationId: string,
    patch: PdfAnnotationPatch
  ) => void
  updateAnnotations: (
    documentId: string,
    annotationIds: string[],
    patch: PdfAnnotationPatch
  ) => void
  removeAnnotation: (documentId: string, annotationId: string) => void
  removeAnnotations: (documentId: string, annotationIds: string[]) => void
  consumeCommentFocus: () => void
  retryLoad: (documentId: string) => Promise<void>
  retrySave: (documentId: string) => void
  undo: (documentId: string) => void
  redo: (documentId: string) => void
  beginHistoryGroup: (documentId: string) => void
  endHistoryGroup: (documentId: string) => void
  undoLastDeletion: () => void
  clearLastDeletion: () => void
  flushPendingSaves: () => Promise<void>
  resetForLibrarySwitch: () => void
}

interface AnnotationSnapshot {
  annotations: PdfAnnotation[]
  version: number
}

interface AnnotationPersistQueue {
  active: boolean
  failed: (AnnotationSnapshot & { error: unknown }) | null
  pending: AnnotationSnapshot | null
  running: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  version: number
}

const persistQueues = new Map<string, AnnotationPersistQueue>()
const disposeAfterPersist = new Set<string>()
const annotationLoadVersions = new Map<string, number>()
const historyGroups = new Map<string, {
  before: PdfAnnotation[]
  recorded: boolean
  previousHistory: PdfAnnotationHistory
}>()
const HISTORY_LIMIT = 100
let libraryGeneration = 0
let nextAnnotationLoadRequest = 0

function nextAnnotationLoadVersion(documentId: string): number {
  const version = ++nextAnnotationLoadRequest
  annotationLoadVersions.set(documentId, version)
  return version
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(record, key)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function clearDocumentCache(documentId: string): void {
  historyGroups.delete(documentId)
  usePdfReaderStore.setState((state) => ({
    annotations: withoutKey(state.annotations, documentId),
    loadStatus: withoutKey(state.loadStatus, documentId),
    saveStatus: withoutKey(state.saveStatus, documentId),
    annotationHistory: withoutKey(state.annotationHistory, documentId),
    textEditor: state.textEditor?.documentId === documentId ? null : state.textEditor,
    lastDeletion: state.lastDeletion?.documentId === documentId ? null : state.lastDeletion
  }))
}

function recordHistory(documentId: string): void {
  const state = usePdfReaderStore.getState()
  const group = historyGroups.get(documentId)
  if (group?.recorded) return
  if (group) group.recorded = true
  const history = state.annotationHistory[documentId] ?? { past: [], future: [] }
  usePdfReaderStore.setState({
    annotationHistory: {
      ...state.annotationHistory,
      [documentId]: {
        past: [...history.past, state.annotations[documentId] ?? []].slice(-HISTORY_LIMIT),
        future: []
      }
    }
  })
}

function endHistoryGroup(documentId: string): void {
  const group = historyGroups.get(documentId)
  historyGroups.delete(documentId)
  if (!group?.recorded) return
  const state = usePdfReaderStore.getState()
  const history = state.annotationHistory[documentId]
  if (
    !history ||
    history.past.at(-1) !== group.before ||
    JSON.stringify(group.before) !== JSON.stringify(state.annotations[documentId])
  ) return
  usePdfReaderStore.setState({
    annotationHistory: {
      ...state.annotationHistory,
      [documentId]: group.previousHistory
    }
  })
}

function applyHistory(documentId: string, direction: 'undo' | 'redo'): void {
  usePdfReaderStore.getState().finishTextEditing(documentId)
  endHistoryGroup(documentId)
  const state = usePdfReaderStore.getState()
  const history = state.annotationHistory[documentId]
  const current = state.annotations[documentId]
  if (!history || !current) return
  const annotations = (direction === 'undo' ? history.past : history.future).at(-1)
  if (!annotations) return
  const previousIds = new Set(current.map((annotation) => annotation.id))
  const restoredIds = annotations.filter((annotation) => !previousIds.has(annotation.id))
    .map((annotation) => annotation.id)
  usePdfReaderStore.setState({
    annotations: { ...state.annotations, [documentId]: annotations },
    annotationHistory: {
      ...state.annotationHistory,
      [documentId]: direction === 'undo'
        ? {
            past: history.past.slice(0, -1),
            future: [...history.future, current].slice(-HISTORY_LIMIT)
          }
        : {
            past: [...history.past, current].slice(-HISTORY_LIMIT),
            future: history.future.slice(0, -1)
          }
    },
    selectedAnnotationId: restoredIds.at(-1) ?? null,
    selectedAnnotationIds: restoredIds,
    pendingCommentFocusId: null,
    lastDeletion: null
  })
  persist(documentId, annotations)
}

function finishPersistQueue(documentId: string, queue: AnnotationPersistQueue): void {
  if (queue.timer || queue.pending || queue.running || queue.failed) return
  if (persistQueues.get(documentId) === queue) {
    queue.active = false
    persistQueues.delete(documentId)
  }
  if (disposeAfterPersist.delete(documentId)) clearDocumentCache(documentId)
}

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

function persistQueue(documentId: string): AnnotationPersistQueue {
  const existing = persistQueues.get(documentId)
  if (existing) return existing
  const queue: AnnotationPersistQueue = {
    active: true,
    failed: null,
    pending: null,
    running: null,
    timer: null,
    version: 0
  }
  persistQueues.set(documentId, queue)
  return queue
}

function startPersist(documentId: string, queue: AnnotationPersistQueue): Promise<void> | null {
  if (!queue.active || persistQueues.get(documentId) !== queue) return null
  if (queue.running || !queue.pending) return queue.running
  const snapshot = queue.pending
  queue.pending = null
  const generation = libraryGeneration
  const task = api.documents.setPdfAnnotations(documentId, snapshot.annotations)
    .then(() => {
      if (generation !== libraryGeneration) return
      queue.failed = null
      if (!queue.pending && queue.version === snapshot.version) {
        usePdfReaderStore.setState((state) => ({
          saveStatus: { ...state.saveStatus, [documentId]: 'saved' }
        }))
      }
    })
    .catch((error) => {
      if (generation === libraryGeneration && !queue.pending && queue.version === snapshot.version) {
        queue.failed = { ...snapshot, error }
        usePdfReaderStore.setState((state) => ({
          saveStatus: { ...state.saveStatus, [documentId]: 'error' }
        }))
      }
      throw error
    })
    .finally(() => {
      if (queue.running === task) queue.running = null
      if (
        generation === libraryGeneration &&
        queue.active &&
        persistQueues.get(documentId) === queue &&
        queue.pending
      ) {
        void startPersist(documentId, queue)?.catch(() => undefined)
      } else {
        finishPersistQueue(documentId, queue)
      }
    })
  queue.running = task
  return task
}

function persist(documentId: string, annotations: PdfAnnotation[]): void {
  const queue = persistQueue(documentId)
  if (queue.timer) clearTimeout(queue.timer)
  queue.version += 1
  queue.pending = { annotations, version: queue.version }
  queue.failed = null
  usePdfReaderStore.setState((state) => ({
    saveStatus: { ...state.saveStatus, [documentId]: state.saveStatus[documentId] === 'error' ? 'error' : 'saving' }
  }))
  queue.timer = setTimeout(() => {
    queue.timer = null
    void startPersist(documentId, queue)?.catch(() => undefined)
  }, 250)
}

async function flushPersistQueue(
  documentId: string,
  queue: AnnotationPersistQueue
): Promise<void> {
  if (queue.timer) {
    clearTimeout(queue.timer)
    queue.timer = null
  }
  if (queue.failed && !queue.pending) {
    queue.pending = {
      annotations: queue.failed.annotations,
      version: queue.failed.version
    }
    queue.failed = null
    usePdfReaderStore.setState((state) => ({
      saveStatus: { ...state.saveStatus, [documentId]: state.saveStatus[documentId] === 'error' ? 'error' : 'saving' }
    }))
  }
  while (true) {
    const task = queue.running ?? startPersist(documentId, queue)
    if (task) await task.catch(() => undefined)
    if (queue.pending || queue.running) continue
    if (queue.failed) throw queue.failed.error
    return
  }
}

async function flushPendingSaves(): Promise<void> {
  while (true) {
    const pending = [...persistQueues].filter(([, queue]) =>
      queue.active && Boolean(queue.timer || queue.pending || queue.running || queue.failed)
    )
    if (pending.length === 0) return
    const results = await Promise.allSettled(
      pending.map(([documentId, queue]) => flushPersistQueue(documentId, queue))
    )
    const failure = results.find((result): result is PromiseRejectedResult =>
      result.status === 'rejected'
    )
    if (failure) throw failure.reason
  }
}

function resetForLibrarySwitch(): void {
  libraryGeneration += 1
  for (const queue of persistQueues.values()) {
    if (queue.timer) clearTimeout(queue.timer)
    queue.active = false
    queue.failed = null
    queue.pending = null
    queue.timer = null
  }
  persistQueues.clear()
  disposeAfterPersist.clear()
  annotationLoadVersions.clear()
  historyGroups.clear()
  nextAnnotationLoadRequest = 0
  usePdfReaderStore.setState({
    tabs: [],
    activeDocumentId: null,
    annotations: {},
    loadStatus: {},
    saveStatus: {},
    annotationHistory: {},
    tool: null,
    sidebarOpen: false,
    selectedAnnotationId: null,
    selectedAnnotationIds: [],
    textEditor: null,
    pendingCommentFocusId: null,
    navigationRequest: null,
    lastDeletion: null
  })
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
  loadStatus: {},
  saveStatus: {},
  annotationHistory: {},
  tool: null,
  toolColors: {
    highlight: '#f2c94c',
    underline: '#f2c94c',
    strikeout: '#f2c94c',
    note: '#f2c94c',
    text: '#f2c94c',
    ink: '#f2c94c'
  },
  fontSize: 14,
  strokeWidth: 2,
  sidebarOpen: false,
  selectedAnnotationId: null,
  selectedAnnotationIds: [],
  textEditor: null,
  pendingCommentFocusId: null,
  lastDeletion: null,
  navigationRequest: null,

  open: async (document, target) => {
    get().finishTextEditing()
    const previousDocumentId = get().activeDocumentId
    if (previousDocumentId && previousDocumentId !== document.id) {
      endHistoryGroup(previousDocumentId)
    }
    const generation = libraryGeneration
    disposeAfterPersist.delete(document.id)
    const alreadyLoaded = Object.hasOwn(get().annotations, document.id)
    const alreadyLoading = get().loadStatus[document.id] === 'loading'
    set((state) => ({
      tabs: state.tabs.some((tab) => tab.id === document.id)
        ? state.tabs.map((tab) => tab.id === document.id ? document : tab)
        : [...state.tabs, document],
      activeDocumentId: document.id,
      navigationRequest: target ? { ...target, documentId: document.id } : null,
      selectedAnnotationId: null,
      selectedAnnotationIds: [],
      pendingCommentFocusId: null
    }))
    if (alreadyLoaded || alreadyLoading) return
    const loadVersion = nextAnnotationLoadVersion(document.id)
    set((state) => ({
      loadStatus: { ...state.loadStatus, [document.id]: 'loading' }
    }))
    try {
      const saved = await api.documents.pdfAnnotations(document.id)
      if (
        generation !== libraryGeneration ||
        annotationLoadVersions.get(document.id) !== loadVersion ||
        !get().tabs.some((tab) => tab.id === document.id)
      ) return
      const annotations = Array.isArray(saved) ? saved.filter(isAnnotation) : []
      set((state) => ({
        annotations: Object.hasOwn(state.annotations, document.id)
          ? state.annotations
          : { ...state.annotations, [document.id]: annotations },
        loadStatus: { ...state.loadStatus, [document.id]: 'loaded' },
        saveStatus: { ...state.saveStatus, [document.id]: 'saved' }
      }))
      if (annotationLoadVersions.get(document.id) === loadVersion) {
        annotationLoadVersions.delete(document.id)
      }
    } catch {
      if (
        generation !== libraryGeneration ||
        annotationLoadVersions.get(document.id) !== loadVersion ||
        !get().tabs.some((tab) => tab.id === document.id)
      ) return
      set((state) => ({
        loadStatus: { ...state.loadStatus, [document.id]: 'error' }
      }))
      if (annotationLoadVersions.get(document.id) === loadVersion) {
        annotationLoadVersions.delete(document.id)
      }
    }
  },

  consumeNavigationRequest: (request) => {
    if (get().navigationRequest === request) set({ navigationRequest: null })
  },

  close: (documentId) => {
    get().finishTextEditing(documentId)
    endHistoryGroup(documentId)
    annotationLoadVersions.delete(documentId)
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === documentId)
      const tabs = state.tabs.filter((tab) => tab.id !== documentId)
      const activeDocumentId = state.activeDocumentId === documentId
        ? tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id ?? null
        : state.activeDocumentId
      return {
        tabs,
        activeDocumentId,
        navigationRequest: state.navigationRequest?.documentId === documentId
          ? null : state.navigationRequest,
        selectedAnnotationId: null,
        selectedAnnotationIds: [],
        pendingCommentFocusId: null
      }
    })
    const queue = persistQueues.get(documentId)
    if (!queue) {
      clearDocumentCache(documentId)
      return
    }
    disposeAfterPersist.add(documentId)
    void flushPersistQueue(documentId, queue)
      .then(() => finishPersistQueue(documentId, queue))
      .catch(() => undefined)
  },

  closeAll: () => {
    get().finishTextEditing()
    const documentIds = new Set([
      ...get().tabs.map((tab) => tab.id),
      ...Object.keys(get().annotations),
      ...persistQueues.keys()
    ])
    set({
      tabs: [],
      activeDocumentId: null,
      navigationRequest: null,
      selectedAnnotationId: null,
      selectedAnnotationIds: [],
      pendingCommentFocusId: null
    })
    for (const documentId of documentIds) {
      annotationLoadVersions.delete(documentId)
      const queue = persistQueues.get(documentId)
      if (!queue) {
        clearDocumentCache(documentId)
        continue
      }
      disposeAfterPersist.add(documentId)
      void flushPersistQueue(documentId, queue)
        .then(() => finishPersistQueue(documentId, queue))
        .catch(() => undefined)
    }
  },

  activate: (documentId) => {
    get().finishTextEditing()
    const previousDocumentId = get().activeDocumentId
    if (previousDocumentId && previousDocumentId !== documentId) {
      endHistoryGroup(previousDocumentId)
    }
    set({
      activeDocumentId: documentId,
      selectedAnnotationId: null,
      selectedAnnotationIds: [],
      pendingCommentFocusId: null
    })
  },

  setTool: (tool) => {
    get().finishTextEditing()
    set((state) => ({
      tool,
      selectedAnnotationId: tool === null ? state.selectedAnnotationId : null,
      selectedAnnotationIds: tool === null ? state.selectedAnnotationIds : []
    }))
  },
  setColor: (color, tool) => set((state) => ({
    toolColors: { ...state.toolColors, [tool]: color }
  })),
  setFontSize: (fontSize) => set({
    fontSize: Math.max(8, Math.min(72, fontSize))
  }),
  setStrokeWidth: (strokeWidth) => set({
    strokeWidth: Math.max(1, Math.min(12, strokeWidth))
  }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  selectAnnotation: (id) => get().selectAnnotations(id ? [id] : []),
  selectAnnotations: (ids) => {
    const editor = get().textEditor
    if (editor && (ids.length !== 1 || ids[0] !== editor.annotationId)) get().finishTextEditing()
    set({ selectedAnnotationId: ids.at(-1) ?? null, selectedAnnotationIds: ids })
  },

  startTextEditing: (documentId, annotationId, continueHistory = false) => {
    const state = get()
    const annotation = state.annotations[documentId]?.find((item) => item.id === annotationId)
    if (state.activeDocumentId !== documentId || state.loadStatus[documentId] !== 'loaded' || annotation?.kind !== 'text') return
    if (state.textEditor?.documentId === documentId && state.textEditor.annotationId === annotationId) return
    get().finishTextEditing()
    if (!continueHistory) get().beginHistoryGroup(documentId)
    set({
      textEditor: { documentId, annotationId }, tool: null,
      selectedAnnotationId: annotationId, selectedAnnotationIds: [annotationId],
      pendingCommentFocusId: null
    })
  },

  finishTextEditing: (documentId, annotationId) => {
    const editor = get().textEditor
    if (!editor || (documentId && editor.documentId !== documentId) ||
      (annotationId && editor.annotationId !== annotationId)) return
    const annotation = get().annotations[editor.documentId]?.find((item) => item.id === editor.annotationId)
    set({ textEditor: null })
    if (annotation && !annotation.text.trim()) get().removeAnnotation(editor.documentId, editor.annotationId)
    endHistoryGroup(editor.documentId)
  },

  addAnnotation: (documentId, draft) => {
    if (!Object.hasOwn(get().annotations, documentId)) return null
    const annotation: PdfAnnotation = {
      ...draft,
      id: createAnnotationId(),
      createdAt: Date.now()
    }
    const annotations = [...(get().annotations[documentId] ?? []), annotation]
    recordHistory(documentId)
    set((state) => ({
      annotations: { ...state.annotations, [documentId]: annotations },
      selectedAnnotationId: null,
      selectedAnnotationIds: [],
      pendingCommentFocusId: annotation.kind === 'note' ? annotation.id : null,
      lastDeletion: null
    }))
    persist(documentId, annotations)
    return annotation
  },

  updateAnnotation: (documentId, annotationId, patch) => {
    get().updateAnnotations(documentId, [annotationId], patch)
  },

  updateAnnotations: (documentId, annotationIds, patch) => {
    if (!Object.hasOwn(get().annotations, documentId) || annotationIds.length === 0) return
    const ids = new Set(annotationIds)
    const current = get().annotations[documentId] ?? []
    let changed = false
    const annotations = current.map((annotation) => {
      if (!ids.has(annotation.id) || Object.entries(patch).every(([key, value]) =>
        JSON.stringify(annotation[key as keyof PdfAnnotation]) === JSON.stringify(value)
      )) return annotation
      changed = true
      return { ...annotation, ...patch }
    })
    if (!changed) return
    recordHistory(documentId)
    set((state) => ({
      annotations: { ...state.annotations, [documentId]: annotations }
    }))
    persist(documentId, annotations)
  },

  removeAnnotation: (documentId, annotationId) => {
    get().removeAnnotations(documentId, [annotationId])
  },

  removeAnnotations: (documentId, annotationIds) => {
    if (!Object.hasOwn(get().annotations, documentId)) return
    const ids = new Set(annotationIds)
    const editor = get().textEditor
    const finishesTextEdit = editor?.documentId === documentId && ids.has(editor.annotationId)
    const currentAnnotations = get().annotations[documentId] ?? []
    const deleted = currentAnnotations.flatMap((annotation, index) =>
      ids.has(annotation.id) ? [{ annotation, index }] : []
    )
    if (deleted.length === 0) return
    const annotations = currentAnnotations.filter((annotation) => !ids.has(annotation.id))
    recordHistory(documentId)
    set((state) => {
      const selectedAnnotationIds = state.selectedAnnotationIds.filter(
        (id) => !ids.has(id)
      )
      return {
        annotations: { ...state.annotations, [documentId]: annotations },
        selectedAnnotationId: selectedAnnotationIds.at(-1) ?? null,
        selectedAnnotationIds,
        textEditor: state.textEditor?.documentId === documentId && ids.has(state.textEditor.annotationId)
          ? null : state.textEditor,
        pendingCommentFocusId: ids.has(state.pendingCommentFocusId ?? '')
          ? null
          : state.pendingCommentFocusId,
        lastDeletion: { documentId, annotations: deleted }
      }
    })
    if (finishesTextEdit) endHistoryGroup(documentId)
    persist(documentId, annotations)
  },

  consumeCommentFocus: () => set({ pendingCommentFocusId: null }),

  retryLoad: async (documentId) => {
    const document = get().tabs.find((tab) => tab.id === documentId)
    if (!document || Object.hasOwn(get().annotations, documentId)) return
    await get().open(document)
  },

  retrySave: (documentId) => {
    if (!Object.hasOwn(get().annotations, documentId)) return
    persist(documentId, get().annotations[documentId])
  },

  beginHistoryGroup: (documentId) => {
    endHistoryGroup(documentId)
    historyGroups.set(documentId, {
      before: get().annotations[documentId] ?? [],
      recorded: false,
      previousHistory: get().annotationHistory[documentId] ?? { past: [], future: [] }
    })
  },

  endHistoryGroup,

  undo: (documentId) => applyHistory(documentId, 'undo'),

  redo: (documentId) => applyHistory(documentId, 'redo'),

  undoLastDeletion: () => {
    const deletion = get().lastDeletion
    if (!deletion) return
    get().undo(deletion.documentId)
    set({
      activeDocumentId: deletion.documentId,
      tool: null
    })
  },

  clearLastDeletion: () => set({ lastDeletion: null }),

  flushPendingSaves,

  resetForLibrarySwitch
}))
