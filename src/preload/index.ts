import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type {
  AgentInterrupt,
  AgentProfile,
  AgentProfileInput,
  AgentProfilePatch,
  AgentProfileTestResult,
  AgentResumeRequest,
  AgentRun,
  AgentTraceStep,
  AiProvider,
  AiProviderInput,
  AiProviderPatch,
  AiReport,
  AiSummary,
  AiUsageStats,
  BibImportResult,
  BootstrapData,
  Category,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatInterruptedEvent,
  ChatMessage,
  ChatReasoningEvent,
  ChatRunStatusEvent,
  ChatSendRequest,
  ChatThread,
  ChatTokenEvent,
  ChatTraceEvent,
  ChatTitleUpdatedEvent,
  CliRuntimeInfo,
  Document,
  DocumentCounts,
  DocumentPatch,
  EventChannel,
  GlobalSearchResult,
  IdentifierImportResult,
  ImportProgress,
  LibrarySwitchResult,
  ListFilter,
  PageRequest,
  ListModelsRequest,
  ListModelsResult,
  PdfAnnotation,
  PdfRangeChunk,
  PdfImportResult,
  Result,
  ReforaApi,
  SearchResult,
  SummaryErrorEvent,
  ThemeMode,
  WatchFolder,
  Workspace,
  WorkspaceAsset,
  WorkspaceAssetImportResult,
  WorkspaceAssetTextPreview,
  WorkspaceFileImportResult,
  WorkspaceCanvasViewport,
  WorkspaceConnection,
  WorkspaceConnectionAnchor,
  WorkspaceItem,
  WorkspaceItemKind,
  WorkspaceItemPlacement,
  WorkspaceNote,
  WorkspaceNotePatch,
  WorkspaceNoteType,
  WorkspaceItemsChangedEvent,
  WorkspaceAgentMemory
} from '../shared/ipc-types'
import type {
  MineruEngineStatus,
  MineruInstallProgress,
  OcrCompletedEvent,
  OcrDocumentState,
  OcrErrorEvent,
  OcrJob,
  OcrProfile,
  OcrProgressEvent
} from '../shared/mineru-types'
import type {
  WebSearchConfig,
  WebSearchConfigPatch,
  WebSearchTestResult
} from '../shared/webSearch'
import type {
  SyncAuthConfirmation,
  SyncCredentials,
  SyncEmailRequest,
  SyncServiceStatus,
  SyncSignUpResult
} from '../shared/sync-types'

type Envelope<T> = Result<T>

function unwrap<T>(r: Envelope<T>): T {
  if (!r.ok) {
    throw {
      name: 'IpcResponseError',
      code: r.error.code,
      message: r.error.message
    }
  }
  return r.data
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then((r) => unwrap<T>(r as Envelope<T>))
}

const subscriptions = new Map<unknown, { channel: string; ipcListener: (...args: unknown[]) => void }>()
let pendingAuthConfirmation: SyncAuthConfirmation | null = null
let authConfirmationSubscriber: ((payload: SyncAuthConfirmation) => void) | null = null

ipcRenderer.on(IpcChannel.EventSyncAuthConfirmation, (...args: unknown[]) => {
  const payload = args[1] as SyncAuthConfirmation
  if (authConfirmationSubscriber) {
    authConfirmationSubscriber(payload)
  } else {
    pendingAuthConfirmation = payload
  }
})

const SINGLE_SUBSCRIBER_CHANNELS = new Set([
  IpcChannel.EventWindowFocusChanged,
  'ai:chat:token',
  'ai:chat:reasoning',
  'ai:chat:done',
  'ai:chat:error',
  'ai:chat:trace',
  'ai:chat:interrupted',
  'ai:chat:runStatus',
  'ai:chat:titleUpdated'
])

function subscribe<T>(channel: string, cb: (payload: T) => void): void {
  const existing = subscriptions.get(cb)
  if (existing) {
    ipcRenderer.removeListener(existing.channel, existing.ipcListener)
  } else if (SINGLE_SUBSCRIBER_CHANNELS.has(channel)) {
    for (const [key, sub] of subscriptions) {
      if (sub.channel === channel) {
        ipcRenderer.removeListener(channel, sub.ipcListener)
        subscriptions.delete(key)
      }
    }
  }
  const ipcListener = (...args: unknown[]): void => cb(args[1] as T)
  subscriptions.set(cb, { channel, ipcListener })
  ipcRenderer.on(channel, ipcListener)
}

function unsubscribe(channel: string, cb: unknown): void {
  if (channel === IpcChannel.EventSyncAuthConfirmation && authConfirmationSubscriber === cb) {
    authConfirmationSubscriber = null
    return
  }
  const sub = subscriptions.get(cb)
  if (sub) {
    ipcRenderer.removeListener(channel, sub.ipcListener)
    subscriptions.delete(cb)
  }
}

const api: ReforaApi = {
  getBootstrap: () => invoke<BootstrapData>(IpcChannel.Bootstrap),

  documents: {
    list: (filter: ListFilter) => invoke<Document[]>(IpcChannel.DocumentsList, filter),
    counts: () => invoke<DocumentCounts>(IpcChannel.DocumentsCount),
    search: (q: string, page?: PageRequest) => page
      ? invoke<SearchResult>(IpcChannel.DocumentsSearch, q, page)
      : invoke<SearchResult>(IpcChannel.DocumentsSearch, q),
    get: (id: string) => invoke<Document | null>(IpcChannel.DocumentsGet, id),
    update: (id: string, patch: DocumentPatch) =>
      invoke<Document>(IpcChannel.DocumentsUpdate, id, patch),
    setStarred: (id: string, value: boolean) =>
      invoke<void>(IpcChannel.DocumentsSetStarred, id, value),
    delete: (id: string) => invoke<void>(IpcChannel.DocumentsDelete, id),
    bulkDelete: (ids: string[]) => invoke<void>(IpcChannel.DocumentsBulkDelete, ids),
    bulkCategorize: (ids: string[], catId: string) =>
      invoke<void>(IpcChannel.DocumentsBulkCategorize, ids, catId),
    bulkRefreshMetadata: (ids: string[]) =>
      invoke<void>(IpcChannel.DocumentsBulkRefreshMetadata, ids),
    openPdf: (id: string, external) => external === false
      ? invoke<Document>(IpcChannel.DocumentsOpenPdf, id, false)
      : invoke<Document>(IpcChannel.DocumentsOpenPdf, id),
    readPdfRange: (id: string, begin: number, end: number) =>
      invoke<PdfRangeChunk>(IpcChannel.DocumentsReadPdfRange, id, begin, end),
    pdfAnnotations: (id: string) =>
      invoke<PdfAnnotation[]>(IpcChannel.DocumentsPdfAnnotationsGet, id),
    setPdfAnnotations: (id: string, annotations: PdfAnnotation[]) =>
      invoke<PdfAnnotation[]>(IpcChannel.DocumentsPdfAnnotationsSet, id, annotations),
    openInFinder: (id: string) => invoke<void>(IpcChannel.DocumentsOpenInFinder, id),
    refreshMetadata: (id: string) => invoke<Document>(IpcChannel.DocumentsRefreshMetadata, id),
    relocateFile: (id: string, newPath: string) =>
      invoke<Document>(IpcChannel.DocumentsRelocateFile, id, newPath),
    restoreFile: (id: string) => invoke<Document>(IpcChannel.DocumentsRestoreFile, id),
    previewUrl: (id: string, version: string | number) =>
      `refora-document://preview/${encodeURIComponent(id)}?v=${encodeURIComponent(String(version))}`
  },

  search: {
    global: (q: string) => invoke<GlobalSearchResult>(IpcChannel.GlobalSearch, q)
  },

  import: {
    addFiles: (paths: string[]) => invoke<PdfImportResult>(IpcChannel.ImportAddFiles, paths),
    addFolder: (dir: string) => invoke<PdfImportResult>(IpcChannel.ImportAddFolder, dir),
    fromJson: (file: string) => invoke<number>(IpcChannel.ImportFromJson, file),
    fromZotero: () => invoke<BibImportResult>(IpcChannel.ImportFromZotero),
    fromMendeley: () => invoke<BibImportResult>(IpcChannel.ImportFromMendeley),
    fromIdentifier: (identifier: string) => invoke<IdentifierImportResult>(IpcChannel.ImportFromIdentifier, identifier)
  },

  categories: {
    list: () => invoke<Category[]>(IpcChannel.CategoriesList),
    create: (name: string) =>
      invoke<Category>(IpcChannel.CategoriesCreate, name),
    rename: (id: string, name: string) => invoke<void>(IpcChannel.CategoriesRename, id, name),
    delete: (id: string) => invoke<void>(IpcChannel.CategoriesDelete, id),
    assign: (docId: string, catId: string) =>
      invoke<void>(IpcChannel.CategoriesAssign, docId, catId),
    unassign: (docId: string, catId: string) =>
      invoke<void>(IpcChannel.CategoriesUnassign, docId, catId)
  },

  watch: {
    list: () => invoke<WatchFolder[]>(IpcChannel.WatchList),
    add: (path: string) => invoke<WatchFolder>(IpcChannel.WatchAdd, path),
    remove: (id: string) => invoke<void>(IpcChannel.WatchRemove, id),
    toggle: (id: string, enabled: boolean) => invoke<void>(IpcChannel.WatchToggle, id, enabled)
  },

  settings: {
    get: <T>(key: string, defaultValue: T) =>
      invoke<T>(IpcChannel.SettingsGet, key, defaultValue),
    set: (key: string, value: unknown) => invoke<void>(IpcChannel.SettingsSet, key, value)
  },

  sync: {
    status: () => invoke<SyncServiceStatus>(IpcChannel.SyncStatus),
    signIn: (credentials: SyncCredentials) =>
      invoke<SyncServiceStatus>(IpcChannel.SyncSignIn, credentials),
    signUp: (credentials: SyncCredentials) =>
      invoke<SyncSignUpResult>(IpcChannel.SyncSignUp, credentials),
    resendConfirmation: (request: SyncEmailRequest) =>
      invoke<void>(IpcChannel.SyncResendConfirmation, request),
    signOut: () => invoke<SyncServiceStatus>(IpcChannel.SyncSignOut),
    setEnabled: (enabled: boolean) =>
      invoke<SyncServiceStatus>(IpcChannel.SyncSetEnabled, enabled)
  },

  appearance: {
    setThemeSource: (theme: ThemeMode) =>
      invoke<void>(IpcChannel.AppearanceSetThemeSource, theme)
  },

  webSearch: {
    getConfig: () => invoke<WebSearchConfig>(IpcChannel.WebSearchConfigGet),
    updateConfig: (patch: WebSearchConfigPatch) =>
      invoke<WebSearchConfig>(IpcChannel.WebSearchConfigUpdate, patch),
    test: () => invoke<WebSearchTestResult>(IpcChannel.WebSearchTest)
  },

  mineru: {
    status: () => invoke<MineruEngineStatus>(IpcChannel.MineruStatus),
    chooseInstallRoot: () =>
      invoke<MineruEngineStatus>(IpcChannel.MineruChooseInstallRoot),
    install: () => invoke<MineruEngineStatus>(IpcChannel.MineruInstall),
    cancelInstall: () => invoke<MineruEngineStatus>(IpcChannel.MineruCancelInstall),
    uninstall: () => invoke<MineruEngineStatus>(IpcChannel.MineruUninstall)
  },

  ocr: {
    getState: (documentId: string) =>
      invoke<OcrDocumentState>(IpcChannel.OcrGetState, documentId),
    start: (documentId: string, profile: OcrProfile) =>
      invoke<OcrJob>(IpcChannel.OcrStart, documentId, profile),
    cancel: (jobId: string) => invoke<OcrJob>(IpcChannel.OcrCancel, jobId),
    readMarkdown: (documentId: string, resultKey: string) =>
      invoke<string>(IpcChannel.OcrReadMarkdown, documentId, resultKey),
    assetUrl: (documentId: string, resultKey: string, assetPath: string) =>
      `refora-document://ocr/${encodeURIComponent(documentId)}/${encodeURIComponent(resultKey)}/${assetPath.split('/').map(encodeURIComponent).join('/')}`
  },

  dialog: {
    openDirectory: () => invoke<string | null>(IpcChannel.DialogOpenDirectory)
  },

  library: {
    switch: (path: string) => invoke<LibrarySwitchResult>(IpcChannel.LibrarySwitch, path)
  },

  getPathForFile: async (file: unknown) => {
    const path = webUtils.getPathForFile(file as File)
    if (!path) return ''
    return invoke<string>(IpcChannel.FileAuthorizeDropped, path)
  },

  export: {
    toJson: () => invoke<string>(IpcChannel.ExportToJson),
    toBibtex: (ids: string[]) => invoke<string>(IpcChannel.ExportToBibtex, ids),
    toBibtexString: (ids: string[]) => invoke<string>(IpcChannel.ExportBibtexString, ids)
  },

  clipboard: {
    writeText: (text: string) => invoke<void>(IpcChannel.ClipboardWriteText, text),
    copyMarkdown: (title: string, content: string) =>
      invoke<void>(IpcChannel.ClipboardCopyMarkdown, title, content),
    copyWorkspaceAsset: (id: string) =>
      invoke<void>(IpcChannel.ClipboardCopyWorkspaceAsset, id)
  },

  workspaces: {
    list: () => invoke<Workspace[]>(IpcChannel.WorkspacesList),
    create: (name: string) => invoke<Workspace>(IpcChannel.WorkspacesCreate, name),
    rename: (id: string, name: string) => invoke<void>(IpcChannel.WorkspacesRename, id, name),
    delete: (id: string) => invoke<void>(IpcChannel.WorkspacesDelete, id),
    openSandbox: (id: string) => invoke<void>(IpcChannel.WorkspacesOpenSandbox, id)
  },

  workspaceItems: {
    list: (workspaceId: string) =>
      invoke<WorkspaceItem[]>(IpcChannel.WorkspaceItemsList, workspaceId),
    add: (workspaceId: string, kind: WorkspaceItemKind, ids: string[], placement?: WorkspaceItemPlacement) =>
      invoke<WorkspaceItem[]>(IpcChannel.WorkspaceItemsAdd, workspaceId, kind, ids, placement),
    remove: (itemId: string) => invoke<void>(IpcChannel.WorkspaceItemsRemove, itemId),
    reorder: (workspaceId: string, orderedIds: string[]) =>
      invoke<WorkspaceItem[]>(IpcChannel.WorkspaceItemsReorder, workspaceId, orderedIds),
    resize: (itemId: string, width: number, height: number) =>
      invoke<WorkspaceItem>(IpcChannel.WorkspaceItemsResize, itemId, width, height),
    move: (itemId: string, x: number, y: number, zIndex: number) =>
      invoke<WorkspaceItem>(IpcChannel.WorkspaceItemsMove, itemId, x, y, zIndex)
  },

  workspaceAssets: {
    list: (workspaceId: string) =>
      invoke<WorkspaceAsset[]>(IpcChannel.WorkspaceAssetsList, workspaceId),
    addFiles: (workspaceId: string, paths: string[], placement?: WorkspaceItemPlacement) =>
      invoke<WorkspaceAssetImportResult>(IpcChannel.WorkspaceAssetsAddFiles, workspaceId, paths, placement),
    textPreview: (id: string) =>
      invoke<WorkspaceAssetTextPreview>(IpcChannel.WorkspaceAssetsTextPreview, id),
    open: (id: string) => invoke<void>(IpcChannel.WorkspaceAssetsOpen, id),
    reveal: (id: string) => invoke<void>(IpcChannel.WorkspaceAssetsReveal, id),
    delete: (id: string) => invoke<void>(IpcChannel.WorkspaceAssetsDelete, id),
    previewUrl: (id: string) => `refora-asset://asset/${encodeURIComponent(id)}`
  },

  workspaceFiles: {
    add: (workspaceId: string, paths: string[], placement?: WorkspaceItemPlacement) =>
      invoke<WorkspaceFileImportResult>(IpcChannel.WorkspaceFilesAdd, workspaceId, paths, placement)
  },

  workspaceNotes: {
    list: (workspaceId: string) =>
      invoke<WorkspaceNote[]>(IpcChannel.WorkspaceNotesList, workspaceId),
    create: (workspaceId: string, title: string, contentMd: string, noteType: WorkspaceNoteType, placement?: WorkspaceItemPlacement) =>
      invoke<WorkspaceNote>(IpcChannel.WorkspaceNotesCreate, workspaceId, title, contentMd, noteType, placement),
    update: (id: string, patch: WorkspaceNotePatch) =>
      invoke<WorkspaceNote>(IpcChannel.WorkspaceNotesUpdate, id, patch),
    delete: (id: string) => invoke<void>(IpcChannel.WorkspaceNotesDelete, id)
  },

  workspaceCanvas: {
    get: (workspaceId: string) =>
      invoke<WorkspaceCanvasViewport>(IpcChannel.WorkspaceCanvasGet, workspaceId),
    update: (workspaceId: string, viewport: WorkspaceCanvasViewport) =>
      invoke<WorkspaceCanvasViewport>(IpcChannel.WorkspaceCanvasUpdate, workspaceId, viewport)
  },

  workspaceConnections: {
    list: (workspaceId: string) =>
      invoke<WorkspaceConnection[]>(IpcChannel.WorkspaceConnectionsList, workspaceId),
    create: (
      workspaceId: string,
      sourceItemId: string,
      targetItemId: string,
      sourceAnchor: WorkspaceConnectionAnchor,
      targetAnchor: WorkspaceConnectionAnchor
    ) => invoke<WorkspaceConnection>(
      IpcChannel.WorkspaceConnectionsCreate,
      workspaceId,
      sourceItemId,
      targetItemId,
      sourceAnchor,
      targetAnchor
    ),
    delete: (id: string) => invoke<void>(IpcChannel.WorkspaceConnectionsDelete, id)
  },

  aiProviders: {
    list: () => invoke<AiProvider[]>(IpcChannel.AiProvidersList),
    create: (input: AiProviderInput) =>
      invoke<AiProvider>(IpcChannel.AiProvidersCreate, input),
    update: (id: string, patch: AiProviderPatch) =>
      invoke<AiProvider>(IpcChannel.AiProvidersUpdate, id, patch),
    delete: (id: string) => invoke<void>(IpcChannel.AiProvidersDelete, id),
    test: (id: string) =>
      invoke<{ ok: boolean; models?: string[] }>(IpcChannel.AiProvidersTest, id),
    listModels: (req: ListModelsRequest) =>
      invoke<ListModelsResult>(IpcChannel.AiProvidersListModels, req)
  },

  agentProfiles: {
    list: () => invoke<AgentProfile[]>(IpcChannel.AgentProfilesList),
    create: (input: AgentProfileInput) =>
      invoke<AgentProfile>(IpcChannel.AgentProfilesCreate, input),
    update: (id: string, patch: AgentProfilePatch) =>
      invoke<AgentProfile>(IpcChannel.AgentProfilesUpdate, id, patch),
    delete: (id: string) => invoke<void>(IpcChannel.AgentProfilesDelete, id),
    test: (id: string) =>
      invoke<AgentProfileTestResult>(IpcChannel.AgentProfilesTest, id),
    listModels: (id: string) =>
      invoke<ListModelsResult>(IpcChannel.AgentProfilesListModels, id),
    scanRuntimes: () =>
      invoke<CliRuntimeInfo[]>(IpcChannel.AgentProfilesScanRuntimes)
  },

  ai: {
    docTextGet: (docId: string) => invoke<string>(IpcChannel.AiDocTextGet, docId),
    summarize: (docId: string) => invoke<void>(IpcChannel.AiSummarize, docId),
    summaryGet: (docId: string) => invoke<AiSummary | null>(IpcChannel.AiSummaryGet, docId),
    chatSend: (req: ChatSendRequest) =>
      invoke<{ threadId: string; runId: string }>(IpcChannel.AiChatSend, req),
    chatHistory: (threadId: string) => invoke<ChatMessage[]>(IpcChannel.AiChatHistory, threadId),
    chatThreads: (workspaceId: string | null) =>
      invoke<ChatThread[]>(IpcChannel.AiChatThreads, workspaceId),
    usageStats: () => invoke<AiUsageStats>(IpcChannel.AiUsageStats),
    chatTraces: (threadId: string) =>
      invoke<AgentTraceStep[]>(IpcChannel.AiChatTraces, threadId),
    chatRun: (runId: string) => invoke<AgentRun>(IpcChannel.AiChatRun, runId),
    chatCancel: (runId: string) => invoke<void>(IpcChannel.AiChatCancel, runId),
    chatResume: (req: AgentResumeRequest) => invoke<void>(IpcChannel.AiChatResume, req),
    chatPendingInterrupt: (runId: string) =>
      invoke<AgentInterrupt | null>(IpcChannel.AiChatPendingInterrupt, runId),
    chatDeleteThread: (threadId: string) => invoke<void>(IpcChannel.AiChatDeleteThread, threadId),
    renameThread: (threadId: string, title: string) =>
      invoke<void>(IpcChannel.AiChatRenameThread, threadId, title),
    workspaceMemories: (workspaceId: string | null) =>
      invoke<WorkspaceAgentMemory[]>(IpcChannel.AiWorkspaceMemoriesList, workspaceId),
    updateWorkspaceMemory: (workspaceId: string | null, path: string, content: string) =>
      invoke<WorkspaceAgentMemory>(IpcChannel.AiWorkspaceMemoryUpdate, workspaceId, path, content),
    deleteWorkspaceMemory: (workspaceId: string | null, path: string) =>
      invoke<void>(IpcChannel.AiWorkspaceMemoryDelete, workspaceId, path)
  },

  reports: {
    list: (workspaceId: string) => invoke<AiReport[]>(IpcChannel.AiReportsList, workspaceId),
    update: (id: string, patch: { title?: string; contentMd?: string }) =>
      invoke<AiReport>(IpcChannel.AiReportsUpdate, id, patch),
    delete: (id: string) => invoke<void>(IpcChannel.AiReportsDelete, id)
  },

  events: {
    onDocumentUpdated: (cb: (doc: Document) => void) =>
      subscribe(IpcChannel.EventDocumentUpdated, cb),
    onWindowFocusChanged: (cb: (focused: boolean) => void) =>
      subscribe(IpcChannel.EventWindowFocusChanged, cb),
    onImportProgress: (cb: (payload: ImportProgress) => void) =>
      subscribe(IpcChannel.EventImportProgress, cb),
    onImportToast: (cb: (message: string) => void) =>
      subscribe(IpcChannel.EventImportToast, cb),
    onMenuExportBibtex: (cb: () => void) =>
      subscribe(IpcChannel.EventMenuExportBibtex, cb),
    onMenuImportZotero: (cb: () => void) =>
      subscribe(IpcChannel.EventMenuImportZotero, cb),
    onMenuImportMendeley: (cb: () => void) =>
      subscribe(IpcChannel.EventMenuImportMendeley, cb),
    onMenuImportIdentifier: (cb: () => void) =>
      subscribe(IpcChannel.EventMenuImportIdentifier, cb),
    onLibraryScanning: (cb: (payload: ImportProgress) => void) =>
      subscribe(IpcChannel.EventLibraryScanning, cb),
    onLibrarySwitched: (cb: (payload: LibrarySwitchResult) => void) =>
      subscribe(IpcChannel.EventLibrarySwitched, cb),
    onSyncAuthConfirmation: (cb: (payload: SyncAuthConfirmation) => void) => {
      authConfirmationSubscriber = cb
      if (pendingAuthConfirmation) {
        const payload = pendingAuthConfirmation
        pendingAuthConfirmation = null
        cb(payload)
      }
    },
    onAiSummaryUpdated: (cb: (docId: string) => void) =>
      subscribe(IpcChannel.EventAiSummaryUpdated, cb),
    onAiSummaryError: (cb: (payload: SummaryErrorEvent) => void) =>
      subscribe(IpcChannel.EventAiSummaryError, cb),
    onAiChatToken: (cb: (payload: ChatTokenEvent) => void) =>
      subscribe(IpcChannel.EventAiChatToken, cb),
    onAiChatReasoning: (cb: (payload: ChatReasoningEvent) => void) =>
      subscribe(IpcChannel.EventAiChatReasoning, cb),
    onAiChatDone: (cb: (payload: ChatDoneEvent) => void) =>
      subscribe(IpcChannel.EventAiChatDone, cb),
    onAiChatError: (cb: (payload: ChatErrorEvent) => void) =>
      subscribe(IpcChannel.EventAiChatError, cb),
    onAiChatTrace: (cb: (payload: ChatTraceEvent) => void) =>
      subscribe(IpcChannel.EventAiChatTrace, cb),
    onAiChatInterrupted: (cb: (payload: ChatInterruptedEvent) => void) =>
      subscribe(IpcChannel.EventAiChatInterrupted, cb),
    onAiChatRunStatus: (cb: (payload: ChatRunStatusEvent) => void) =>
      subscribe(IpcChannel.EventAiChatRunStatus, cb),
    onAiChatTitleUpdated: (cb: (payload: ChatTitleUpdatedEvent) => void) =>
      subscribe(IpcChannel.EventAiChatTitleUpdated, cb),
    onAiReportCreated: (cb: (report: AiReport) => void) =>
      subscribe(IpcChannel.EventAiReportCreated, cb),
    onWorkspaceItemsChanged: (cb: (payload: WorkspaceItemsChangedEvent) => void) =>
      subscribe(IpcChannel.EventWorkspaceItemsChanged, cb),
    onMineruInstallProgress: (cb: (payload: MineruInstallProgress) => void) =>
      subscribe(IpcChannel.EventMineruInstallProgress, cb),
    onOcrProgress: (cb: (payload: OcrProgressEvent) => void) =>
      subscribe(IpcChannel.EventOcrProgress, cb),
    onOcrCompleted: (cb: (payload: OcrCompletedEvent) => void) =>
      subscribe(IpcChannel.EventOcrCompleted, cb),
    onOcrError: (cb: (payload: OcrErrorEvent) => void) =>
      subscribe(IpcChannel.EventOcrError, cb),
    off: (channel: EventChannel, cb: unknown) => unsubscribe(channel, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
