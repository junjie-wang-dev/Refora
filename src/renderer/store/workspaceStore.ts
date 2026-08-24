import { create } from 'zustand'
import type {
  Workspace,
  WorkspaceItem,
  WorkspaceItemKind,
  WorkspaceItemPlacement,
  AiReport,
  WorkspaceNote,
  WorkspaceNotePatch,
  WorkspaceNoteType,
  ChatThread,
  WorkspaceItemsChangedEvent,
  WorkspaceAsset,
  WorkspaceContentKind
} from '../../shared/ipc-types'
import { errorMessage } from '../../shared/ipc-types'
import { api } from '../ipc'
import { useDocumentStore } from './documentStore'
import i18n from '../i18n'
import { flushRendererPersistence, trackRendererPersistence } from '../persistence'

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  openWorkspaceIds: string[]
  activeThreadId: string | null
  panelOpen: boolean
  panelView: 'workspace' | 'markdown' | 'pdf'
  fullscreen: boolean
  chatStreaming: boolean
  items: WorkspaceItem[]
  reports: AiReport[]
  notes: WorkspaceNote[]
  assets: WorkspaceAsset[]
  threads: ChatThread[]
  markdownCardRequest: { kind: WorkspaceContentKind; id: string } | null
  initialized: boolean
  init: () => void
  destroy: () => void
  fetchWorkspaces: () => Promise<void>
  createWorkspace: (name: string) => Promise<Workspace | null>
  renameWorkspace: (id: string, name: string) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  setActiveWorkspace: (id: string | null) => boolean
  requestActiveWorkspace: (id: string | null) => Promise<boolean>
  closeWorkspaceTab: (id: string) => void
  setActiveThreadId: (id: string | null) => void
  adoptStreamingThread: (id: string) => void
  setChatStreaming: (streaming: boolean) => void
  deleteThread: (threadId: string) => Promise<void>
  renameThread: (threadId: string, title: string) => Promise<void>
  fetchThreads: (options?: { selectLatestIfNone?: boolean }) => Promise<void>
  startNewChat: () => void
  openPanel: () => void
  openPdfReader: () => void
  showWorkspace: () => void
  showMarkdown: () => void
  closePanel: () => void
  toggleFullscreen: () => void
  openMarkdownCard: (kind: WorkspaceContentKind, id: string) => void
  clearMarkdownCardRequest: () => void
  fetchItems: () => Promise<void>
  fetchAssets: () => Promise<void>
  addAssets: (paths: string[], placement?: WorkspaceItemPlacement) => Promise<void>
  addFiles: (paths: string[], placement?: WorkspaceItemPlacement) => Promise<void>
  deleteAsset: (id: string) => Promise<void>
  addDocs: (docIds: string[], placement?: WorkspaceItemPlacement) => Promise<void>
  removeItem: (itemId: string) => Promise<void>
  reorderItems: (orderedIds: string[]) => Promise<void>
  resizeItem: (itemId: string, width: number, height: number) => Promise<boolean>
  moveItem: (itemId: string, x: number, y: number, zIndex: number) => Promise<boolean>
  fetchReports: () => Promise<void>
  deleteReport: (id: string) => Promise<void>
  updateReport: (id: string, patch: { title?: string; contentMd?: string }) => Promise<boolean>
  fetchNotes: () => Promise<void>
  createNote: (title: string, contentMd: string, noteType: WorkspaceNoteType, placement?: WorkspaceItemPlacement) => Promise<WorkspaceNote | null>
  deleteNote: (id: string) => Promise<void>
  updateNote: (id: string, patch: WorkspaceNotePatch) => Promise<boolean>
  addItem: (kind: WorkspaceItemKind, ids: string[], placement?: WorkspaceItemPlacement) => Promise<void>
}

const aiSummaryUpdatedCb: Array<null | ((docId: string) => void)> = [null]
const aiReportCreatedCb: Array<null | ((report: AiReport) => void)> = [null]
const workspaceItemsChangedCb: Array<null | ((payload: WorkspaceItemsChangedEvent) => void)> = [null]
const librarySwitchedCb: Array<null | (() => void)> = [null]
const noteUpdateQueues = new Map<string, Promise<void>>()
const noteUpdateRevisions = new Map<
  string,
  Partial<Record<keyof WorkspaceNotePatch, number>>
>()
const threadRenameRevisions = new Map<string, number>()
const threadRenameQueues = new Map<string, Promise<void>>()
const threadConfirmedTitles = new Map<string, string | null>()
let nextNoteUpdateRevision = 0
let nextThreadRenameRevision = 0
let libraryGeneration = 0
let workspaceRequestVersion = 0
let threadRequestVersion = 0
let itemRequestVersion = 0
let assetRequestVersion = 0
let reportRequestVersion = 0
let noteRequestVersion = 0

function toast(message: string): void {
  useDocumentStore.getState().showToast(message)
}

function addOpenWorkspace(ids: string[], id: string | null): string[] {
  return id && !ids.includes(id) ? [...ids, id] : ids
}

function restoreRemoved<T extends { id: string }>(
  current: T[],
  previous: T[],
  removed: T[]
): T[] {
  const restored = [...current]
  const removedIds = new Set(removed.map((item) => item.id))
  for (const [index, item] of previous.entries()) {
    if (!removedIds.has(item.id) || restored.some((currentItem) => currentItem.id === item.id)) {
      continue
    }
    restored.splice(Math.min(index, restored.length), 0, item)
  }
  return restored
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  openWorkspaceIds: [],
  activeThreadId: null,
  panelOpen: false,
  panelView: 'workspace',
  fullscreen: false,
  chatStreaming: false,
  items: [],
  reports: [],
  notes: [],
  assets: [],
  threads: [],
  markdownCardRequest: null,
  initialized: false,

  init: () => {
    if (get().initialized) return
    set({ initialized: true })

    aiSummaryUpdatedCb[0] = (_docId: string) => {
      void get().fetchItems()
    }
    api.events.onAiSummaryUpdated(aiSummaryUpdatedCb[0])

    aiReportCreatedCb[0] = (report: AiReport) => {
      if (report.workspaceId === get().activeWorkspaceId) {
        void Promise.all([get().fetchReports(), get().fetchItems()])
      }
    }
    api.events.onAiReportCreated(aiReportCreatedCb[0])

    workspaceItemsChangedCb[0] = (payload: WorkspaceItemsChangedEvent) => {
      if (payload.workspaceId === get().activeWorkspaceId) {
        void Promise.all([
          get().fetchItems(),
          get().fetchReports(),
          get().fetchNotes(),
          get().fetchAssets()
        ])
      }
    }
    api.events.onWorkspaceItemsChanged(workspaceItemsChangedCb[0])

    librarySwitchedCb[0] = () => {
      libraryGeneration++
      noteUpdateQueues.clear()
      noteUpdateRevisions.clear()
      threadRenameRevisions.clear()
      threadRenameQueues.clear()
      threadConfirmedTitles.clear()
      set({
        workspaces: [],
        activeWorkspaceId: null,
        openWorkspaceIds: [],
        activeThreadId: null,
        panelOpen: false,
        panelView: 'workspace',
        fullscreen: false,
        chatStreaming: false,
        items: [],
        reports: [],
        notes: [],
        assets: [],
        threads: [],
        markdownCardRequest: null
      })
      void get().fetchWorkspaces()
    }
    api.events.onLibrarySwitched(librarySwitchedCb[0])

    void get().fetchWorkspaces()
  },

  destroy: () => {
    libraryGeneration++
    noteUpdateQueues.clear()
    noteUpdateRevisions.clear()
    threadRenameRevisions.clear()
    threadRenameQueues.clear()
    threadConfirmedTitles.clear()
    if (aiSummaryUpdatedCb[0]) {
      api.events.off('ai:summary:updated', aiSummaryUpdatedCb[0])
      aiSummaryUpdatedCb[0] = null
    }
    if (aiReportCreatedCb[0]) {
      api.events.off('ai:report:created', aiReportCreatedCb[0])
      aiReportCreatedCb[0] = null
    }
    if (workspaceItemsChangedCb[0]) {
      api.events.off('workspace:items:changed', workspaceItemsChangedCb[0])
      workspaceItemsChangedCb[0] = null
    }
    if (librarySwitchedCb[0]) {
      api.events.off('library:switched', librarySwitchedCb[0])
      librarySwitchedCb[0] = null
    }
    set({ initialized: false })
  },

  fetchWorkspaces: async () => {
    const generation = libraryGeneration
    const requestVersion = ++workspaceRequestVersion
    try {
      const list = await api.workspaces.list()
      if (
        generation === libraryGeneration &&
        requestVersion === workspaceRequestVersion
      ) set({ workspaces: list })
    } catch (e) {
      if (
        generation !== libraryGeneration ||
        requestVersion !== workspaceRequestVersion
      ) return
      toast(errorMessage(e, i18n.t('workspaceErrors.loadWorkspaces')))
    }
  },

  createWorkspace: async (name: string): Promise<Workspace | null> => {
    const generation = libraryGeneration
    try {
      const ws = await api.workspaces.create(name)
      if (generation !== libraryGeneration) return null
      set((s) => ({ workspaces: [...s.workspaces, ws] }))
      return ws
    } catch (e) {
      if (generation !== libraryGeneration) return null
      toast(errorMessage(e, i18n.t('workspaceErrors.createWorkspace')))
      return null
    }
  },

  renameWorkspace: async (id: string, name: string) => {
    const generation = libraryGeneration
    try {
      await api.workspaces.rename(id, name)
      if (generation !== libraryGeneration) return
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w))
      }))
    } catch (e) {
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.renameWorkspace')))
    }
  },

  deleteWorkspace: async (id: string) => {
    const generation = libraryGeneration
    try {
      await api.workspaces.delete(id)
      if (generation !== libraryGeneration) return
      set((s) => {
        const activeCleared = s.activeWorkspaceId === id
        return {
          workspaces: s.workspaces.filter((w) => w.id !== id),
          openWorkspaceIds: s.openWorkspaceIds.filter((workspaceId) => workspaceId !== id),
          ...(activeCleared
            ? {
                activeWorkspaceId: null,
                activeThreadId: null,
                panelOpen: false,
                panelView: 'workspace',
                items: [],
                reports: [],
                notes: [],
                assets: [],
                threads: [],
                markdownCardRequest: null
              }
            : {})
        }
      })
    } catch (e) {
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.deleteWorkspace')))
    }
  },

  setActiveWorkspace: (id: string | null) => {
    const current = get()
    if (current.chatStreaming) {
      if (!id || current.activeWorkspaceId !== id) return false
      set((state) => ({
        panelOpen: true,
        panelView: 'workspace',
        openWorkspaceIds: addOpenWorkspace(state.openWorkspaceIds, id)
      }))
      return true
    }
    set((state) => ({
      activeWorkspaceId: id,
      openWorkspaceIds: addOpenWorkspace(state.openWorkspaceIds, id),
      activeThreadId: null,
      panelOpen: id !== null,
      panelView: 'workspace',
      items: [],
      reports: [],
      notes: [],
      assets: [],
      threads: [],
      markdownCardRequest: null
    }))
    if (id) {
      void get().fetchItems()
      void get().fetchReports()
      void get().fetchNotes()
      void get().fetchAssets()
    }
    void get().fetchThreads({ selectLatestIfNone: true })
    return true
  },

  requestActiveWorkspace: async (id: string | null) => {
    try {
      await flushRendererPersistence()
    } catch {
      return false
    }
    return get().setActiveWorkspace(id)
  },

  closeWorkspaceTab: (id: string) => {
    set((state) => ({
      openWorkspaceIds: state.openWorkspaceIds.filter((workspaceId) => workspaceId !== id)
    }))
  },

  setActiveThreadId: (id: string | null) => {
    const current = get()
    if (current.chatStreaming && current.activeThreadId !== id) return
    set({ activeThreadId: id })
  },

  adoptStreamingThread: (id: string) => {
    set({ activeThreadId: id })
  },

  setChatStreaming: (streaming: boolean) => {
    set({ chatStreaming: streaming })
  },

  deleteThread: async (threadId: string) => {
    const generation = libraryGeneration
    try {
      await api.ai.chatDeleteThread(threadId)
      if (generation !== libraryGeneration) return
      if (get().activeThreadId === threadId) {
        set({ activeThreadId: null })
      }
    } catch (e) {
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.deleteThread')))
    }
  },

  renameThread: async (threadId: string, title: string) => {
    const generation = libraryGeneration
    if (!threadRenameQueues.has(threadId)) {
      const currentTitle = get().threads.find((thread) => thread.id === threadId)?.title ?? null
      threadConfirmedTitles.set(threadId, currentTitle)
    }
    const revision = ++nextThreadRenameRevision
    threadRenameRevisions.set(threadId, revision)
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, title } : t))
    }))
    const previousRequest = threadRenameQueues.get(threadId) ?? Promise.resolve()
    const request = previousRequest
      .catch(() => undefined)
      .then(() => api.ai.renameThread(threadId, title))
    threadRenameQueues.set(threadId, request)
    try {
      await request
      if (generation !== libraryGeneration) return
      threadConfirmedTitles.set(threadId, title)
      if (threadRenameRevisions.get(threadId) === revision) {
        threadRenameRevisions.delete(threadId)
      }
    } catch (e) {
      if (generation !== libraryGeneration) return
      if (threadRenameRevisions.get(threadId) === revision) {
        threadRenameRevisions.delete(threadId)
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId && thread.title === title
              ? { ...thread, title: threadConfirmedTitles.get(threadId) ?? null }
              : thread
          )
        }))
      }
      toast(errorMessage(e, i18n.t('workspaceErrors.renameThread')))
    } finally {
      if (threadRenameQueues.get(threadId) === request) {
        threadRenameQueues.delete(threadId)
        threadConfirmedTitles.delete(threadId)
        if (threadRenameRevisions.get(threadId) === revision) {
          threadRenameRevisions.delete(threadId)
        }
      }
    }
  },

  fetchThreads: async (options) => {
    const generation = libraryGeneration
    const requestVersion = ++threadRequestVersion
    const id = get().activeWorkspaceId
    try {
      const list = await api.ai.chatThreads(id)
      if (
        generation !== libraryGeneration ||
        requestVersion !== threadRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      set((state) => {
        if (
          generation !== libraryGeneration ||
          requestVersion !== threadRequestVersion ||
          state.activeWorkspaceId !== id
        ) return state
        const activeStillExists = list.some((thread) => thread.id === state.activeThreadId)
        const shouldSelectLatest =
          options?.selectLatestIfNone === true ||
          (state.activeThreadId !== null && !activeStillExists)
        return {
          threads: list,
          activeThreadId: activeStillExists
            ? state.activeThreadId
            : shouldSelectLatest
              ? list[0]?.id ?? null
              : null
        }
      })
    } catch (e) {
      if (
        generation !== libraryGeneration ||
        requestVersion !== threadRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      toast(errorMessage(e, i18n.t('workspaceErrors.loadThreads')))
    }
  },

  startNewChat: () => {
    set({ activeThreadId: null })
  },

  openPanel: () => {
    set((state) => ({
      panelOpen: true,
      panelView: 'workspace',
      openWorkspaceIds: addOpenWorkspace(state.openWorkspaceIds, state.activeWorkspaceId)
    }))
  },

  openPdfReader: () => {
    set({ panelOpen: true, panelView: 'pdf', fullscreen: false })
  },

  showWorkspace: () => {
    set((state) => ({
      panelOpen: true,
      panelView: 'workspace',
      openWorkspaceIds: addOpenWorkspace(state.openWorkspaceIds, state.activeWorkspaceId)
    }))
  },

  showMarkdown: () => {
    set({ panelOpen: true, panelView: 'markdown' })
  },

  closePanel: () => {
    set({ panelOpen: false, panelView: 'workspace', fullscreen: false })
  },

  toggleFullscreen: () => {
    set((s) => ({ fullscreen: !s.fullscreen }))
  },

  openMarkdownCard: (kind: WorkspaceContentKind, id: string) => {
    set((state) => ({
      markdownCardRequest: { kind, id },
      panelOpen: true,
      panelView: 'markdown',
      openWorkspaceIds: addOpenWorkspace(state.openWorkspaceIds, state.activeWorkspaceId)
    }))
  },

  clearMarkdownCardRequest: () => {
    set({ markdownCardRequest: null })
  },

  fetchItems: async () => {
    const generation = libraryGeneration
    const requestVersion = ++itemRequestVersion
    const id = get().activeWorkspaceId
    if (!id) {
      set({ items: [] })
      return
    }
    try {
      const list = await api.workspaceItems.list(id)
      if (
        generation !== libraryGeneration ||
        requestVersion !== itemRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      set({ items: list })
    } catch (e) {
      if (
        generation !== libraryGeneration ||
        requestVersion !== itemRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      toast(errorMessage(e, i18n.t('workspaceErrors.loadItems')))
    }
  },

  addDocs: async (docIds: string[], placement?: WorkspaceItemPlacement) => {
    const generation = libraryGeneration
    const id = get().activeWorkspaceId
    if (!id || docIds.length === 0) return
    try {
      if (placement) await api.workspaceItems.add(id, 'document', docIds, placement)
      else await api.workspaceItems.add(id, 'document', docIds)
      if (generation !== libraryGeneration) return
      await get().fetchItems()
    } catch (e) {
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.addDocuments')))
      throw e
    }
  },

  fetchAssets: async () => {
    const generation = libraryGeneration
    const requestVersion = ++assetRequestVersion
    const id = get().activeWorkspaceId
    if (!id) {
      set({ assets: [] })
      return
    }
    try {
      const list = await api.workspaceAssets.list(id)
      if (
        generation !== libraryGeneration ||
        requestVersion !== assetRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      set({ assets: list })
    } catch (e) {
      if (
        generation !== libraryGeneration ||
        requestVersion !== assetRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      toast(errorMessage(e, i18n.t('workspaceErrors.loadFiles')))
    }
  },

  addAssets: async (paths: string[], placement?: WorkspaceItemPlacement) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return
    try {
      const result = placement
        ? await api.workspaceAssets.addFiles(workspaceId, paths, placement)
        : await api.workspaceAssets.addFiles(workspaceId, paths)
      if (
        generation !== libraryGeneration ||
        get().activeWorkspaceId !== workspaceId
      ) return
      await Promise.all([get().fetchItems(), get().fetchAssets()])
      if (result.errors.length > 0) {
        toast(result.errors[0].message)
      }
    } catch (e) {
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.addFiles')))
      throw e
    }
  },

  addFiles: async (paths: string[], placement?: WorkspaceItemPlacement) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId || paths.length === 0) return
    try {
      const result = placement
        ? await api.workspaceFiles.add(workspaceId, paths, placement)
        : await api.workspaceFiles.add(workspaceId, paths)
      if (
        generation !== libraryGeneration ||
        get().activeWorkspaceId !== workspaceId
      ) return
      await Promise.all([get().fetchItems(), get().fetchNotes(), get().fetchAssets()])
      if (result.errors.length > 0) toast(result.errors[0].message)
    } catch (e) {
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.addFiles')))
      throw e
    }
  },

  deleteAsset: async (id: string) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    const previousAssets = get().assets
    const previousItems = get().items
    const removedAssets = previousAssets.filter((asset) => asset.id === id)
    const removedItems = previousItems.filter((item) => item.assetId === id)
    set((state) => ({
      assets: state.assets.filter((asset) => asset.id !== id),
      items: state.items.filter((item) => item.assetId !== id)
    }))
    try {
      await api.workspaceAssets.delete(id)
    } catch (e) {
      if (generation === libraryGeneration && get().activeWorkspaceId === workspaceId) {
        set((state) => ({
          assets: restoreRemoved(state.assets, previousAssets, removedAssets),
          items: restoreRemoved(state.items, previousItems, removedItems)
        }))
      }
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.deleteFile')))
    }
  },

  addItem: async (kind: WorkspaceItemKind, ids: string[], placement?: WorkspaceItemPlacement) => {
    const generation = libraryGeneration
    const id = get().activeWorkspaceId
    if (!id || ids.length === 0) return
    try {
      if (placement) await api.workspaceItems.add(id, kind, ids, placement)
      else await api.workspaceItems.add(id, kind, ids)
      if (generation !== libraryGeneration) return
      await get().fetchItems()
    } catch (e) {
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.addItems')))
    }
  },

  removeItem: async (itemId: string) => {
    const generation = libraryGeneration
    try {
      await api.workspaceItems.remove(itemId)
      if (generation !== libraryGeneration) return
      await get().fetchItems()
    } catch (e) {
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.removeItem')))
    }
  },

  reorderItems: async (orderedIds: string[]) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return
    const previous = get().items
    const byId = new Map(previous.map((item) => [item.id, item]))
    const reordered = orderedIds
      .map((id, index) => {
        const item = byId.get(id)
        return item ? { ...item, sortOrder: index } : null
      })
      .filter((item): item is WorkspaceItem => item !== null)
    if (reordered.length !== previous.length) return
    set({ items: reordered })
    try {
      const saved = await api.workspaceItems.reorder(workspaceId, orderedIds)
      if (generation === libraryGeneration && get().activeWorkspaceId === workspaceId) {
        set({ items: saved })
      }
    } catch (e) {
      if (generation === libraryGeneration && get().activeWorkspaceId === workspaceId) {
        const optimisticSortOrders = new Map(orderedIds.map((id, index) => [id, index]))
        const previousSortOrders = new Map(previous.map((item) => [item.id, item.sortOrder]))
        set((state) => ({
          items: state.items
            .map((item) => {
              const optimisticSortOrder = optimisticSortOrders.get(item.id)
              const previousSortOrder = previousSortOrders.get(item.id)
              return optimisticSortOrder !== undefined &&
                previousSortOrder !== undefined &&
                item.sortOrder === optimisticSortOrder
                ? { ...item, sortOrder: previousSortOrder }
                : item
            })
            .sort((left, right) => left.sortOrder - right.sortOrder)
        }))
      }
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.reorderItems')))
    }
  },

  resizeItem: async (itemId: string, width: number, height: number) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return false
    const previousItem = get().items.find((item) => item.id === itemId)
    if (!previousItem) return false
    set((s) => ({
      items: s.items.map((item) => item.id === itemId ? { ...item, width, height } : item)
    }))
    try {
      const saved = await api.workspaceItems.resize(itemId, width, height)
      if (
        generation !== libraryGeneration ||
        get().activeWorkspaceId !== workspaceId
      ) return true
      set((s) => ({
        items: s.items.map((item) =>
          item.id === itemId && item.width === width && item.height === height ? saved : item
        )
      }))
      return true
    } catch (e) {
      if (generation === libraryGeneration && get().activeWorkspaceId === workspaceId) {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === itemId && item.width === width && item.height === height
              ? previousItem
              : item
          )
        }))
      }
      if (generation !== libraryGeneration) return false
      toast(errorMessage(e, i18n.t('workspaceErrors.saveCardSize')))
      return false
    }
  },

  moveItem: async (itemId: string, x: number, y: number, zIndex: number) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return false
    const previousItem = get().items.find((item) => item.id === itemId)
    if (!previousItem) return false
    set((s) => ({
      items: s.items.map((item) => item.id === itemId ? { ...item, x, y, zIndex } : item)
    }))
    try {
      const saved = await api.workspaceItems.move(itemId, x, y, zIndex)
      if (
        generation !== libraryGeneration ||
        get().activeWorkspaceId !== workspaceId
      ) return true
      set((s) => ({
        items: s.items.map((item) =>
          item.id === itemId && item.x === x && item.y === y && item.zIndex === zIndex
            ? saved
            : item
        )
      }))
      return true
    } catch (e) {
      if (generation === libraryGeneration && get().activeWorkspaceId === workspaceId) {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === itemId && item.x === x && item.y === y && item.zIndex === zIndex
              ? previousItem
              : item
          )
        }))
      }
      if (generation !== libraryGeneration) return false
      toast(errorMessage(e, i18n.t('workspaceErrors.saveCardPosition')))
      return false
    }
  },

  fetchReports: async () => {
    const generation = libraryGeneration
    const requestVersion = ++reportRequestVersion
    const id = get().activeWorkspaceId
    if (!id) {
      set({ reports: [] })
      return
    }
    try {
      const list = await api.reports.list(id)
      if (
        generation !== libraryGeneration ||
        requestVersion !== reportRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      set({ reports: list })
    } catch (e) {
      if (
        generation !== libraryGeneration ||
        requestVersion !== reportRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      toast(errorMessage(e, i18n.t('workspaceErrors.loadReports')))
    }
  },

  deleteReport: async (id: string) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    const previousReports = get().reports
    const previousItems = get().items
    const removedReports = previousReports.filter((report) => report.id === id)
    const removedItems = previousItems.filter((item) => item.reportId === id)
    set((s) => ({
      reports: s.reports.filter((r) => r.id !== id),
      items: s.items.filter((item) => item.reportId !== id)
    }))
    try {
      await api.reports.delete(id)
    } catch (e) {
      if (generation === libraryGeneration && get().activeWorkspaceId === workspaceId) {
        set((state) => ({
          reports: restoreRemoved(state.reports, previousReports, removedReports),
          items: restoreRemoved(state.items, previousItems, removedItems)
        }))
      }
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.deleteReport')))
    }
  },

  updateReport: async (id: string, patch: { title?: string; contentMd?: string }) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    try {
      const updated = await trackRendererPersistence(api.reports.update(id, patch))
      if (
        generation !== libraryGeneration ||
        get().activeWorkspaceId !== workspaceId
      ) return true
      set((s) => ({ reports: s.reports.map((r) => (r.id === id ? updated : r)) }))
      return true
    } catch (e) {
      if (generation !== libraryGeneration) return false
      toast(errorMessage(e, i18n.t('workspaceErrors.updateReport')))
      return false
    }
  },

  fetchNotes: async () => {
    const generation = libraryGeneration
    const requestVersion = ++noteRequestVersion
    const id = get().activeWorkspaceId
    if (!id) {
      set({ notes: [] })
      return
    }
    try {
      const list = await api.workspaceNotes.list(id)
      if (
        generation !== libraryGeneration ||
        requestVersion !== noteRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      set({ notes: list })
    } catch (e) {
      if (
        generation !== libraryGeneration ||
        requestVersion !== noteRequestVersion ||
        get().activeWorkspaceId !== id
      ) return
      toast(errorMessage(e, i18n.t('workspaceErrors.loadNotes')))
    }
  },

  createNote: async (
    title: string,
    contentMd: string,
    noteType: WorkspaceNoteType,
    placement?: WorkspaceItemPlacement
  ) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return null
    try {
      const note = placement
        ? await api.workspaceNotes.create(workspaceId, title, contentMd, noteType, placement)
        : await api.workspaceNotes.create(workspaceId, title, contentMd, noteType)
      if (
        generation !== libraryGeneration ||
        get().activeWorkspaceId !== workspaceId
      ) return null
      set((s) => ({ notes: [...s.notes, note] }))
      await get().fetchItems()
      return note
    } catch (e) {
      if (generation !== libraryGeneration) return null
      toast(errorMessage(e, i18n.t('workspaceErrors.createNote')))
      return null
    }
  },

  deleteNote: async (id: string) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    const previousNotes = get().notes
    const previousItems = get().items
    const removedNotes = previousNotes.filter((note) => note.id === id)
    const removedItems = previousItems.filter((item) => item.noteId === id)
    set((s) => ({
      notes: s.notes.filter((note) => note.id !== id),
      items: s.items.filter((item) => item.noteId !== id)
    }))
    try {
      await api.workspaceNotes.delete(id)
    } catch (e) {
      if (generation === libraryGeneration && get().activeWorkspaceId === workspaceId) {
        set((state) => ({
          notes: restoreRemoved(state.notes, previousNotes, removedNotes),
          items: restoreRemoved(state.items, previousItems, removedItems)
        }))
      }
      if (generation !== libraryGeneration) return
      toast(errorMessage(e, i18n.t('workspaceErrors.deleteNote')))
    }
  },

  updateNote: async (id: string, patch: WorkspaceNotePatch) => {
    const generation = libraryGeneration
    const workspaceId = get().activeWorkspaceId
    const previousNote = get().notes.find((note) => note.id === id)
    const revision = ++nextNoteUpdateRevision
    const fields = (Object.keys(patch) as Array<keyof WorkspaceNotePatch>)
      .filter((field) => patch[field] !== undefined)
    const revisions = noteUpdateRevisions.get(id) ?? {}
    fields.forEach((field) => {
      revisions[field] = revision
    })
    noteUpdateRevisions.set(id, revisions)
    const isLatest = (field: keyof WorkspaceNotePatch) =>
      noteUpdateRevisions.get(id)?.[field] === revision
    if (previousNote) {
      set((s) => ({
        notes: s.notes.map((note) => note.id === id ? { ...note, ...patch } : note)
      }))
    }
    const execute = () => generation === libraryGeneration
      ? trackRendererPersistence(api.workspaceNotes.update(id, patch))
      : Promise.reject()
    const previousQueue = noteUpdateQueues.get(id)
    const request = previousQueue ? previousQueue.then(execute) : execute()
    const settled = request.then(() => undefined, () => undefined)
    noteUpdateQueues.set(id, settled)
    try {
      const updated = await request
      if (
        generation !== libraryGeneration ||
        get().activeWorkspaceId !== workspaceId
      ) return true
      const hasLatestField = fields.some(isLatest)
      set((s) => ({
        notes: s.notes.map((note) => {
          if (note.id !== id) return note
          return {
            ...note,
            title: patch.title === undefined || !isLatest('title') ? note.title : updated.title,
            contentMd: patch.contentMd === undefined || !isLatest('contentMd')
              ? note.contentMd
              : updated.contentMd,
            color: patch.color === undefined || !isLatest('color') ? note.color : updated.color,
            updatedAt: hasLatestField ? Math.max(note.updatedAt, updated.updatedAt) : note.updatedAt
          }
        })
      }))
      return true
    } catch (e) {
      if (
        previousNote &&
        generation === libraryGeneration &&
        get().activeWorkspaceId === workspaceId
      ) {
        set((s) => ({
          notes: s.notes.map((note) => {
            if (note.id !== id) return note
            return {
              ...note,
              title: patch.title !== undefined && isLatest('title') && note.title === patch.title
                ? previousNote.title
                : note.title,
              contentMd: patch.contentMd !== undefined
                && isLatest('contentMd')
                && note.contentMd === patch.contentMd
                ? previousNote.contentMd
                : note.contentMd,
              color: patch.color !== undefined && isLatest('color') && note.color === patch.color
                ? previousNote.color
                : note.color
            }
          })
        }))
      }
      if (generation !== libraryGeneration) return false
      toast(errorMessage(e, i18n.t('workspaceErrors.updateNote')))
      return false
    } finally {
      const currentRevisions = noteUpdateRevisions.get(id)
      fields.forEach((field) => {
        if (currentRevisions?.[field] === revision) delete currentRevisions[field]
      })
      if (currentRevisions && Object.keys(currentRevisions).length === 0) {
        noteUpdateRevisions.delete(id)
      }
      if (noteUpdateQueues.get(id) === settled) noteUpdateQueues.delete(id)
    }
  }
}))
