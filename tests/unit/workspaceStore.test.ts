import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useWorkspaceStore } from '../../src/renderer/store/workspaceStore'
import { useDocumentStore } from '../../src/renderer/store/documentStore'
import migrationSql from '../../src/main/db/migrations/0014_workspace_board.sql?raw'
import canvasMigrationSql from '../../src/main/db/migrations/0015_workspace_canvas.sql?raw'
import noteTypesMigrationSql from '../../src/main/db/migrations/0016_workspace_note_types.sql?raw'
import type {
  AiReport,
  WorkspaceItem,
  WorkspaceItemsChangedEvent,
  WorkspaceNote,
  WorkspaceAsset
} from '../../src/shared/ipc-types'

function makeReport(overrides: Partial<AiReport> = {}): AiReport {
  return {
    id: 'r1',
    workspaceId: 'ws-1',
    title: 'Test Report',
    contentMd: 'Some content',
    sourceDocIds: [],
    model: 'gpt-4o',
    createdAt: 1700000000000,
    ...overrides
  }
}

function makeItem(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    id: 'item-1',
    workspaceId: 'ws-1',
    kind: 'document',
    docId: 'doc-1',
    reportId: null,
    noteId: null,
    assetId: null,
    sortOrder: 0,
    width: 300,
    height: 200,
    x: 0,
    y: 0,
    zIndex: 0,
    addedAt: 0,
    ...overrides
  }
}

function makeAsset(overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return {
    id: 'asset-1',
    workspaceId: 'ws-1',
    fileName: 'notes.txt',
    filePath: 'refora-assets/asset-1/notes.txt',
    sourcePath: '/tmp/notes.txt',
    mimeType: 'text/plain',
    previewKind: 'text',
    fileSize: 12,
    fileHash: 'hash',
    fileMissing: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeNote(overrides: Partial<WorkspaceNote> = {}): WorkspaceNote {
  return {
    id: 'note-1',
    workspaceId: 'ws-1',
    noteType: 'markdown',
    title: 'Note',
    contentMd: '',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const mockReportsList = vi.fn()
const mockReportsDelete = vi.fn()
const mockReportsUpdate = vi.fn()
const mockChatThreads = vi.fn()
const mockChatDeleteThread = vi.fn()
const mockRenameThread = vi.fn()
const mockEventsOff = vi.fn()
const mockOnWorkspaceItemsChanged = vi.fn()
const mockOnAiSummaryUpdated = vi.fn()
const mockOnAiReportCreated = vi.fn()
const mockWorkspacesList = vi.fn()
const mockWorkspacesCreate = vi.fn()
const mockWorkspacesRename = vi.fn()
const mockWorkspacesDelete = vi.fn()
const mockWorkspaceItemsList = vi.fn()
const mockWorkspaceItemsAdd = vi.fn()
const mockWorkspaceItemsRemove = vi.fn()
const mockWorkspaceItemsReorder = vi.fn()
const mockWorkspaceItemsResize = vi.fn()
const mockWorkspaceItemsMove = vi.fn()
const mockWorkspaceAssetsList = vi.fn()
const mockWorkspaceAssetsAddFiles = vi.fn()
const mockWorkspaceAssetsDelete = vi.fn()
const mockWorkspaceNotesList = vi.fn()
const mockWorkspaceNotesCreate = vi.fn()
const mockWorkspaceNotesDelete = vi.fn()
const mockWorkspaceNotesUpdate = vi.fn()
const mockShowToast = vi.fn()

function resetStoreState(): void {
  useWorkspaceStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    activeThreadId: null,
    panelOpen: false,
    fullscreen: false,
    items: [],
    reports: [],
    notes: [],
    assets: [],
    threads: [],
    markdownCardRequest: null,
    initialized: false
  })
}

beforeEach(() => {
  mockReportsList.mockReset()
  mockReportsDelete.mockReset()
  mockReportsUpdate.mockReset()
  mockChatThreads.mockReset()
  mockChatDeleteThread.mockReset()
  mockRenameThread.mockReset()
  mockEventsOff.mockReset()
  mockOnWorkspaceItemsChanged.mockReset()
  mockOnAiSummaryUpdated.mockReset()
  mockOnAiReportCreated.mockReset()
  mockWorkspacesList.mockReset()
  mockWorkspacesCreate.mockReset()
  mockWorkspacesRename.mockReset()
  mockWorkspacesDelete.mockReset()
  mockWorkspaceItemsList.mockReset()
  mockWorkspaceItemsAdd.mockReset()
  mockWorkspaceItemsRemove.mockReset()
  mockWorkspaceItemsReorder.mockReset()
  mockWorkspaceItemsResize.mockReset()
  mockWorkspaceItemsMove.mockReset()
  mockWorkspaceAssetsList.mockReset()
  mockWorkspaceAssetsAddFiles.mockReset()
  mockWorkspaceAssetsDelete.mockReset()
  mockWorkspaceNotesList.mockReset()
  mockWorkspaceNotesCreate.mockReset()
  mockWorkspaceNotesDelete.mockReset()
  mockWorkspaceNotesUpdate.mockReset()
  mockShowToast.mockReset()

  mockReportsList.mockResolvedValue([])
  mockReportsDelete.mockResolvedValue(undefined)
  mockReportsUpdate.mockResolvedValue(makeReport())
  mockChatThreads.mockResolvedValue([])
  mockChatDeleteThread.mockResolvedValue(undefined)
  mockRenameThread.mockResolvedValue(undefined)
  mockWorkspacesList.mockResolvedValue([])
  mockWorkspacesCreate.mockImplementation(async (name: string) => ({
    id: 'ws-new',
    name,
    createdAt: 1,
    updatedAt: 1
  }))
  mockWorkspacesRename.mockResolvedValue(undefined)
  mockWorkspacesDelete.mockResolvedValue(undefined)
  mockWorkspaceItemsList.mockResolvedValue([])
  mockWorkspaceItemsAdd.mockResolvedValue([])
  mockWorkspaceItemsRemove.mockResolvedValue(undefined)
  mockWorkspaceItemsReorder.mockResolvedValue([])
  mockWorkspaceItemsResize.mockImplementation(async (_id: string, width: number, height: number) =>
    makeItem({ width, height })
  )
  mockWorkspaceItemsMove.mockImplementation(async (id: string, x: number, y: number, zIndex: number) =>
    makeItem({ id, x, y, zIndex })
  )
  mockWorkspaceAssetsList.mockResolvedValue([])
  mockWorkspaceAssetsAddFiles.mockResolvedValue({ imported: [], errors: [] })
  mockWorkspaceAssetsDelete.mockResolvedValue(undefined)
  mockWorkspaceNotesList.mockResolvedValue([])
  mockWorkspaceNotesCreate.mockResolvedValue(makeNote())
  mockWorkspaceNotesDelete.mockResolvedValue(undefined)
  mockWorkspaceNotesUpdate.mockResolvedValue(makeNote())

  const api = window.api as unknown as Record<string, unknown>
  const reports = api.reports as Record<string, unknown>
  reports.list = mockReportsList
  reports.delete = mockReportsDelete
  reports.update = mockReportsUpdate

  const ai = api.ai as Record<string, unknown>
  ai.chatThreads = mockChatThreads
  ai.chatDeleteThread = mockChatDeleteThread
  ai.renameThread = mockRenameThread

  const events = api.events as Record<string, unknown>
  events.off = mockEventsOff
  events.onWorkspaceItemsChanged = mockOnWorkspaceItemsChanged
  events.onAiSummaryUpdated = mockOnAiSummaryUpdated
  events.onAiReportCreated = mockOnAiReportCreated

  const workspaces = api.workspaces as Record<string, unknown>
  workspaces.list = mockWorkspacesList
  workspaces.create = mockWorkspacesCreate
  workspaces.rename = mockWorkspacesRename
  workspaces.delete = mockWorkspacesDelete

  const workspaceItems = api.workspaceItems as Record<string, unknown>
  workspaceItems.list = mockWorkspaceItemsList
  workspaceItems.add = mockWorkspaceItemsAdd
  workspaceItems.remove = mockWorkspaceItemsRemove
  workspaceItems.reorder = mockWorkspaceItemsReorder
  workspaceItems.resize = mockWorkspaceItemsResize
  workspaceItems.move = mockWorkspaceItemsMove

  const workspaceAssets = api.workspaceAssets as Record<string, unknown>
  workspaceAssets.list = mockWorkspaceAssetsList
  workspaceAssets.addFiles = mockWorkspaceAssetsAddFiles
  workspaceAssets.delete = mockWorkspaceAssetsDelete

  const workspaceNotes = api.workspaceNotes as Record<string, unknown>
  workspaceNotes.list = mockWorkspaceNotesList
  workspaceNotes.create = mockWorkspaceNotesCreate
  workspaceNotes.delete = mockWorkspaceNotesDelete
  workspaceNotes.update = mockWorkspaceNotesUpdate

  useDocumentStore.setState({ showToast: mockShowToast })

  resetStoreState()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkspaceStore', () => {
  describe('openMarkdownCard', () => {
    it('opens the workspace panel and exposes a consumable Markdown-card request', () => {
      useWorkspaceStore.setState({ panelOpen: false })

      useWorkspaceStore.getState().openMarkdownCard('note', 'note-1')

      expect(useWorkspaceStore.getState()).toMatchObject({
        panelOpen: true,
        markdownCardRequest: { kind: 'note', id: 'note-1' }
      })
      useWorkspaceStore.getState().clearMarkdownCardRequest()
      expect(useWorkspaceStore.getState().markdownCardRequest).toBeNull()
    })
  })

  describe('deleteReport', () => {
    it('optimistically removes the report from state', async () => {
      const r1 = makeReport({ id: 'r1' })
      const r2 = makeReport({ id: 'r2', title: 'Second' })
      useWorkspaceStore.setState({ reports: [r1, r2] })
      mockReportsDelete.mockResolvedValue(undefined)

      const promise = useWorkspaceStore.getState().deleteReport('r1')
      expect(useWorkspaceStore.getState().reports).toEqual([r2])
      await promise
      expect(mockReportsDelete).toHaveBeenCalledWith('r1')
      expect(useWorkspaceStore.getState().reports).toEqual([r2])
    })

    it('restores the report on failure', async () => {
      const r1 = makeReport({ id: 'r1' })
      const r2 = makeReport({ id: 'r2', title: 'Second' })
      useWorkspaceStore.setState({ reports: [r1, r2] })
      mockReportsDelete.mockRejectedValue(new Error('network'))

      await useWorkspaceStore.getState().deleteReport('r1')

      expect(useWorkspaceStore.getState().reports).toEqual([r1, r2])
    })
  })

  describe('fetchReports', () => {
    it('populates reports from api', async () => {
      const reports = [makeReport({ id: 'r1' })]
      mockReportsList.mockResolvedValue(reports)
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })

      await useWorkspaceStore.getState().fetchReports()

      expect(mockReportsList).toHaveBeenCalledWith('ws-1')
      expect(useWorkspaceStore.getState().reports).toEqual(reports)
    })

    it('clears reports when no active workspace', async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: null, reports: [makeReport()] })
      await useWorkspaceStore.getState().fetchReports()
      expect(useWorkspaceStore.getState().reports).toEqual([])
    })
  })

  describe('updateReport', () => {
    it('does not restore reports from a workspace that is no longer active', async () => {
      let rejectUpdate!: (error: Error) => void
      mockReportsUpdate.mockReturnValue(new Promise((_resolve, reject) => {
        rejectUpdate = reject
      }))
      useWorkspaceStore.setState({
        activeWorkspaceId: 'ws-1',
        reports: [makeReport({ workspaceId: 'ws-1' })]
      })

      const update = useWorkspaceStore.getState().updateReport('r1', { title: 'Changed' })
      const nextReports = [makeReport({ id: 'r2', workspaceId: 'ws-2' })]
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-2', reports: nextReports })
      rejectUpdate(new Error('network'))

      await update
      expect(useWorkspaceStore.getState().reports).toEqual(nextReports)
    })
  })

  describe('setActiveWorkspace', () => {
    it('sets active workspace and fetches the latest thread', async () => {
      mockChatThreads.mockResolvedValue([
        { id: 'thread-1', workspaceId: 'ws-1', providerId: 'p1', createdAt: 0 }
      ])

      useWorkspaceStore.getState().setActiveWorkspace('ws-1')

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-1')
      expect(useWorkspaceStore.getState().panelOpen).toBe(true)
      await vi.waitFor(() => {
        expect(useWorkspaceStore.getState().activeThreadId).toBe('thread-1')
      })
    })

    it('sets activeThreadId to null when no threads exist', async () => {
      mockChatThreads.mockResolvedValue([])

      useWorkspaceStore.getState().setActiveWorkspace('ws-1')

      await vi.waitFor(() => {
        expect(useWorkspaceStore.getState().activeThreadId).toBe(null)
      })
    })

    it('loads global chat threads without opening a workspace panel', async () => {
      mockChatThreads.mockResolvedValue([
        { id: 'global-thread', workspaceId: null, providerId: 'p1', createdAt: 1, title: null }
      ])

      useWorkspaceStore.getState().setActiveWorkspace(null)

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull()
      expect(useWorkspaceStore.getState().panelOpen).toBe(false)
      await vi.waitFor(() => {
        expect(mockChatThreads).toHaveBeenCalledWith(null)
        expect(useWorkspaceStore.getState().activeThreadId).toBe('global-thread')
      })
      expect(mockWorkspaceItemsList).not.toHaveBeenCalled()
      expect(mockReportsList).not.toHaveBeenCalled()
    })

    it('preserves the selected thread during a normal refresh', async () => {
      const threads = [
        { id: 'latest', workspaceId: 'ws-1', providerId: 'p1', createdAt: 2, title: null },
        { id: 'selected', workspaceId: 'ws-1', providerId: 'p1', createdAt: 1, title: null }
      ]
      mockChatThreads.mockResolvedValue(threads)
      useWorkspaceStore.setState({
        activeWorkspaceId: 'ws-1',
        activeThreadId: 'selected'
      })

      await useWorkspaceStore.getState().fetchThreads()

      expect(useWorkspaceStore.getState().activeThreadId).toBe('selected')
    })

    it('clears content from the previous workspace immediately', () => {
      useWorkspaceStore.setState({
        activeWorkspaceId: 'ws-old',
        items: [makeItem({ workspaceId: 'ws-old' })],
        reports: [makeReport({ workspaceId: 'ws-old' })],
        notes: [makeNote({ workspaceId: 'ws-old' })]
      })

      useWorkspaceStore.getState().setActiveWorkspace('ws-new')

      expect(useWorkspaceStore.getState().items).toEqual([])
      expect(useWorkspaceStore.getState().reports).toEqual([])
      expect(useWorkspaceStore.getState().notes).toEqual([])
    })

    it('ignores an item response from a workspace that is no longer active', async () => {
      let resolveFirst!: (items: WorkspaceItem[]) => void
      let resolveSecond!: (items: WorkspaceItem[]) => void
      mockWorkspaceItemsList.mockImplementation((workspaceId: string) => new Promise<WorkspaceItem[]>((resolve) => {
        if (workspaceId === 'ws-1') resolveFirst = resolve
        else resolveSecond = resolve
      }))

      useWorkspaceStore.getState().setActiveWorkspace('ws-1')
      useWorkspaceStore.getState().setActiveWorkspace('ws-2')
      const secondItem = makeItem({ id: 'item-2', workspaceId: 'ws-2' })
      resolveSecond([secondItem])

      await vi.waitFor(() => {
        expect(useWorkspaceStore.getState().items).toEqual([secondItem])
      })

      resolveFirst([makeItem({ workspaceId: 'ws-1' })])
      await Promise.resolve()
      expect(useWorkspaceStore.getState().items).toEqual([secondItem])
    })
  })

  describe('board layout', () => {
    it('optimistically reorders all item kinds and keeps the saved order', async () => {
      const first = makeItem({ id: 'first', sortOrder: 0 })
      const second = makeItem({
        id: 'second',
        kind: 'report',
        docId: null,
        reportId: 'r1',
        sortOrder: 1
      })
      const saved = [{ ...second, sortOrder: 0 }, { ...first, sortOrder: 1 }]
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1', items: [first, second] })
      mockWorkspaceItemsReorder.mockResolvedValue(saved)

      const promise = useWorkspaceStore.getState().reorderItems(['second', 'first'])
      expect(useWorkspaceStore.getState().items.map((item) => item.id)).toEqual(['second', 'first'])
      await promise

      expect(mockWorkspaceItemsReorder).toHaveBeenCalledWith('ws-1', ['second', 'first'])
      expect(useWorkspaceStore.getState().items).toEqual(saved)
    })

    it('restores the previous card size when persistence fails', async () => {
      const item = makeItem()
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1', items: [item] })
      mockWorkspaceItemsResize.mockRejectedValue(new Error('disk'))

      const saved = await useWorkspaceStore.getState().resizeItem(item.id, 420, 280)

      expect(saved).toBe(false)
      expect(useWorkspaceStore.getState().items).toEqual([item])
    })

    it('preserves unrelated item changes when a resize fails', async () => {
      const first = makeItem({ id: 'first' })
      const second = makeItem({ id: 'second' })
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1', items: [first, second] })
      mockWorkspaceItemsResize.mockRejectedValue(new Error('disk'))

      const resize = useWorkspaceStore.getState().resizeItem(first.id, 420, 280)
      useWorkspaceStore.setState((state) => ({
        items: state.items.map((item) =>
          item.id === second.id ? { ...item, x: 900 } : item
        )
      }))

      await resize
      expect(useWorkspaceStore.getState().items).toEqual([first, { ...second, x: 900 }])
    })

    it('persists a freely positioned card in world coordinates', async () => {
      const item = makeItem()
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1', items: [item] })

      const saved = await useWorkspaceStore.getState().moveItem(item.id, -240, 460, 7)

      expect(saved).toBe(true)
      expect(mockWorkspaceItemsMove).toHaveBeenCalledWith(item.id, -240, 460, 7)
      expect(useWorkspaceStore.getState().items[0]).toMatchObject({ x: -240, y: 460, zIndex: 7 })
    })

    it('restores the previous position when persistence fails', async () => {
      const item = makeItem({ x: 20, y: 40, zIndex: 2 })
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1', items: [item] })
      mockWorkspaceItemsMove.mockRejectedValue(new Error('disk'))

      const saved = await useWorkspaceStore.getState().moveItem(item.id, 500, -120, 6)

      expect(saved).toBe(false)
      expect(useWorkspaceStore.getState().items).toEqual([item])
    })
  })

  describe('workspace notes', () => {
    it('creates a note and refreshes the unified item list', async () => {
      const note = makeNote()
      const item = makeItem({
        id: 'note-item',
        kind: 'note',
        docId: null,
        noteId: note.id
      })
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })
      mockWorkspaceNotesCreate.mockResolvedValue(note)
      mockWorkspaceItemsList.mockResolvedValue([item])

      const created = await useWorkspaceStore.getState().createNote(note.title, note.contentMd, note.noteType)

      expect(mockWorkspaceNotesCreate).toHaveBeenCalledWith('ws-1', note.title, note.contentMd, 'markdown')
      expect(created).toEqual(note)
      expect(useWorkspaceStore.getState().notes).toEqual([note])
      expect(useWorkspaceStore.getState().items).toEqual([item])
    })

    it('does not restore notes from a workspace that is no longer active', async () => {
      let rejectUpdate!: (error: Error) => void
      mockWorkspaceNotesUpdate.mockReturnValue(new Promise((_resolve, reject) => {
        rejectUpdate = reject
      }))
      useWorkspaceStore.setState({
        activeWorkspaceId: 'ws-1',
        notes: [makeNote({ workspaceId: 'ws-1' })]
      })

      const update = useWorkspaceStore.getState().updateNote('note-1', { title: 'Changed' })
      const nextNotes = [makeNote({ id: 'note-2', workspaceId: 'ws-2' })]
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-2', notes: nextNotes })
      rejectUpdate(new Error('network'))

      await update
      expect(useWorkspaceStore.getState().notes).toEqual(nextNotes)
    })
  })

  describe('workspace lifecycle actions', () => {
    it('creates, renames, and deletes the active workspace', async () => {
      const created = await useWorkspaceStore.getState().createWorkspace('New workspace')
      expect(created).toMatchObject({ id: 'ws-new', name: 'New workspace' })
      expect(useWorkspaceStore.getState().workspaces).toEqual([created])

      await useWorkspaceStore.getState().renameWorkspace('ws-new', 'Renamed')
      expect(mockWorkspacesRename).toHaveBeenCalledWith('ws-new', 'Renamed')
      expect(useWorkspaceStore.getState().workspaces[0].name).toBe('Renamed')

      useWorkspaceStore.setState({
        activeWorkspaceId: 'ws-new',
        activeThreadId: 'thread-1',
        panelOpen: true,
        items: [makeItem({ workspaceId: 'ws-new' })],
        reports: [makeReport({ workspaceId: 'ws-new' })],
        notes: [makeNote({ workspaceId: 'ws-new' })]
      })
      await useWorkspaceStore.getState().deleteWorkspace('ws-new')

      expect(mockWorkspacesDelete).toHaveBeenCalledWith('ws-new')
      expect(useWorkspaceStore.getState()).toMatchObject({
        activeWorkspaceId: null,
        activeThreadId: null,
        panelOpen: false,
        items: [],
        reports: [],
        notes: []
      })
    })

    it('shows errors when workspace mutations fail', async () => {
      mockWorkspacesCreate.mockRejectedValueOnce(new Error('create failed'))
      mockWorkspacesRename.mockRejectedValueOnce(new Error('rename failed'))
      mockWorkspacesDelete.mockRejectedValueOnce(new Error('delete failed'))

      expect(await useWorkspaceStore.getState().createWorkspace('Bad')).toBeNull()
      await useWorkspaceStore.getState().renameWorkspace('ws-1', 'Bad')
      await useWorkspaceStore.getState().deleteWorkspace('ws-1')
      expect(mockShowToast).toHaveBeenCalledTimes(3)
    })

    it('routes AI events and unregisters them on destroy', async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })
      useWorkspaceStore.getState().init()

      const summaryUpdated = mockOnAiSummaryUpdated.mock.calls[0][0] as (docId: string) => void
      const reportCreated = mockOnAiReportCreated.mock.calls[0][0] as (report: AiReport) => void
      mockReportsList.mockResolvedValue([makeReport()])
      summaryUpdated('doc-1')
      reportCreated(makeReport())

      await vi.waitFor(() => {
        expect(mockWorkspaceItemsList).toHaveBeenCalledWith('ws-1')
        expect(useWorkspaceStore.getState().reports).toHaveLength(1)
      })

      mockReportsList.mockResolvedValue([makeReport({ title: 'Updated report' })])
      reportCreated(makeReport({ title: 'Updated report' }))
      await vi.waitFor(() => {
        expect(useWorkspaceStore.getState().reports[0].title).toBe('Updated report')
      })

      useWorkspaceStore.getState().destroy()
      expect(mockEventsOff).toHaveBeenCalledWith('ai:summary:updated', summaryUpdated)
      expect(mockEventsOff).toHaveBeenCalledWith('ai:report:created', reportCreated)
      expect(mockEventsOff).toHaveBeenCalledWith('workspace:items:changed', expect.any(Function))
      expect(useWorkspaceStore.getState().initialized).toBe(false)
    })
  })

  describe('thread and panel actions', () => {
    it('updates thread, streaming, panel, and fullscreen state', () => {
      useWorkspaceStore.getState().setActiveThreadId('thread-1')
      useWorkspaceStore.getState().setChatStreaming(true)
      useWorkspaceStore.getState().openPanel()
      useWorkspaceStore.getState().toggleFullscreen()

      expect(useWorkspaceStore.getState()).toMatchObject({
        activeThreadId: 'thread-1',
        chatStreaming: true,
        panelOpen: true,
        fullscreen: true
      })

      useWorkspaceStore.getState().closePanel()
      expect(useWorkspaceStore.getState()).toMatchObject({
        panelOpen: false,
        fullscreen: false
      })

      useWorkspaceStore.getState().setChatStreaming(false)
      useWorkspaceStore.getState().openPanel()
      useWorkspaceStore.getState().closePanel()
      expect(useWorkspaceStore.getState().panelOpen).toBe(false)
    })

    it('deletes the active thread and renames threads optimistically', async () => {
      const thread = {
        id: 'thread-1',
        workspaceId: 'ws-1',
        providerId: 'provider-1',
        title: 'Original',
        createdAt: 0
      }
      useWorkspaceStore.setState({ threads: [thread], activeThreadId: 'thread-1' })

      await useWorkspaceStore.getState().deleteThread('thread-1')
      expect(mockChatDeleteThread).toHaveBeenCalledWith('thread-1')
      expect(useWorkspaceStore.getState().activeThreadId).toBeNull()

      await useWorkspaceStore.getState().renameThread('thread-1', 'Renamed')
      expect(mockRenameThread).toHaveBeenCalledWith('thread-1', 'Renamed')
      expect(useWorkspaceStore.getState().threads[0].title).toBe('Renamed')

      mockRenameThread.mockRejectedValueOnce(new Error('rename failed'))
      await useWorkspaceStore.getState().renameThread('thread-1', 'Rejected')
      expect(useWorkspaceStore.getState().threads[0].title).toBe('Renamed')
      expect(mockShowToast).toHaveBeenCalled()
    })

    it('shows an error when deleting a thread fails', async () => {
      mockChatDeleteThread.mockRejectedValueOnce(new Error('delete failed'))
      await useWorkspaceStore.getState().deleteThread('thread-1')
      expect(mockShowToast).toHaveBeenCalledWith('delete failed')
    })
  })

  describe('item actions', () => {
    it('adds documents and other items with placement and refreshes items', async () => {
      const placement = { x: 120, y: 240 }
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })

      await useWorkspaceStore.getState().addDocs(['doc-1'], placement)
      expect(mockWorkspaceItemsAdd).toHaveBeenCalledWith(
        'ws-1',
        'document',
        ['doc-1'],
        placement
      )

      await useWorkspaceStore.getState().addItem('report', ['report-1'])
      expect(mockWorkspaceItemsAdd).toHaveBeenCalledWith('ws-1', 'report', ['report-1'])
      expect(mockWorkspaceItemsList).toHaveBeenCalledWith('ws-1')
    })

    it('removes items and reports add failures', async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })
      await useWorkspaceStore.getState().removeItem('item-1')
      expect(mockWorkspaceItemsRemove).toHaveBeenCalledWith('item-1')

      mockWorkspaceItemsAdd.mockRejectedValueOnce(new Error('add failed'))
      await expect(useWorkspaceStore.getState().addDocs(['doc-1'])).rejects.toThrow('add failed')
      expect(mockShowToast).toHaveBeenCalledWith('add failed')

      mockWorkspaceItemsAdd.mockRejectedValueOnce(new Error('item failed'))
      await useWorkspaceStore.getState().addItem('report', ['report-1'])
      expect(mockShowToast).toHaveBeenCalledWith('item failed')

      mockWorkspaceItemsRemove.mockRejectedValueOnce(new Error('remove failed'))
      await useWorkspaceStore.getState().removeItem('item-1')
      expect(mockShowToast).toHaveBeenCalledWith('remove failed')
    })

    it('imports managed files and deletes their cards optimistically', async () => {
      const asset = makeAsset()
      const item = makeItem({
        kind: 'asset',
        docId: null,
        assetId: asset.id
      })
      const placement = { x: 20, y: 30 }
      mockWorkspaceAssetsAddFiles.mockResolvedValue({ imported: [asset], errors: [] })
      mockWorkspaceAssetsList.mockResolvedValue([asset])
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })

      await useWorkspaceStore.getState().addAssets(['/tmp/notes.txt'], placement)
      expect(mockWorkspaceAssetsAddFiles).toHaveBeenCalledWith(
        'ws-1',
        ['/tmp/notes.txt'],
        placement
      )
      expect(mockWorkspaceAssetsList).toHaveBeenCalledWith('ws-1')

      useWorkspaceStore.setState({ assets: [asset], items: [item] })
      const deletion = useWorkspaceStore.getState().deleteAsset(asset.id)
      expect(useWorkspaceStore.getState().assets).toEqual([])
      expect(useWorkspaceStore.getState().items).toEqual([])
      await deletion
      expect(mockWorkspaceAssetsDelete).toHaveBeenCalledWith(asset.id)
    })

    it('deletes notes optimistically and restores them on failure', async () => {
      const note = makeNote()
      const item = makeItem({ kind: 'note', docId: null, noteId: note.id })
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1', notes: [note], items: [item] })

      await useWorkspaceStore.getState().deleteNote(note.id)
      expect(mockWorkspaceNotesDelete).toHaveBeenCalledWith(note.id)
      expect(useWorkspaceStore.getState().notes).toEqual([])
      expect(useWorkspaceStore.getState().items).toEqual([])

      useWorkspaceStore.setState({ notes: [note], items: [item] })
      mockWorkspaceNotesDelete.mockRejectedValueOnce(new Error('delete failed'))
      await useWorkspaceStore.getState().deleteNote(note.id)
      expect(useWorkspaceStore.getState().notes).toEqual([note])
      expect(useWorkspaceStore.getState().items).toEqual([item])
    })
  })

  describe('startNewChat', () => {
    it('clears the active thread id', () => {
      useWorkspaceStore.setState({ activeThreadId: 'thread-1' })
      useWorkspaceStore.getState().startNewChat()
      expect(useWorkspaceStore.getState().activeThreadId).toBe(null)
    })
  })

  describe('onWorkspaceItemsChanged', () => {
    it('fetches items when workspaceId matches active workspace', async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })
      useWorkspaceStore.getState().init()

      expect(mockOnWorkspaceItemsChanged).toHaveBeenCalledTimes(1)
      const cb = mockOnWorkspaceItemsChanged.mock.calls[0][0] as (
        payload: WorkspaceItemsChangedEvent
      ) => void
      cb({ workspaceId: 'ws-1', reason: 'agent_add_docs' })

      await vi.waitFor(() => {
        expect(mockWorkspaceItemsList).toHaveBeenCalledWith('ws-1')
        expect(mockReportsList).toHaveBeenCalledWith('ws-1')
        expect(mockWorkspaceNotesList).toHaveBeenCalledWith('ws-1')
        expect(mockWorkspaceAssetsList).toHaveBeenCalledWith('ws-1')
      })
    })

    it('does not fetch items when workspaceId does not match', async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'ws-1' })
      useWorkspaceStore.getState().init()

      const cb = mockOnWorkspaceItemsChanged.mock.calls[0][0] as (
        payload: WorkspaceItemsChangedEvent
      ) => void
      cb({ workspaceId: 'ws-other', reason: 'user' })

      await new Promise((r) => setTimeout(r, 50))
      expect(mockWorkspaceItemsList).not.toHaveBeenCalled()
    })
  })
})

describe('workspace board migration', () => {
  let directory: string
  let dbPath: string

  const runSql = (sql: string) => {
    execFileSync('/usr/bin/sqlite3', [dbPath], {
      input: `PRAGMA foreign_keys = ON;\n${sql}`,
      encoding: 'utf8'
    })
  }

  const query = <T>(sql: string): T[] => {
    const output = execFileSync('/usr/bin/sqlite3', ['-json', dbPath], {
      input: `PRAGMA foreign_keys = ON;\n${sql}`,
      encoding: 'utf8'
    })
    return output.trim() ? JSON.parse(output) as T[] : []
  }

  const rejectsSql = (sql: string): boolean => {
    const result = spawnSync('/usr/bin/sqlite3', [dbPath], {
      input: `PRAGMA foreign_keys = ON;\n${sql}`,
      encoding: 'utf8'
    })
    return result.status !== 0
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'refora-workspace-migration-'))
    dbPath = join(directory, 'test.sqlite')
    runSql(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE documents (id TEXT PRIMARY KEY);
      CREATE TABLE ai_reports (
        id TEXT PRIMARY KEY,
        workspaceId TEXT NOT NULL,
        title TEXT NOT NULL,
        contentMd TEXT NOT NULL,
        sourceDocIds TEXT NOT NULL DEFAULT '[]',
        model TEXT,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE workspace_items (
        id TEXT PRIMARY KEY,
        workspaceId TEXT NOT NULL,
        kind TEXT NOT NULL,
        docId TEXT,
        reportId TEXT,
        sortOrder INTEGER NOT NULL DEFAULT 0,
        addedAt INTEGER NOT NULL,
        FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_workspace_items_ws ON workspace_items(workspaceId);
      INSERT INTO workspaces VALUES ('ws-1', 'Research', 1, 1);
      INSERT INTO documents VALUES ('doc-1');
      INSERT INTO ai_reports VALUES ('report-1', 'ws-1', 'Pinned', '# Pinned', '[]', NULL, 2);
      INSERT INTO ai_reports VALUES ('report-2', 'ws-1', 'Unpinned', '# Unpinned', '[]', NULL, 3);
      INSERT INTO workspace_items VALUES ('item-doc', 'ws-1', 'document', 'doc-1', NULL, 0, 1);
      INSERT INTO workspace_items VALUES ('item-doc-duplicate', 'ws-1', 'document', 'doc-1', NULL, 1, 2);
      INSERT INTO workspace_items VALUES ('item-report', 'ws-1', 'report', NULL, 'report-1', 2, 2);
      INSERT INTO workspace_items VALUES ('item-orphan', 'ws-1', 'document', 'missing', NULL, 3, 2);
    `)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('deduplicates old items, removes orphans, and preserves every report', () => {
    runSql(migrationSql)
    runSql(canvasMigrationSql)
    runSql(noteTypesMigrationSql)

    const items = query<Record<string, unknown>>(
      'SELECT kind, docId, reportId, noteId, width, height, x, y, zIndex FROM workspace_items ORDER BY sortOrder;'
    )

    expect(items).toHaveLength(3)
    expect(items.filter((item) => item.docId === 'doc-1')).toHaveLength(1)
    expect(items.map((item) => item.reportId).filter(Boolean)).toEqual(['report-1', 'report-2'])
    expect(items.every((item) => item.width === 300 && item.height === 200)).toBe(true)
    expect(items.map((item) => [item.x, item.y, item.zIndex])).toEqual([
      [0, 0, 0],
      [664, 0, 2],
      [996, 0, 3]
    ])
  })

  it('enforces item type, reference, size, and uniqueness constraints', () => {
    runSql(migrationSql)
    runSql(canvasMigrationSql)
    runSql(noteTypesMigrationSql)
    runSql(`
      INSERT INTO workspace_notes (id, workspaceId, title, contentMd, createdAt, updatedAt)
      VALUES ('note-1', 'ws-1', 'Note', '', 4, 4);
      INSERT INTO workspace_items
        (id, workspaceId, kind, docId, reportId, noteId, sortOrder, width, height, addedAt)
      VALUES ('item-note', 'ws-1', 'note', NULL, NULL, 'note-1', 3, 320, 240, 4);
    `)

    expect(rejectsSql(`
      INSERT INTO workspace_items
        (id, workspaceId, kind, docId, reportId, noteId, sortOrder, width, height, addedAt)
      VALUES ('bad-kind', 'ws-1', 'other', NULL, NULL, NULL, 4, 300, 200, 4);
    `)).toBe(true)
    expect(rejectsSql(`
      INSERT INTO workspace_items
        (id, workspaceId, kind, docId, reportId, noteId, sortOrder, width, height, addedAt)
      VALUES ('bad-size', 'ws-1', 'note', NULL, NULL, 'note-1', 4, 900, 200, 4);
    `)).toBe(true)
    expect(rejectsSql(`
      INSERT INTO workspace_items
        (id, workspaceId, kind, docId, reportId, noteId, sortOrder, width, height, addedAt)
      VALUES ('duplicate-doc', 'ws-1', 'document', 'doc-1', NULL, NULL, 4, 300, 200, 4);
    `)).toBe(true)
  })

  it('removes a report card when its report is deleted', () => {
    runSql(migrationSql)
    runSql(canvasMigrationSql)
    runSql(noteTypesMigrationSql)
    runSql("DELETE FROM ai_reports WHERE id = 'report-1';")

    const items = query<{ id: string }>("SELECT id FROM workspace_items WHERE reportId = 'report-1';")
    expect(items).toEqual([])
  })

  it('persists one bounded viewport per workspace and cascades it on deletion', () => {
    runSql(migrationSql)
    runSql(canvasMigrationSql)
    runSql(noteTypesMigrationSql)
    runSql(`
      INSERT INTO workspace_canvas_state (workspaceId, panX, panY, zoom, updatedAt)
      VALUES ('ws-1', -240.5, 320.25, 1.75, 5);
    `)

    expect(query<Record<string, unknown>>('SELECT panX, panY, zoom FROM workspace_canvas_state;')).toEqual([
      { panX: -240.5, panY: 320.25, zoom: 1.75 }
    ])
    expect(rejectsSql(`
      UPDATE workspace_canvas_state SET zoom = 4 WHERE workspaceId = 'ws-1';
    `)).toBe(true)

    runSql("DELETE FROM workspaces WHERE id = 'ws-1';")
    expect(query<Record<string, unknown>>('SELECT * FROM workspace_canvas_state;')).toEqual([])
  })

  it('defaults existing notes to markdown and constrains new note types', () => {
    runSql(migrationSql)
    runSql(canvasMigrationSql)
    runSql(`
      INSERT INTO workspace_notes (id, workspaceId, title, contentMd, createdAt, updatedAt)
      VALUES ('legacy-note', 'ws-1', 'Legacy', '', 4, 4);
    `)
    runSql(noteTypesMigrationSql)
    runSql(`
      INSERT INTO workspace_notes (id, workspaceId, noteType, title, contentMd, createdAt, updatedAt)
      VALUES ('sticky-note', 'ws-1', 'plain', 'Sticky', 'Text', 5, 5);
    `)

    expect(query<{ id: string; noteType: string }>(
      'SELECT id, noteType FROM workspace_notes ORDER BY id;'
    )).toEqual([
      { id: 'legacy-note', noteType: 'markdown' },
      { id: 'sticky-note', noteType: 'plain' }
    ])
    expect(rejectsSql(`
      INSERT INTO workspace_notes (id, workspaceId, noteType, title, contentMd, createdAt, updatedAt)
      VALUES ('bad-note', 'ws-1', 'rich-text', 'Bad', '', 6, 6);
    `)).toBe(true)
  })
})
