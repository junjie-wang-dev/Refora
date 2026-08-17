import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../../src/shared/ipc-channels'
import type { ReforaApi } from '../../src/shared/ipc-types'

const bridgeState = vi.hoisted(() => ({ api: undefined as unknown }))
const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      bridgeState.api = api
      electronMocks.exposeInMainWorld(name, api)
    }
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener
  },
  webUtils: { getPathForFile: electronMocks.getPathForFile }
}))

interface InvocationCase {
  channel: string
  args: unknown[]
  invoke: (api: ReforaApi) => Promise<unknown>
}

describe('preload IPC bridge', () => {
  let api: ReforaApi

  beforeAll(async () => {
    await import('../../src/preload/index')
    api = bridgeState.api as ReforaApi
  })

  beforeEach(() => {
    vi.clearAllMocks()
    electronMocks.invoke.mockResolvedValue({ ok: true, data: null })
    electronMocks.getPathForFile.mockReturnValue('/tmp/paper.pdf')
  })

  it('exposes the typed API in the main world', () => {
    expect(api).toBeDefined()
    expect(bridgeState.api).toBe(api)
  })

  it('forwards every request method to its shared IPC channel', async () => {
    const cases: InvocationCase[] = [
      { channel: IpcChannel.Bootstrap, args: [], invoke: (value) => value.getBootstrap() },
      { channel: IpcChannel.DocumentsList, args: [{ mode: 'all' }], invoke: (value) => value.documents.list({ mode: 'all' }) },
      { channel: IpcChannel.DocumentsCount, args: [], invoke: (value) => value.documents.counts() },
      { channel: IpcChannel.DocumentsSearch, args: ['query'], invoke: (value) => value.documents.search('query') },
      { channel: IpcChannel.DocumentsGet, args: ['doc-1'], invoke: (value) => value.documents.get('doc-1') },
      { channel: IpcChannel.DocumentsUpdate, args: ['doc-1', { title: 'Title' }], invoke: (value) => value.documents.update('doc-1', { title: 'Title' }) },
      { channel: IpcChannel.DocumentsSetStarred, args: ['doc-1', true], invoke: (value) => value.documents.setStarred('doc-1', true) },
      { channel: IpcChannel.DocumentsDelete, args: ['doc-1'], invoke: (value) => value.documents.delete('doc-1') },
      { channel: IpcChannel.DocumentsBulkDelete, args: [['doc-1']], invoke: (value) => value.documents.bulkDelete(['doc-1']) },
      { channel: IpcChannel.DocumentsBulkCategorize, args: [['doc-1'], 'cat-1'], invoke: (value) => value.documents.bulkCategorize(['doc-1'], 'cat-1') },
      { channel: IpcChannel.DocumentsBulkRefreshMetadata, args: [['doc-1']], invoke: (value) => value.documents.bulkRefreshMetadata(['doc-1']) },
      { channel: IpcChannel.DocumentsOpenPdf, args: ['doc-1'], invoke: (value) => value.documents.openPdf('doc-1') },
      { channel: IpcChannel.DocumentsReadPdf, args: ['doc-1'], invoke: (value) => value.documents.readPdf('doc-1') },
      { channel: IpcChannel.DocumentsPdfAnnotationsGet, args: ['doc-1'], invoke: (value) => value.documents.pdfAnnotations('doc-1') },
      { channel: IpcChannel.DocumentsPdfAnnotationsSet, args: ['doc-1', []], invoke: (value) => value.documents.setPdfAnnotations('doc-1', []) },
      { channel: IpcChannel.DocumentsOpenInFinder, args: ['doc-1'], invoke: (value) => value.documents.openInFinder('doc-1') },
      { channel: IpcChannel.DocumentsRefreshMetadata, args: ['doc-1'], invoke: (value) => value.documents.refreshMetadata('doc-1') },
      { channel: IpcChannel.DocumentsRelocateFile, args: ['doc-1', '/tmp/paper.pdf'], invoke: (value) => value.documents.relocateFile('doc-1', '/tmp/paper.pdf') },
      { channel: IpcChannel.DocumentsRestoreFile, args: ['doc-1'], invoke: (value) => value.documents.restoreFile('doc-1') },
      { channel: IpcChannel.GlobalSearch, args: ['query'], invoke: (value) => value.search.global('query') },
      { channel: IpcChannel.ImportAddFiles, args: [['/tmp/paper.pdf']], invoke: (value) => value.import.addFiles(['/tmp/paper.pdf']) },
      { channel: IpcChannel.ImportAddFolder, args: ['/tmp'], invoke: (value) => value.import.addFolder('/tmp') },
      { channel: IpcChannel.ImportFromJson, args: ['/tmp/export.json'], invoke: (value) => value.import.fromJson('/tmp/export.json') },
      { channel: IpcChannel.ImportFromZotero, args: [], invoke: (value) => value.import.fromZotero() },
      { channel: IpcChannel.ImportFromMendeley, args: [], invoke: (value) => value.import.fromMendeley() },
      { channel: IpcChannel.ImportFromIdentifier, args: ['10.1/test'], invoke: (value) => value.import.fromIdentifier('10.1/test') },
      { channel: IpcChannel.CategoriesList, args: [], invoke: (value) => value.categories.list() },
      { channel: IpcChannel.CategoriesCreate, args: ['Category'], invoke: (value) => value.categories.create('Category') },
      { channel: IpcChannel.CategoriesRename, args: ['cat-1', 'Renamed'], invoke: (value) => value.categories.rename('cat-1', 'Renamed') },
      { channel: IpcChannel.CategoriesDelete, args: ['cat-1'], invoke: (value) => value.categories.delete('cat-1') },
      { channel: IpcChannel.CategoriesAssign, args: ['doc-1', 'cat-1'], invoke: (value) => value.categories.assign('doc-1', 'cat-1') },
      { channel: IpcChannel.CategoriesUnassign, args: ['doc-1', 'cat-1'], invoke: (value) => value.categories.unassign('doc-1', 'cat-1') },
      { channel: IpcChannel.WatchList, args: [], invoke: (value) => value.watch.list() },
      { channel: IpcChannel.WatchAdd, args: ['/tmp/watch'], invoke: (value) => value.watch.add('/tmp/watch') },
      { channel: IpcChannel.WatchRemove, args: ['watch-1'], invoke: (value) => value.watch.remove('watch-1') },
      { channel: IpcChannel.WatchToggle, args: ['watch-1', true], invoke: (value) => value.watch.toggle('watch-1', true) },
      { channel: IpcChannel.SettingsGet, args: ['language', 'en'], invoke: (value) => value.settings.get('language', 'en') },
      { channel: IpcChannel.SettingsSet, args: ['language', 'zh'], invoke: (value) => value.settings.set('language', 'zh') },
      { channel: IpcChannel.AppearanceSetThemeSource, args: ['dark'], invoke: (value) => value.appearance.setThemeSource('dark') },
      { channel: IpcChannel.WebSearchConfigGet, args: [], invoke: (value) => value.webSearch.getConfig() },
      { channel: IpcChannel.WebSearchConfigUpdate, args: [{ provider: 'ddgs' }], invoke: (value) => value.webSearch.updateConfig({ provider: 'ddgs' }) },
      { channel: IpcChannel.WebSearchTest, args: [], invoke: (value) => value.webSearch.test() },
      { channel: IpcChannel.DialogOpenDirectory, args: [], invoke: (value) => value.dialog.openDirectory() },
      { channel: IpcChannel.LibrarySwitch, args: ['/library'], invoke: (value) => value.library.switch('/library') },
      { channel: IpcChannel.ExportToJson, args: [], invoke: (value) => value.export.toJson() },
      { channel: IpcChannel.ExportToBibtex, args: [['doc-1']], invoke: (value) => value.export.toBibtex(['doc-1']) },
      { channel: IpcChannel.ExportBibtexString, args: [['doc-1']], invoke: (value) => value.export.toBibtexString(['doc-1']) },
      { channel: IpcChannel.ClipboardWriteText, args: ['Sticky text'], invoke: (value) => value.clipboard.writeText('Sticky text') },
      { channel: IpcChannel.ClipboardCopyMarkdown, args: ['Note', '# Note'], invoke: (value) => value.clipboard.copyMarkdown('Note', '# Note') },
      { channel: IpcChannel.ClipboardCopyWorkspaceAsset, args: ['asset-1'], invoke: (value) => value.clipboard.copyWorkspaceAsset('asset-1') },
      { channel: IpcChannel.WorkspacesList, args: [], invoke: (value) => value.workspaces.list() },
      { channel: IpcChannel.WorkspacesCreate, args: ['Workspace'], invoke: (value) => value.workspaces.create('Workspace') },
      { channel: IpcChannel.WorkspacesRename, args: ['workspace-1', 'Renamed'], invoke: (value) => value.workspaces.rename('workspace-1', 'Renamed') },
      { channel: IpcChannel.WorkspacesDelete, args: ['workspace-1'], invoke: (value) => value.workspaces.delete('workspace-1') },
      { channel: IpcChannel.WorkspacesOpenSandbox, args: ['workspace-1'], invoke: (value) => value.workspaces.openSandbox('workspace-1') },
      { channel: IpcChannel.WorkspaceItemsList, args: ['workspace-1'], invoke: (value) => value.workspaceItems.list('workspace-1') },
      { channel: IpcChannel.WorkspaceItemsAdd, args: ['workspace-1', 'document', ['doc-1'], { x: 1, y: 2 }], invoke: (value) => value.workspaceItems.add('workspace-1', 'document', ['doc-1'], { x: 1, y: 2 }) },
      { channel: IpcChannel.WorkspaceItemsRemove, args: ['item-1'], invoke: (value) => value.workspaceItems.remove('item-1') },
      { channel: IpcChannel.WorkspaceItemsReorder, args: ['workspace-1', ['item-1']], invoke: (value) => value.workspaceItems.reorder('workspace-1', ['item-1']) },
      { channel: IpcChannel.WorkspaceItemsResize, args: ['item-1', 320, 240], invoke: (value) => value.workspaceItems.resize('item-1', 320, 240) },
      { channel: IpcChannel.WorkspaceItemsMove, args: ['item-1', 10, 20, 3], invoke: (value) => value.workspaceItems.move('item-1', 10, 20, 3) },
      { channel: IpcChannel.WorkspaceAssetsList, args: ['workspace-1'], invoke: (value) => value.workspaceAssets.list('workspace-1') },
      { channel: IpcChannel.WorkspaceAssetsAddFiles, args: ['workspace-1', ['/tmp/file.txt'], { x: 1, y: 2 }], invoke: (value) => value.workspaceAssets.addFiles('workspace-1', ['/tmp/file.txt'], { x: 1, y: 2 }) },
      { channel: IpcChannel.WorkspaceAssetsTextPreview, args: ['asset-1'], invoke: (value) => value.workspaceAssets.textPreview('asset-1') },
      { channel: IpcChannel.WorkspaceAssetsOpen, args: ['asset-1'], invoke: (value) => value.workspaceAssets.open('asset-1') },
      { channel: IpcChannel.WorkspaceAssetsReveal, args: ['asset-1'], invoke: (value) => value.workspaceAssets.reveal('asset-1') },
      { channel: IpcChannel.WorkspaceAssetsDelete, args: ['asset-1'], invoke: (value) => value.workspaceAssets.delete('asset-1') },
      { channel: IpcChannel.WorkspaceFilesAdd, args: ['workspace-1', ['/tmp/paper.pdf'], { x: 1, y: 2 }], invoke: (value) => value.workspaceFiles.add('workspace-1', ['/tmp/paper.pdf'], { x: 1, y: 2 }) },
      { channel: IpcChannel.WorkspaceNotesList, args: ['workspace-1'], invoke: (value) => value.workspaceNotes.list('workspace-1') },
      { channel: IpcChannel.WorkspaceNotesCreate, args: ['workspace-1', 'Note', 'Body', 'plain', { x: 1, y: 2 }], invoke: (value) => value.workspaceNotes.create('workspace-1', 'Note', 'Body', 'plain', { x: 1, y: 2 }) },
      { channel: IpcChannel.WorkspaceNotesUpdate, args: ['note-1', { title: 'Updated' }], invoke: (value) => value.workspaceNotes.update('note-1', { title: 'Updated' }) },
      { channel: IpcChannel.WorkspaceNotesDelete, args: ['note-1'], invoke: (value) => value.workspaceNotes.delete('note-1') },
      { channel: IpcChannel.WorkspaceCanvasGet, args: ['workspace-1'], invoke: (value) => value.workspaceCanvas.get('workspace-1') },
      { channel: IpcChannel.WorkspaceCanvasUpdate, args: ['workspace-1', { panX: 1, panY: 2, zoom: 1.5 }], invoke: (value) => value.workspaceCanvas.update('workspace-1', { panX: 1, panY: 2, zoom: 1.5 }) },
      { channel: IpcChannel.WorkspaceConnectionsList, args: ['workspace-1'], invoke: (value) => value.workspaceConnections.list('workspace-1') },
      { channel: IpcChannel.WorkspaceConnectionsCreate, args: ['workspace-1', 'item-1', 'item-2', 'right', 'left'], invoke: (value) => value.workspaceConnections.create('workspace-1', 'item-1', 'item-2', 'right', 'left') },
      { channel: IpcChannel.WorkspaceConnectionsDelete, args: ['connection-1'], invoke: (value) => value.workspaceConnections.delete('connection-1') },
      { channel: IpcChannel.AiProvidersList, args: [], invoke: (value) => value.aiProviders.list() },
      { channel: IpcChannel.AiProvidersCreate, args: [{ name: 'Provider', baseUrl: 'https://example.com', model: 'model' }], invoke: (value) => value.aiProviders.create({ name: 'Provider', baseUrl: 'https://example.com', model: 'model' }) },
      { channel: IpcChannel.AiProvidersUpdate, args: ['provider-1', { name: 'Updated' }], invoke: (value) => value.aiProviders.update('provider-1', { name: 'Updated' }) },
      { channel: IpcChannel.AiProvidersDelete, args: ['provider-1'], invoke: (value) => value.aiProviders.delete('provider-1') },
      { channel: IpcChannel.AiProvidersTest, args: ['provider-1'], invoke: (value) => value.aiProviders.test('provider-1') },
      { channel: IpcChannel.AiProvidersListModels, args: [{ providerId: 'provider-1' }], invoke: (value) => value.aiProviders.listModels({ providerId: 'provider-1' }) },
      { channel: IpcChannel.AiDocTextGet, args: ['doc-1'], invoke: (value) => value.ai.docTextGet('doc-1') },
      { channel: IpcChannel.AiSummarize, args: ['doc-1'], invoke: (value) => value.ai.summarize('doc-1') },
      { channel: IpcChannel.AiSummaryGet, args: ['doc-1'], invoke: (value) => value.ai.summaryGet('doc-1') },
      { channel: IpcChannel.AiChatSend, args: [{ workspaceId: 'workspace-1', text: 'Hello', providerId: 'provider-1' }], invoke: (value) => value.ai.chatSend({ workspaceId: 'workspace-1', text: 'Hello', providerId: 'provider-1' }) },
      { channel: IpcChannel.AiChatHistory, args: ['thread-1'], invoke: (value) => value.ai.chatHistory('thread-1') },
      { channel: IpcChannel.AiChatThreads, args: ['workspace-1'], invoke: (value) => value.ai.chatThreads('workspace-1') },
      { channel: IpcChannel.AiUsageStats, args: [], invoke: (value) => value.ai.usageStats() },
      { channel: IpcChannel.AiChatTraces, args: ['thread-1'], invoke: (value) => value.ai.chatTraces('thread-1') },
      { channel: IpcChannel.AiChatRun, args: ['run-1'], invoke: (value) => value.ai.chatRun('run-1') },
      { channel: IpcChannel.AiChatCancel, args: ['run-1'], invoke: (value) => value.ai.chatCancel('run-1') },
      { channel: IpcChannel.AiChatDeleteThread, args: ['thread-1'], invoke: (value) => value.ai.chatDeleteThread('thread-1') },
      { channel: IpcChannel.AiChatRenameThread, args: ['thread-1', 'Title'], invoke: (value) => value.ai.renameThread('thread-1', 'Title') },
      { channel: IpcChannel.AiReportsList, args: ['workspace-1'], invoke: (value) => value.reports.list('workspace-1') },
      { channel: IpcChannel.AiReportsUpdate, args: ['report-1', { title: 'Updated' }], invoke: (value) => value.reports.update('report-1', { title: 'Updated' }) },
      { channel: IpcChannel.AiReportsDelete, args: ['report-1'], invoke: (value) => value.reports.delete('report-1') }
    ]

    for (const testCase of cases) {
      electronMocks.invoke.mockClear()
      await testCase.invoke(api)
      expect(electronMocks.invoke).toHaveBeenCalledOnce()
      expect(electronMocks.invoke).toHaveBeenCalledWith(testCase.channel, ...testCase.args)
    }
  })

  it('unwraps failed Result envelopes into serializable IPC errors', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'not_found', message: 'Document missing' }
    })

    await expect(api.documents.get('missing')).rejects.toMatchObject({
      name: 'IpcResponseError',
      code: 'not_found',
      message: 'Document missing'
    })
  })

  it('delegates local file path resolution to Electron webUtils', () => {
    const file = { name: 'paper.pdf' }
    expect(api.getPathForFile(file)).toBe('/tmp/paper.pdf')
    expect(electronMocks.getPathForFile).toHaveBeenCalledWith(file)
  })

  it('builds encoded read-only preview URLs without invoking IPC', () => {
    expect(api.documents.previewUrl('doc / 1', 'hash / 1')).toBe(
      'refora-document://preview/doc%20%2F%201?v=hash%20%2F%201'
    )
    expect(api.workspaceAssets.previewUrl('asset / 1')).toBe('refora-asset://asset/asset%20%2F%201')
    expect(electronMocks.invoke).not.toHaveBeenCalled()
  })

  it('forwards the built-in reader flag only when external opening is disabled', async () => {
    await api.documents.openPdf('doc-1', false)
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      IpcChannel.DocumentsOpenPdf,
      'doc-1',
      false
    )
  })

  it('subscribes every event method and forwards only the payload', () => {
    const eventCases: Array<[string, (cb: () => void) => void]> = [
      [IpcChannel.EventDocumentUpdated, (cb) => api.events.onDocumentUpdated(cb)],
      [IpcChannel.EventWindowFocusChanged, (cb) => api.events.onWindowFocusChanged(cb)],
      [IpcChannel.EventImportProgress, (cb) => api.events.onImportProgress(cb)],
      [IpcChannel.EventImportToast, (cb) => api.events.onImportToast(cb)],
      [IpcChannel.EventMenuExportBibtex, (cb) => api.events.onMenuExportBibtex(cb)],
      [IpcChannel.EventMenuImportZotero, (cb) => api.events.onMenuImportZotero(cb)],
      [IpcChannel.EventMenuImportMendeley, (cb) => api.events.onMenuImportMendeley(cb)],
      [IpcChannel.EventMenuImportIdentifier, (cb) => api.events.onMenuImportIdentifier(cb)],
      [IpcChannel.EventLibraryScanning, (cb) => api.events.onLibraryScanning(cb)],
      [IpcChannel.EventLibrarySwitched, (cb) => api.events.onLibrarySwitched(cb)],
      [IpcChannel.EventAiSummaryUpdated, (cb) => api.events.onAiSummaryUpdated(cb)],
      [IpcChannel.EventAiSummaryError, (cb) => api.events.onAiSummaryError(cb)],
      [IpcChannel.EventAiChatToken, (cb) => api.events.onAiChatToken(cb)],
      [IpcChannel.EventAiChatReasoning, (cb) => api.events.onAiChatReasoning(cb)],
      [IpcChannel.EventAiChatDone, (cb) => api.events.onAiChatDone(cb)],
      [IpcChannel.EventAiChatError, (cb) => api.events.onAiChatError(cb)],
      [IpcChannel.EventAiChatTrace, (cb) => api.events.onAiChatTrace(cb)],
      [IpcChannel.EventAiChatInterrupted, (cb) => api.events.onAiChatInterrupted(cb)],
      [IpcChannel.EventAiChatRunStatus, (cb) => api.events.onAiChatRunStatus(cb)],
      [IpcChannel.EventAiChatTitleUpdated, (cb) => api.events.onAiChatTitleUpdated(cb)],
      [IpcChannel.EventAiReportCreated, (cb) => api.events.onAiReportCreated(cb)],
      [IpcChannel.EventWorkspaceItemsChanged, (cb) => api.events.onWorkspaceItemsChanged(cb)]
    ]

    for (const [channel, subscribe] of eventCases) {
      const callback = vi.fn()
      const payload = { channel }
      subscribe(callback)
      const listener = electronMocks.on.mock.calls.at(-1)?.[1] as
        | ((event: unknown, value: unknown) => void)
        | undefined
      expect(electronMocks.on).toHaveBeenLastCalledWith(channel, listener)
      listener?.({ sender: 'ignored' }, payload)
      expect(callback).toHaveBeenCalledWith(payload)
      api.events.off(channel, callback)
      expect(electronMocks.removeListener).toHaveBeenLastCalledWith(channel, listener)
    }
  })

  it('replaces duplicate callbacks and single-subscriber chat listeners', () => {
    const shared = vi.fn()
    api.events.onImportProgress(shared)
    const progressListener = electronMocks.on.mock.calls.at(-1)?.[1]
    api.events.onImportToast(shared)
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      IpcChannel.EventImportProgress,
      progressListener
    )

    const singleSubscriberCases: Array<[string, (cb: () => void) => void]> = [
      [IpcChannel.EventAiChatToken, (cb) => api.events.onAiChatToken(cb)],
      [IpcChannel.EventAiChatReasoning, (cb) => api.events.onAiChatReasoning(cb)],
      [IpcChannel.EventAiChatDone, (cb) => api.events.onAiChatDone(cb)],
      [IpcChannel.EventAiChatError, (cb) => api.events.onAiChatError(cb)],
      [IpcChannel.EventAiChatTrace, (cb) => api.events.onAiChatTrace(cb)],
      [IpcChannel.EventAiChatInterrupted, (cb) => api.events.onAiChatInterrupted(cb)],
      [IpcChannel.EventAiChatRunStatus, (cb) => api.events.onAiChatRunStatus(cb)]
    ]
    for (const [channel, subscribe] of singleSubscriberCases) {
      const first = vi.fn()
      const second = vi.fn()
      subscribe(first)
      const firstListener = electronMocks.on.mock.calls.at(-1)?.[1]
      subscribe(second)
      expect(electronMocks.removeListener).toHaveBeenCalledWith(channel, firstListener)
    }
  })
})
