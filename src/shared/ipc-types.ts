import { IpcChannel } from './ipc-channels'
import type {
  MineruEngineStatus,
  MineruInstallProgress,
  OcrCompletedEvent,
  OcrDocumentState,
  OcrErrorEvent,
  OcrJob,
  OcrProfile,
  OcrProgressEvent
} from './mineru-types'
import type {
  WebSearchConfig,
  WebSearchConfigPatch,
  WebSearchTestResult
} from './webSearch'
import type {
  SyncAuthConfirmation,
  SyncCredentials,
  SyncEmailRequest,
  SyncServiceStatus,
  SyncSignUpResult
} from './sync-types'

export interface IpcError {
  code: string
  message: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export function errorMessage(e: unknown, fallback = 'Unknown error'): string {
  if (e instanceof Error) return e.message || fallback
  if (e && typeof e === 'object' && 'message' in e) {
    const msg = (e as { message: unknown }).message
    if (typeof msg === 'string' && msg.length > 0) return msg
  }
  if (typeof e === 'string' && e.length > 0) return e
  return fallback
}

export type ListMode =
  | 'all'
  | 'recentlyRead'
  | 'recentlyAdded'
  | 'starred'
  | 'category'

export type SortField = 'title' | 'authors' | 'year' | 'venue' | 'addedAt' | 'filePath'

export interface ListFilter {
  mode: ListMode
  categoryId?: string
  sort?: { field: SortField; dir: 'asc' | 'desc' }
  limit?: number
  offset?: number
}

export interface PageRequest {
  limit: number
  offset: number
}

export interface DocumentCounts {
  all: number
  recentlyRead: number
  recentlyAdded: number
  starred: number
}

export type EditableField =
  | 'title'
  | 'authors'
  | 'year'
  | 'venue'
  | 'volume'
  | 'issue'
  | 'pages'
  | 'abstract'
  | 'keywords'
  | 'url'
  | 'doi'
  | 'arxivId'
  | 'note'
  | 'affiliations'

export type MetadataStatus = 'pending' | 'done' | 'failed'
export type MetadataSource = 'pdf' | 'crossref' | 'arxiv' | 'dblp' | 'manual'

export interface RemoteValue {
  value: string
  source: MetadataSource
}

export type RemoteValues = Partial<Record<EditableField, RemoteValue>>

export interface Category {
  id: string
  name: string
  sortOrder: number
  createdAt: number
  count?: number
}

export interface Document {
  id: string
  filePath: string
  originalFolderPath: string
  fileName: string
  fileSize: number | null
  fileHash: string | null
  title: string | null
  authors: string | null
  year: string | null
  venue: string | null
  volume: string | null
  issue: string | null
  pages: string | null
  abstract: string | null
  keywords: string | null
  url: string | null
  doi: string | null
  arxivId: string | null
  note: string | null
  affiliations: string | null
  starred: number
  addedAt: number
  lastReadAt: number | null
  updatedAt: number
  metadataSource: MetadataSource | null
  metadataStatus: MetadataStatus
  metadataAttempts: number
  editedFields: EditableField[]
  remoteValues: RemoteValues | null
  fileMissing: number
  categories?: Category[]
}

export interface PdfRangeChunk {
  begin: number
  fileSize: number
  data: Uint8Array
}

export type PdfAnnotationKind =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'note'
  | 'text'
  | 'ink'

export interface PdfAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfAnnotationPoint {
  x: number
  y: number
}

export interface PdfAnnotation {
  id: string
  kind: PdfAnnotationKind
  page: number
  color: string
  text: string
  comment: string
  createdAt: number
  rects?: PdfAnnotationRect[]
  point?: PdfAnnotationPoint
  points?: PdfAnnotationPoint[]
  strokeWidth?: number
  fontSize?: number
}

export interface WatchFolder {
  id: string
  path: string
  enabled: number
  addedAt: number
}

export type DocumentPatch = Partial<Pick<Document, EditableField>>

export type SearchResult = Document[]

export interface WorkspaceFileSearchResult {
  id: string
  workspaceId: string
  workspaceName: string
  fileName: string
  mimeType: string
  previewKind: WorkspaceAssetPreviewKind
  fileMissing: number
  updatedAt: number
}

export type WorkspaceContentKind = 'report' | 'note'

export interface WorkspaceContentSearchResult {
  id: string
  workspaceId: string
  workspaceName: string
  kind: WorkspaceContentKind
  title: string
  snippet: string
  matchedAt: number
}

export interface ChatSearchResult {
  threadId: string
  workspaceId: string | null
  workspaceName: string | null
  title: string | null
  snippet: string
  role: 'user' | 'assistant' | null
  matchedAt: number
}

export interface GlobalSearchResult {
  documents: Document[]
  workspaceFiles: WorkspaceFileSearchResult[]
  workspaceContents: WorkspaceContentSearchResult[]
  chats: ChatSearchResult[]
}

export type ColumnId = 'title' | 'authors' | 'year' | 'venue' | 'addedAt' | 'filePath'

export interface ListColumn {
  id: ColumnId
  visible: boolean
  width: number
  order: number
}

export interface ListColumnState {
  columns: ListColumn[]
  sort: { field: SortField; dir: 'asc' | 'desc' }
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

export type ThemeMode = 'system' | 'dark' | 'light'

export interface BootstrapData {
  language: 'zh' | 'en'
  theme: ThemeMode
  windowBounds: WindowBounds | null
  listColumnState: ListColumnState | null
  sidebarCollapsed: boolean
  firstRun: boolean
  libraryFolderPath: string | null
}

export interface ImportProgress {
  current: number
  total: number
  message?: string
}

export interface PdfImportResult {
  added: string[]
  skipped: string[]
  errors: Array<{ path: string; message: string }>
}

export interface LibrarySwitchResult {
  libraryFolderPath: string
  dbExisted: boolean
  scanned: number
  imported: number
  skipped: number
  errors: Array<{ path: string; message: string }>
}

export interface BibImportResult {
  added: number
  skipped: number
  errors: Array<{ key: string; message: string }>
}

export type IdentifierType = 'doi' | 'arxiv' | 'isbn' | 'url'

export interface IdentifierImportResult {
  added: string[]
  message?: string
}

export const WORKSPACE_CARD_DEFAULT_WIDTH = 300
export const WORKSPACE_CARD_DEFAULT_HEIGHT = 200
export const WORKSPACE_CANVAS_MIN_ZOOM = 0.25
export const WORKSPACE_CANVAS_MAX_ZOOM = 2.5
export const WORKSPACE_CANVAS_DEFAULT_ZOOM = 1

export type WorkspaceItemKind = 'document' | 'report' | 'note' | 'asset'

export type WorkspaceAssetPreviewKind = 'image' | 'text' | 'audio' | 'video' | 'none'

export const WORKSPACE_ASSET_DIRECTORY = 'refora-assets'
export const AGENT_SANDBOX_DIRECTORY = '.refora-agent'

export interface AgentExecutionChangedFile {
  path: string
  mimeType: string
  size: number
}

export interface AgentExecutionResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
  changedFiles: AgentExecutionChangedFile[]
}

export interface AgentPublishedArtifact {
  path: string
  assetId: string
  fileName: string
}

export interface WorkspaceAsset {
  id: string
  workspaceId: string
  fileName: string
  filePath: string
  sourcePath: string
  mimeType: string
  previewKind: WorkspaceAssetPreviewKind
  fileSize: number
  fileHash: string
  fileMissing: number
  createdAt: number
  updatedAt: number
}

export interface WorkspaceAssetImportResult {
  imported: WorkspaceAsset[]
  errors: Array<{ path: string; message: string }>
}

export interface WorkspaceFileImportResult {
  documentIds: string[]
  notes: WorkspaceNote[]
  assets: WorkspaceAsset[]
  errors: Array<{ path: string; message: string }>
}

export interface WorkspaceAssetTextPreview {
  content: string
  truncated: boolean
}

export interface Workspace {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface WorkspaceItem {
  id: string
  workspaceId: string
  kind: WorkspaceItemKind
  docId: string | null
  reportId: string | null
  noteId: string | null
  assetId: string | null
  sortOrder: number
  width: number
  height: number
  x: number
  y: number
  zIndex: number
  addedAt: number
}

export interface WorkspaceItemPlacement {
  x: number
  y: number
}

export interface WorkspaceCanvasViewport {
  panX: number
  panY: number
  zoom: number
}

export type WorkspaceConnectionAnchor = 'top' | 'right' | 'bottom' | 'left'

export interface WorkspaceConnection {
  id: string
  workspaceId: string
  sourceItemId: string
  targetItemId: string
  sourceAnchor: WorkspaceConnectionAnchor
  targetAnchor: WorkspaceConnectionAnchor
  createdAt: number
}

export type ModelVariantFormat = 'dash' | 'colon' | 'none'

export type AiApiProtocol = 'openai-responses' | 'openai-compatible'

export type AgentProfileKind = 'api' | 'cli'

export type AgentWebSearchPolicy = 'auto' | 'native' | 'refora' | 'disabled'

export type AiReasoningControl = 'openai' | 'thinking' | 'enable-thinking' | 'none'

export type AiReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'

export interface AiProvider {
  id: string
  presetId: string
  name: string
  baseUrl: string
  apiProtocol: AiApiProtocol
  reasoningControl: AiReasoningControl
  reasoningEffort: AiReasoningEffort
  model: string
  models: string[] | null
  baseModel: string
  variant: string
  variantFormat: ModelVariantFormat
  hasKey: boolean
  temperature: number | null
  maxTokens: number | null
  createdAt: number
}

export interface AiProviderInput {
  presetId?: string
  name: string
  baseUrl: string
  apiProtocol?: AiApiProtocol
  reasoningControl?: AiReasoningControl
  reasoningEffort?: AiReasoningEffort
  model: string
  models?: string[] | null
  baseModel?: string
  variant?: string
  variantFormat?: ModelVariantFormat
  apiKey?: string
  temperature?: number | null
  maxTokens?: number | null
}

export interface AiProviderPatch {
  presetId?: string
  name?: string
  baseUrl?: string
  apiProtocol?: AiApiProtocol
  reasoningControl?: AiReasoningControl
  reasoningEffort?: AiReasoningEffort
  model?: string
  models?: string[] | null
  baseModel?: string
  variant?: string
  variantFormat?: ModelVariantFormat
  apiKey?: string
  temperature?: number | null
  maxTokens?: number | null
}

export interface AgentProfile {
  id: string
  name: string
  kind: AgentProfileKind
  apiProviderId: string | null
  cliRuntimeId: string | null
  executablePath: string | null
  model: string
  reasoningEffort: AiReasoningEffort
  nativeWebSearch: boolean
  webSearchPolicy: AgentWebSearchPolicy
  createdAt: number
  updatedAt: number
}

export interface AgentProfileInput {
  name: string
  kind: 'cli'
  cliRuntimeId: string
  executablePath?: string | null
  model?: string
  reasoningEffort?: AiReasoningEffort
  nativeWebSearch?: boolean
  webSearchPolicy?: AgentWebSearchPolicy
}

export interface AgentProfilePatch {
  name?: string
  executablePath?: string | null
  model?: string
  reasoningEffort?: AiReasoningEffort
  nativeWebSearch?: boolean
  webSearchPolicy?: AgentWebSearchPolicy
}

export interface AgentProfileTestResult {
  ok: boolean
  runtimeId?: string | null
  executablePath?: string | null
  version?: string | null
  authenticated?: boolean | null
  error?: string | null
}

export type CliReasoningMode = 'select' | 'managed'

export interface CliModelInfo {
  id: string
  label: string
  reasoningEfforts: AiReasoningEffort[]
  defaultReasoningEffort: AiReasoningEffort | null
}

export interface CliRuntimeInfo extends AgentProfileTestResult {
  runtimeId: string
  label: string
  defaultExecutable: string
  available: boolean
  reasoningMode: CliReasoningMode
  capabilities: {
    nativeWebSearch: boolean
    mcp: boolean
    sessionResume: boolean
  }
  models: CliModelInfo[]
}

export interface ProviderModelInfo {
  id: string
  providerName?: string
  supportsVariants: boolean
  supportsReasoning: boolean
  reasoningEfforts: AiReasoningEffort[]
  defaultReasoningEffort?: AiReasoningEffort | null
  supportsVision: boolean
  supportsTools: boolean
  supportedParameters: string[]
}

export interface ListModelsRequest {
  providerId?: string
  presetId?: string
  baseUrl?: string
  apiKey?: string
}

export interface ListModelsResult {
  ok: boolean
  models: ProviderModelInfo[]
  error?: string
}

export interface AiSummaryContent {
  core: string
  keyPoints: string[]
  methods?: string
  contribution?: string
}

export interface AiSummary {
  docId: string
  model: string | null
  content: AiSummaryContent | null
  createdAt: number
  updatedAt: number
}

export interface AiReport {
  id: string
  workspaceId: string
  title: string
  contentMd: string
  sourceDocIds: string[]
  model: string | null
  createdAt: number
}

export interface AiUsageModel {
  model: string
  tokens: number
  calls: number
}

export interface AiUsageActivity {
  date: string
  tokens: number
  turns: number
}

export interface AiUsageStats {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  conversationCount: number
  turnCount: number
  modelCallCount: number
  activeDays: number
  models: AiUsageModel[]
  activity: AiUsageActivity[]
}

export interface WorkspaceNote {
  id: string
  workspaceId: string
  noteType: WorkspaceNoteType
  color: WorkspaceStickyColor
  title: string
  contentMd: string
  createdAt: number
  updatedAt: number
}

export type WorkspaceNoteType = 'markdown' | 'plain'
export type WorkspaceStickyColor =
  | 'sand'
  | 'lemon'
  | 'coral'
  | 'rose'
  | 'mint'
  | 'sky'
  | 'lavender'
  | 'slate'

export interface WorkspaceNotePatch {
  title?: string
  contentMd?: string
  color?: WorkspaceStickyColor
}

export interface ChatThread {
  id: string
  workspaceId: string | null
  providerId: string
  agentProfileId: string | null
  createdAt: number
  title: string | null
  headCheckpointId: string | null
  agentStateVersion: number
}

export interface ChatAttachment {
  type: 'document'
  docId: string
}

export interface ChatMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
}

export interface AgentTurnIntent {
  workspaceId: string | null
  activeDocumentId?: string
  threadId?: string
  runId?: string
  text: string
  providerId: string
  agentProfileId?: string
  model?: string
  replaceLastExchange?: boolean
  replaceRunId?: string
  features?: {
    deepThinking?: boolean
    reasoningEffort?: AiReasoningEffort
  }
  attachments?: ChatAttachment[]
}

export type ChatSendRequest = AgentTurnIntent

export type AgentTraceStepKind =
  | 'llm'
  | 'tool'
  | 'reasoning'
  | 'message'
  | 'run'
  | 'todo'
  | 'subagent'
  | 'approval'
  | 'checkpoint'
export type AgentTraceStepStatus = 'running' | 'done' | 'error' | 'interrupted' | 'cancelled'

export interface AgentTraceStep {
  id: string
  threadId: string
  runId: string
  kind: AgentTraceStepKind
  name: string | null
  input: string | null
  output: string | null
  status: AgentTraceStepStatus
  startedAt: number
  endedAt: number | null
  seq: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  parentStepId: string | null
  agentName: string | null
  namespace: string | null
  depth: number
  checkpointId: string | null
}

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AgentRun {
  id: string
  threadId: string
  providerId: string
  agentProfileId: string | null
  runtimeSessionId: string | null
  modelId: string
  activeDocumentId: string | null
  status: AgentRunStatus
  checkpointBefore: string | null
  checkpointAfter: string | null
  replacesRunId: string | null
  userMessageId: string | null
  assistantMessageId: string | null
  startedAt: number
  endedAt: number | null
  error: string | null
}

export type AgentInterruptDecision = 'approve' | 'reject' | 'edit'

export interface AgentInterruptAction {
  name: string
  args: Record<string, unknown>
  description?: string
  allowedDecisions: AgentInterruptDecision[]
}

export interface AgentInterrupt {
  id: string
  runId: string
  threadId: string
  checkpointId: string | null
  actions: AgentInterruptAction[]
  status: 'pending' | 'resolved'
  decision: AgentInterruptDecision[] | null
  createdAt: number
  resolvedAt: number | null
}

export interface AgentResumeRequest {
  threadId: string
  runId: string
  decisions: Array<{
    type: AgentInterruptDecision
    editedAction?: { name: string; args: Record<string, unknown> }
  }>
}

export interface WorkspaceAgentMemory {
  id: string
  scope: 'workspace' | 'global'
  scopeId: string
  workspaceId: string | null
  path: string
  content: string
  revision: number
  sourceThreadId: string | null
  sourceRunId: string | null
  createdAt: number
  updatedAt: number
}

export interface ChatTokenEvent {
  threadId: string
  token: string
  runId?: string
  stepId?: string
}

export interface ChatReasoningEvent {
  threadId: string
  token: string
  runId?: string
  stepId?: string
}

export interface ChatDoneEvent {
  threadId: string
  finalText: string
  runId?: string
}

export interface ChatInterruptedEvent {
  threadId: string
  runId: string
  interrupt: AgentInterrupt
}

export interface ChatRunStatusEvent {
  threadId: string
  runId: string
  status: AgentRunStatus
}

export interface ChatErrorEvent {
  threadId: string
  message: string
  runId?: string
  partialText?: string
}

export interface ChatTraceEvent {
  threadId: string
  runId: string
  step: AgentTraceStep
}

export interface ChatTitleUpdatedEvent {
  threadId: string
  title: string
}

export interface SummaryErrorEvent {
  docId: string
  message: string
}

export interface WorkspaceItemsChangedEvent {
  workspaceId: string
  reason: 'agent_add_docs' | 'user' | 'other'
  docIds?: string[]
}

export type EventChannelKey = keyof typeof IpcChannel & `Event${string}`
export type EventChannel = (typeof IpcChannel)[EventChannelKey]

export interface DocumentEvents {
  onDocumentUpdated(cb: (doc: Document) => void): void
  onWindowFocusChanged(cb: (focused: boolean) => void): void
  onImportProgress(cb: (payload: ImportProgress) => void): void
  onImportToast(cb: (message: string) => void): void
  onMenuExportBibtex(cb: () => void): void
  onMenuImportZotero(cb: () => void): void
  onMenuImportMendeley(cb: () => void): void
  onMenuImportIdentifier(cb: () => void): void
  onLibraryScanning(cb: (payload: ImportProgress) => void): void
  onLibrarySwitched(cb: (payload: LibrarySwitchResult) => void): void
  onSyncAuthConfirmation(cb: (payload: SyncAuthConfirmation) => void): void
  onAiSummaryUpdated(cb: (docId: string) => void): void
  onAiSummaryError(cb: (payload: SummaryErrorEvent) => void): void
  onAiChatToken(cb: (payload: ChatTokenEvent) => void): void
  onAiChatReasoning(cb: (payload: ChatReasoningEvent) => void): void
  onAiChatDone(cb: (payload: ChatDoneEvent) => void): void
  onAiChatError(cb: (payload: ChatErrorEvent) => void): void
  onAiChatTrace(cb: (payload: ChatTraceEvent) => void): void
  onAiChatInterrupted(cb: (payload: ChatInterruptedEvent) => void): void
  onAiChatRunStatus(cb: (payload: ChatRunStatusEvent) => void): void
  onAiChatTitleUpdated(cb: (payload: ChatTitleUpdatedEvent) => void): void
  onAiReportCreated(cb: (report: AiReport) => void): void
  onWorkspaceItemsChanged(cb: (payload: WorkspaceItemsChangedEvent) => void): void
  onMineruInstallProgress(cb: (payload: MineruInstallProgress) => void): void
  onOcrProgress(cb: (payload: OcrProgressEvent) => void): void
  onOcrCompleted(cb: (payload: OcrCompletedEvent) => void): void
  onOcrError(cb: (payload: OcrErrorEvent) => void): void
  off(channel: EventChannel, cb: unknown): void
}

export interface ReforaApi {
  getBootstrap(): Promise<BootstrapData>
  documents: {
    list(filter: ListFilter): Promise<Document[]>
    counts(): Promise<DocumentCounts>
    search(q: string, page?: PageRequest): Promise<SearchResult>
    get(id: string): Promise<Document | null>
    update(id: string, patch: DocumentPatch): Promise<Document>
    setStarred(id: string, value: boolean): Promise<void>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    bulkCategorize(ids: string[], catId: string): Promise<void>
    bulkRefreshMetadata(ids: string[]): Promise<void>
    openPdf(id: string, external?: boolean): Promise<Document>
    readPdfRange(id: string, begin: number, end: number): Promise<PdfRangeChunk>
    pdfAnnotations(id: string): Promise<PdfAnnotation[]>
    setPdfAnnotations(id: string, annotations: PdfAnnotation[]): Promise<PdfAnnotation[]>
    openInFinder(id: string): Promise<void>
    refreshMetadata(id: string): Promise<Document>
    relocateFile(id: string, newPath: string): Promise<Document>
    restoreFile(id: string): Promise<Document>
    previewUrl(id: string, version: string | number): string
  }
  search: {
    global(q: string): Promise<GlobalSearchResult>
  }
  import: {
    addFiles(paths: string[]): Promise<PdfImportResult>
    addFolder(dir: string): Promise<PdfImportResult>
    fromJson(file: string): Promise<number>
    fromZotero(): Promise<BibImportResult>
    fromMendeley(): Promise<BibImportResult>
    fromIdentifier(identifier: string): Promise<IdentifierImportResult>
  }
  categories: {
    list(): Promise<Category[]>
    create(name: string): Promise<Category>
    rename(id: string, name: string): Promise<void>
    delete(id: string): Promise<void>
    assign(docId: string, catId: string): Promise<void>
    unassign(docId: string, catId: string): Promise<void>
  }
  watch: {
    list(): Promise<WatchFolder[]>
    add(path: string): Promise<WatchFolder>
    remove(id: string): Promise<void>
    toggle(id: string, enabled: boolean): Promise<void>
  }
  settings: {
    get<T>(key: string, defaultValue: T): Promise<T>
    set(key: string, value: unknown): Promise<void>
  }
  sync: {
    status(): Promise<SyncServiceStatus>
    signIn(credentials: SyncCredentials): Promise<SyncServiceStatus>
    signUp(credentials: SyncCredentials): Promise<SyncSignUpResult>
    resendConfirmation(request: SyncEmailRequest): Promise<void>
    signOut(): Promise<SyncServiceStatus>
    setEnabled(enabled: boolean): Promise<SyncServiceStatus>
  }
  appearance: {
    setThemeSource(theme: ThemeMode): Promise<void>
  }
  webSearch: {
    getConfig(): Promise<WebSearchConfig>
    updateConfig(patch: WebSearchConfigPatch): Promise<WebSearchConfig>
    test(): Promise<WebSearchTestResult>
  }
  mineru: {
    status(): Promise<MineruEngineStatus>
    chooseInstallRoot(): Promise<MineruEngineStatus>
    install(): Promise<MineruEngineStatus>
    cancelInstall(): Promise<MineruEngineStatus>
    uninstall(): Promise<MineruEngineStatus>
  }
  ocr: {
    getState(documentId: string): Promise<OcrDocumentState>
    start(documentId: string, profile: OcrProfile): Promise<OcrJob>
    cancel(jobId: string): Promise<OcrJob>
    readMarkdown(documentId: string, resultKey: string): Promise<string>
    assetUrl(documentId: string, resultKey: string, assetPath: string): string
  }
  dialog: {
    openDirectory(): Promise<string | null>
  }
  library: {
    switch(path: string): Promise<LibrarySwitchResult>
  }
  getPathForFile(file: unknown): string
  export: {
    toJson(): Promise<string>
    toBibtex(ids: string[]): Promise<string>
    toBibtexString(ids: string[]): Promise<string>
  }
  clipboard: {
    writeText(text: string): Promise<void>
    copyMarkdown(title: string, content: string): Promise<void>
    copyWorkspaceAsset(id: string): Promise<void>
  }
  workspaces: {
    list(): Promise<Workspace[]>
    create(name: string): Promise<Workspace>
    rename(id: string, name: string): Promise<void>
    delete(id: string): Promise<void>
    openSandbox(id: string): Promise<void>
  }
  workspaceItems: {
    list(workspaceId: string): Promise<WorkspaceItem[]>
    add(workspaceId: string, kind: WorkspaceItemKind, ids: string[], placement?: WorkspaceItemPlacement): Promise<WorkspaceItem[]>
    remove(itemId: string): Promise<void>
    reorder(workspaceId: string, orderedIds: string[]): Promise<WorkspaceItem[]>
    resize(itemId: string, width: number, height: number): Promise<WorkspaceItem>
    move(itemId: string, x: number, y: number, zIndex: number): Promise<WorkspaceItem>
  }
  workspaceAssets: {
    list(workspaceId: string): Promise<WorkspaceAsset[]>
    addFiles(workspaceId: string, paths: string[], placement?: WorkspaceItemPlacement): Promise<WorkspaceAssetImportResult>
    textPreview(id: string): Promise<WorkspaceAssetTextPreview>
    open(id: string): Promise<void>
    reveal(id: string): Promise<void>
    delete(id: string): Promise<void>
    previewUrl(id: string): string
  }
  workspaceFiles: {
    add(workspaceId: string, paths: string[], placement?: WorkspaceItemPlacement): Promise<WorkspaceFileImportResult>
  }
  workspaceNotes: {
    list(workspaceId: string): Promise<WorkspaceNote[]>
    create(workspaceId: string, title: string, contentMd: string, noteType: WorkspaceNoteType, placement?: WorkspaceItemPlacement): Promise<WorkspaceNote>
    update(id: string, patch: WorkspaceNotePatch): Promise<WorkspaceNote>
    delete(id: string): Promise<void>
  }
  workspaceCanvas: {
    get(workspaceId: string): Promise<WorkspaceCanvasViewport>
    update(workspaceId: string, viewport: WorkspaceCanvasViewport): Promise<WorkspaceCanvasViewport>
  }
  workspaceConnections: {
    list(workspaceId: string): Promise<WorkspaceConnection[]>
    create(
      workspaceId: string,
      sourceItemId: string,
      targetItemId: string,
      sourceAnchor: WorkspaceConnectionAnchor,
      targetAnchor: WorkspaceConnectionAnchor
    ): Promise<WorkspaceConnection>
    delete(id: string): Promise<void>
  }
  aiProviders: {
    list(): Promise<AiProvider[]>
    create(input: AiProviderInput): Promise<AiProvider>
    update(id: string, patch: AiProviderPatch): Promise<AiProvider>
    delete(id: string): Promise<void>
    test(id: string): Promise<{ ok: boolean; models?: string[] }>
    listModels(req: ListModelsRequest): Promise<ListModelsResult>
  }
  agentProfiles: {
    list(): Promise<AgentProfile[]>
    create(input: AgentProfileInput): Promise<AgentProfile>
    update(id: string, patch: AgentProfilePatch): Promise<AgentProfile>
    delete(id: string): Promise<void>
    test(id: string): Promise<AgentProfileTestResult>
    listModels(id: string): Promise<ListModelsResult>
    scanRuntimes(): Promise<CliRuntimeInfo[]>
  }
  ai: {
    docTextGet(docId: string): Promise<string>
    summarize(docId: string): Promise<void>
    summaryGet(docId: string): Promise<AiSummary | null>
    chatSend(req: ChatSendRequest): Promise<{ threadId: string; runId: string }>
    chatHistory(threadId: string): Promise<ChatMessage[]>
    chatThreads(workspaceId: string | null): Promise<ChatThread[]>
    usageStats(): Promise<AiUsageStats>
    chatTraces(threadId: string): Promise<AgentTraceStep[]>
    chatRun(runId: string): Promise<AgentRun>
    chatCancel(runId: string): Promise<void>
    chatResume(req: AgentResumeRequest): Promise<void>
    chatPendingInterrupt(runId: string): Promise<AgentInterrupt | null>
    chatDeleteThread(threadId: string): Promise<void>
    renameThread(threadId: string, title: string): Promise<void>
    workspaceMemories(workspaceId: string | null): Promise<WorkspaceAgentMemory[]>
    updateWorkspaceMemory(
      workspaceId: string | null,
      path: string,
      content: string
    ): Promise<WorkspaceAgentMemory>
    deleteWorkspaceMemory(workspaceId: string | null, path: string): Promise<void>
  }
  reports: {
    list(workspaceId: string): Promise<AiReport[]>
    update(id: string, patch: { title?: string; contentMd?: string }): Promise<AiReport>
    delete(id: string): Promise<void>
  }
  events: DocumentEvents
}
