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
  setActiveWorkspace: (id: string | null) => void
  closeWorkspaceTab: (id: string) => void
  setActiveThreadId: (id: string | null) => void
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
let nextNoteUpdateRevision = 0

function toast(message: string): void {
  useDocumentStore.getState().showToast(message)
}

function addOpenWorkspace(ids: string[], id: string | null): string[] {
  return id && !ids.includes(id) ? [...ids, id] : ids
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
    try {
      const list = await api.workspaces.list()
      set({ workspaces: list })
    } catch (e) {
      toast(errorMessage(e, 'Failed to load workspaces'))
    }
  },

  createWorkspace: async (name: string): Promise<Workspace | null> => {
    try {
      const ws = await api.workspaces.create(name)
      set((s) => ({ workspaces: [...s.workspaces, ws] }))
      return ws
    } catch (e) {
      toast(errorMessage(e, 'Failed to create workspace'))
      return null
    }
  },

  renameWorkspace: async (id: string, name: string) => {
    try {
      await api.workspaces.rename(id, name)
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w))
      }))
    } catch (e) {
      toast(errorMessage(e, 'Failed to rename workspace'))
    }
  },

  deleteWorkspace: async (id: string) => {
    try {
      await api.workspaces.delete(id)
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
      toast(errorMessage(e, 'Failed to delete workspace'))
    }
  },

  setActiveWorkspace: (id: string | null) => {
    const current = get()
    if (current.chatStreaming) {
      if (!id || current.activeWorkspaceId !== id) return
      set((state) => ({
        panelOpen: true,
        panelView: 'workspace',
        openWorkspaceIds: addOpenWorkspace(state.openWorkspaceIds, id)
      }))
      return
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
  },

  closeWorkspaceTab: (id: string) => {
    set((state) => ({
      openWorkspaceIds: state.openWorkspaceIds.filter((workspaceId) => workspaceId !== id)
    }))
  },

  setActiveThreadId: (id: string | null) => {
    set({ activeThreadId: id })
  },

  setChatStreaming: (streaming: boolean) => {
    set({ chatStreaming: streaming })
  },

  deleteThread: async (threadId: string) => {
    try {
      await api.ai.chatDeleteThread(threadId)
      if (get().activeThreadId === threadId) {
        set({ activeThreadId: null })
      }
    } catch (e) {
      toast(errorMessage(e, 'Failed to delete thread'))
    }
  },

  renameThread: async (threadId: string, title: string) => {
    const prev = get().threads
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, title } : t))
    }))
    try {
      await api.ai.renameThread(threadId, title)
    } catch (e) {
      set({ threads: prev })
      toast(errorMessage(e, 'Failed to rename thread'))
    }
  },

  fetchThreads: async (options) => {
    const id = get().activeWorkspaceId
    try {
      const list = await api.ai.chatThreads(id)
      if (get().activeWorkspaceId !== id) return
      set((state) => {
        if (state.activeWorkspaceId !== id) return state
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
    } catch {
      if (get().activeWorkspaceId !== id) return
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
    const id = get().activeWorkspaceId
    if (!id) {
      set({ items: [] })
      return
    }
    try {
      const list = await api.workspaceItems.list(id)
      if (get().activeWorkspaceId !== id) return
      set({ items: list })
    } catch (e) {
      if (get().activeWorkspaceId !== id) return
      toast(errorMessage(e, 'Failed to load workspace items'))
    }
  },

  addDocs: async (docIds: string[], placement?: WorkspaceItemPlacement) => {
    const id = get().activeWorkspaceId
    if (!id || docIds.length === 0) return
    try {
      if (placement) await api.workspaceItems.add(id, 'document', docIds, placement)
      else await api.workspaceItems.add(id, 'document', docIds)
      await get().fetchItems()
    } catch (e) {
      toast(errorMessage(e, 'Failed to add documents to workspace'))
      throw e
    }
  },

  fetchAssets: async () => {
    const id = get().activeWorkspaceId
    if (!id) {
      set({ assets: [] })
      return
    }
    try {
      const list = await api.workspaceAssets.list(id)
      if (get().activeWorkspaceId !== id) return
      set({ assets: list })
    } catch (e) {
      if (get().activeWorkspaceId !== id) return
      toast(errorMessage(e, 'Failed to load workspace files'))
    }
  },

  addAssets: async (paths: string[], placement?: WorkspaceItemPlacement) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return
    try {
      const result = placement
        ? await api.workspaceAssets.addFiles(workspaceId, paths, placement)
        : await api.workspaceAssets.addFiles(workspaceId, paths)
      if (get().activeWorkspaceId !== workspaceId) return
      await Promise.all([get().fetchItems(), get().fetchAssets()])
      if (result.errors.length > 0) {
        toast(result.errors[0].message)
      }
    } catch (e) {
      toast(errorMessage(e, 'Failed to add files to workspace'))
      throw e
    }
  },

  deleteAsset: async (id: string) => {
    const workspaceId = get().activeWorkspaceId
    const previousAssets = get().assets
    const previousItems = get().items
    set((state) => ({
      assets: state.assets.filter((asset) => asset.id !== id),
      items: state.items.filter((item) => item.assetId !== id)
    }))
    try {
      await api.workspaceAssets.delete(id)
    } catch (e) {
      if (get().activeWorkspaceId === workspaceId) {
        set({ assets: previousAssets, items: previousItems })
      }
      toast(errorMessage(e, 'Failed to delete workspace file'))
    }
  },

  addItem: async (kind: WorkspaceItemKind, ids: string[], placement?: WorkspaceItemPlacement) => {
    const id = get().activeWorkspaceId
    if (!id || ids.length === 0) return
    try {
      if (placement) await api.workspaceItems.add(id, kind, ids, placement)
      else await api.workspaceItems.add(id, kind, ids)
      await get().fetchItems()
    } catch (e) {
      toast(errorMessage(e, 'Failed to add items to workspace'))
    }
  },

  removeItem: async (itemId: string) => {
    try {
      await api.workspaceItems.remove(itemId)
      await get().fetchItems()
    } catch (e) {
      toast(errorMessage(e, 'Failed to remove item'))
    }
  },

  reorderItems: async (orderedIds: string[]) => {
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
      if (get().activeWorkspaceId === workspaceId) set({ items: saved })
    } catch (e) {
      if (get().activeWorkspaceId === workspaceId) set({ items: previous })
      toast(errorMessage(e, 'Failed to reorder workspace items'))
    }
  },

  resizeItem: async (itemId: string, width: number, height: number) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return false
    const previousItem = get().items.find((item) => item.id === itemId)
    if (!previousItem) return false
    set((s) => ({
      items: s.items.map((item) => item.id === itemId ? { ...item, width, height } : item)
    }))
    try {
      const saved = await api.workspaceItems.resize(itemId, width, height)
      if (get().activeWorkspaceId !== workspaceId) return true
      set((s) => ({
        items: s.items.map((item) =>
          item.id === itemId && item.width === width && item.height === height ? saved : item
        )
      }))
      return true
    } catch (e) {
      if (get().activeWorkspaceId === workspaceId) {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === itemId && item.width === width && item.height === height
              ? previousItem
              : item
          )
        }))
      }
      toast(errorMessage(e, 'Failed to save card size'))
      return false
    }
  },

  moveItem: async (itemId: string, x: number, y: number, zIndex: number) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return false
    const previousItem = get().items.find((item) => item.id === itemId)
    if (!previousItem) return false
    set((s) => ({
      items: s.items.map((item) => item.id === itemId ? { ...item, x, y, zIndex } : item)
    }))
    try {
      const saved = await api.workspaceItems.move(itemId, x, y, zIndex)
      if (get().activeWorkspaceId !== workspaceId) return true
      set((s) => ({
        items: s.items.map((item) =>
          item.id === itemId && item.x === x && item.y === y && item.zIndex === zIndex
            ? saved
            : item
        )
      }))
      return true
    } catch (e) {
      if (get().activeWorkspaceId === workspaceId) {
        set((s) => ({
          items: s.items.map((item) =>
            item.id === itemId && item.x === x && item.y === y && item.zIndex === zIndex
              ? previousItem
              : item
          )
        }))
      }
      toast(errorMessage(e, 'Failed to save card position'))
      return false
    }
  },

  fetchReports: async () => {
    const id = get().activeWorkspaceId
    if (!id) {
      set({ reports: [] })
      return
    }
    try {
      const list = await api.reports.list(id)
      if (get().activeWorkspaceId !== id) return
      set({ reports: list })
    } catch (e) {
      if (get().activeWorkspaceId !== id) return
      toast(errorMessage(e, 'Failed to load reports'))
    }
  },

  deleteReport: async (id: string) => {
    const workspaceId = get().activeWorkspaceId
    const previousReports = get().reports
    const previousItems = get().items
    set((s) => ({
      reports: s.reports.filter((r) => r.id !== id),
      items: s.items.filter((item) => item.reportId !== id)
    }))
    try {
      await api.reports.delete(id)
    } catch (e) {
      if (get().activeWorkspaceId === workspaceId) {
        set({ reports: previousReports, items: previousItems })
      }
      toast(errorMessage(e, 'Failed to delete report'))
    }
  },

  updateReport: async (id: string, patch: { title?: string; contentMd?: string }) => {
    const workspaceId = get().activeWorkspaceId
    try {
      const updated = await api.reports.update(id, patch)
      if (get().activeWorkspaceId !== workspaceId) return true
      set((s) => ({ reports: s.reports.map((r) => (r.id === id ? updated : r)) }))
      return true
    } catch (e) {
      toast(errorMessage(e, 'Failed to update report'))
      return false
    }
  },

  fetchNotes: async () => {
    const id = get().activeWorkspaceId
    if (!id) {
      set({ notes: [] })
      return
    }
    try {
      const list = await api.workspaceNotes.list(id)
      if (get().activeWorkspaceId !== id) return
      set({ notes: list })
    } catch (e) {
      if (get().activeWorkspaceId !== id) return
      toast(errorMessage(e, 'Failed to load workspace notes'))
    }
  },

  createNote: async (
    title: string,
    contentMd: string,
    noteType: WorkspaceNoteType,
    placement?: WorkspaceItemPlacement
  ) => {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return null
    try {
      const note = placement
        ? await api.workspaceNotes.create(workspaceId, title, contentMd, noteType, placement)
        : await api.workspaceNotes.create(workspaceId, title, contentMd, noteType)
      if (get().activeWorkspaceId !== workspaceId) return null
      set((s) => ({ notes: [...s.notes, note] }))
      await get().fetchItems()
      return note
    } catch (e) {
      toast(errorMessage(e, 'Failed to create workspace note'))
      return null
    }
  },

  deleteNote: async (id: string) => {
    const workspaceId = get().activeWorkspaceId
    const previousNotes = get().notes
    const previousItems = get().items
    set((s) => ({
      notes: s.notes.filter((note) => note.id !== id),
      items: s.items.filter((item) => item.noteId !== id)
    }))
    try {
      await api.workspaceNotes.delete(id)
    } catch (e) {
      if (get().activeWorkspaceId === workspaceId) {
        set({ notes: previousNotes, items: previousItems })
      }
      toast(errorMessage(e, 'Failed to delete workspace note'))
    }
  },

  updateNote: async (id: string, patch: WorkspaceNotePatch) => {
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
    const execute = () => api.workspaceNotes.update(id, patch)
    const previousQueue = noteUpdateQueues.get(id)
    const request = previousQueue ? previousQueue.then(execute) : execute()
    const settled = request.then(() => undefined, () => undefined)
    noteUpdateQueues.set(id, settled)
    try {
      const updated = await request
      if (get().activeWorkspaceId !== workspaceId) return true
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
      if (previousNote && get().activeWorkspaceId === workspaceId) {
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
      toast(errorMessage(e, 'Failed to update workspace note'))
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
