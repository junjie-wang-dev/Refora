import type { ServerLifecycle } from './serverLifecycle'
import type { NativeRpc } from './nativeRpc'
import type { NativeRpcInfo } from './nativeRpc'
import type { IpcError, Result } from '../../shared/ipc-types'
import type {
  AiProvider,
  AiProviderInput,
  AiReport,
  AiSummary,
  Category,
  ChatMessage,
  ChatThread,
  Document,
  DocumentPatch,
  Workspace,
  WorkspaceAgentMemory,
  WorkspaceAsset,
  WorkspaceAssetTextPreview,
  WorkspaceConnection,
  WorkspaceConnectionAnchor,
  WorkspaceItem,
  WorkspaceItemKind,
  WorkspaceItemPlacement,
  WorkspaceNote,
  WorkspaceNoteType,
  WatchFolder
} from '../../shared/ipc-types'
import type {
  MineruEngineStatus,
  OcrDocumentState,
  OcrProfile
} from '../../shared/mineru-types'
import type {
  WebSearchConfig,
  WebSearchConfigPatch,
  WebSearchTestResult
} from '../../shared/webSearch'
import type { ServerConnection } from './serverLifecycle'
import { logger } from './logger'

const TOKEN_HEADER = 'X-Refora-Token'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const WS_RECONNECT_BASE_MS = 500
const WS_RECONNECT_MAX_MS = 15_000
const WS_RECONNECT_MAX_ATTEMPTS = 10
const CONNECTOR_DEFAULT_TIMEOUT_MS = 30_000

export type WsEventName =
  | 'ai.chat.token'
  | 'ai.chat.reasoning'
  | 'ai.chat.done'
  | 'ai.chat.error'
  | 'ai.chat.trace'
  | 'ai.chat.interrupted'
  | 'ai.chat.run-status'
  | 'ai.chat.title-updated'
  | 'ai.chat.interrupt-request'
  | 'ai.chat.interrupt-resolve'
  | 'ai.summary.updated'
  | 'ai.summary.error'
  | 'ai.report.created'
  | 'document.updated'
  | 'library.scanning'
  | 'library.switched'
  | 'window.focus-changed'
  | 'import.progress'
  | 'import.toast'
  | 'workspace.items.changed'
  | 'mineru.install-progress'
  | 'ocr.progress'
  | 'ocr.completed'
  | 'ocr.error'
  | 'subscribed'
  | 'unsubscribed'
  | 'pong'
  | 'connector.trash-item'
  | 'connector.open-path'
  | 'connector.show-in-folder'
  | 'connector.dialog-open-directory'
  | 'connector.clipboard-write'
  | 'connector.get-api-key'

export type WsEventListener = (data: unknown) => void

export interface ServerClientDeps {
  fetchImpl?: typeof fetch
  WebSocketCtor?: typeof WebSocket
  requestTimeoutMs?: number
  connectorTimeoutMs?: number
  wsReconnectMaxAttempts?: number
}

export interface ConnectorResult {
  requestId: string
  ok: true
  data: unknown
}

export interface ConnectorErrorReply {
  requestId: string
  ok: false
  error: IpcError
}

export interface ConnectorRequest {
  requestId: string
  [key: string]: unknown
}

export interface DocumentsListQuery {
  q?: string
  categoryId?: string
  starred?: boolean
  limit?: number
  offset?: number
  [key: string]: string | number | boolean | undefined
}

export interface ImportFilesPayload {
  paths: string[]
}

export interface ImportFolderPayload {
  path: string
  recursive?: boolean
}

export interface ImportIdentifierPayload {
  identifier: string
}

export interface ImportBibPayload {
  dbPath?: string
  paths: string[]
}

export interface BulkCategorizePayload {
  ids: string[]
  categoryId: string | null
}

export interface BulkIdsPayload {
  ids: string[]
}

export interface RelocatePayload {
  path: string
}

export interface CategoryCreatePayload {
  name: string
  color?: string
}

export interface CategoryPatchPayload {
  name?: string
  color?: string
}

export interface CategoryAssignPayload {
  documentIds: string[]
}

export interface WatchCreatePayload {
  path: string
}

export interface WatchTogglePayload {
  enabled: boolean
}

export interface LibrarySwitchPayload {
  path: string
}

export interface ExportJsonPayload {
  documentIds?: string[]
  workspaceId?: string
}

export interface ExportBibtexPayload {
  documentIds: string[]
}

export interface ClipboardWritePayload {
  text: string
}

export interface ClipboardCopyMarkdownPayload {
  markdown: string
}

export interface ClipboardCopyAssetPayload {
  assetId: string
}

export interface ProviderTestPayload {
  apiKey: string
}

export interface ProviderModelsPayload {
  apiKey: string
}

export interface SummarizePayload {
  documentId: string
  provider: ProviderConfig
}

export interface ChatSendPayload {
  runId: string
  threadId: string
  workspaceId: string | null
  checkpointPath: string
  checkpointBefore: string | null
  provider: ProviderConfig
  systemPrompt: string
  messages?: unknown[]
  decisions?: unknown[]
  enabledToolNames: string[]
  sandboxRoot: string | null
  memories: Record<string, string>
  includeResearchMemory: boolean
  recursionLimit: number
}

export interface ChatResumePayload {
  runId: string
  threadId: string
  decisions: unknown[]
}

export interface ChatCancelPayload {
  runId: string
}

export interface ChatThreadsQuery {
  workspaceId?: string
  [key: string]: string | number | boolean | undefined
}

export interface RenameThreadPayload {
  title: string
}

export interface MemoryUpdatePayload {
  value: string
}

export interface ReportPatchPayload {
  title?: string
  contentMd?: string
}

export interface WorkspaceCreatePayload {
  name: string
}

export interface WorkspaceItemInput {
  kind: WorkspaceItemKind
  docId?: string | null
  reportId?: string | null
  noteId?: string | null
  assetId?: string | null
  placement?: WorkspaceItemPlacement
}

export interface WorkspaceItemsReorderPayload {
  ids: string[]
}

export interface WorkspaceItemSizePayload {
  width: number
  height: number
}

export interface WorkspaceItemMovePayload {
  itemId: string
  targetWorkspaceId: string
}

export interface WorkspaceAssetsFilesPayload {
  paths: string[]
}

export interface WorkspaceConnectionInput {
  sourceItemId: string
  targetItemId: string
  sourceAnchor: WorkspaceConnectionAnchor
  targetAnchor: WorkspaceConnectionAnchor
}

export interface WorkspaceNoteInput {
  title: string
  contentMd: string
  noteType: WorkspaceNoteType
  placement?: WorkspaceItemPlacement
}

export interface MineruInstallPayload {
  installRoot?: string
}

export interface OcrStartPayload {
  documentId: string
  profile: OcrProfile
}

export interface OcrCancelPayload {
  jobId: string
}

export interface ProviderConfig {
  model: string
  baseUrl: string
  apiKey: string
  useResponsesApi: boolean
  modelKwargs: Record<string, unknown>
  reasoning?: { effort: string; summary: 'auto' }
  temperature: number | null
  maxTokens: number | null
}

export interface ServerHttp {
  systemReady(): Promise<{ status: string }>
  systemShutdown(): Promise<{ ack: boolean }>

  documentsList(query?: DocumentsListQuery): Promise<Document[]>
  documentsCount(query?: DocumentsListQuery): Promise<{ count: number }>
  documentsSearch(q: string): Promise<Document[]>
  documentsGet(documentId: string): Promise<Document>
  documentsUpdate(documentId: string, patch: DocumentPatch): Promise<Document>
  documentsSetStarred(documentId: string, starred: boolean): Promise<Document>
  documentsDelete(documentId: string): Promise<{ ack: boolean }>
  documentsBulkDelete(ids: string[]): Promise<{ ack: boolean }>
  documentsBulkCategorize(payload: BulkCategorizePayload): Promise<{ ack: boolean }>
  documentsBulkRefreshMetadata(ids: string[]): Promise<{ ack: boolean }>
  documentsRefreshMetadata(documentId: string): Promise<Document>
  documentsRelocate(documentId: string, payload: RelocatePayload): Promise<Document>
  documentsRestoreFile(documentId: string): Promise<Document>
  documentsOpenPdf(documentId: string): Promise<{ ack: boolean }>
  documentsOpenInFinder(documentId: string): Promise<{ ack: boolean }>

  importFiles(payload: ImportFilesPayload): Promise<{ imported: Document[]; skipped: Array<{ path: string; reason: string }> }>
  importFolder(payload: ImportFolderPayload): Promise<{ imported: Document[] }>
  importJson(payload: unknown): Promise<{ imported: number }>
  importZotero(payload: ImportBibPayload): Promise<{ imported: number }>
  importMendeley(payload: ImportBibPayload): Promise<{ imported: number }>
  importIdentifier(payload: ImportIdentifierPayload): Promise<{ documentId: string }>

  categoriesList(): Promise<Category[]>
  categoriesCreate(payload: CategoryCreatePayload): Promise<Category>
  categoriesUpdate(categoryId: string, patch: CategoryPatchPayload): Promise<Category>
  categoriesDelete(categoryId: string): Promise<{ ack: boolean }>
  categoriesAssign(categoryId: string, payload: CategoryAssignPayload): Promise<{ ack: boolean }>
  categoriesUnassign(categoryId: string, payload: CategoryAssignPayload): Promise<{ ack: boolean }>

  watchList(): Promise<WatchFolder[]>
  watchAdd(payload: WatchCreatePayload): Promise<WatchFolder>
  watchRemove(watchId: string): Promise<{ ack: boolean }>
  watchToggle(watchId: string, payload: WatchTogglePayload): Promise<WatchFolder>

  librarySwitch(payload: LibrarySwitchPayload): Promise<{ ack: boolean }>

  settingsGet(): Promise<Record<string, unknown>>
  settingsUpdate(patch: Record<string, unknown>): Promise<Record<string, unknown>>
  settingsWebSearchGet(): Promise<WebSearchConfig>
  settingsWebSearchUpdate(patch: WebSearchConfigPatch): Promise<WebSearchConfig>
  settingsWebSearchTest(query: string): Promise<WebSearchTestResult>

  aiProvidersList(): Promise<AiProvider[]>
  aiProvidersCreate(input: AiProviderInput): Promise<AiProvider>
  aiProvidersUpdate(providerId: string, input: AiProviderInput): Promise<AiProvider>
  aiProvidersDelete(providerId: string): Promise<{ ack: boolean }>
  aiProvidersTest(providerId: string, payload: ProviderTestPayload): Promise<{ ok: boolean; model?: string }>
  aiProvidersModels(providerId: string, payload: ProviderModelsPayload): Promise<{ models: string[] }>

  aiDocTextGet(documentId: string): Promise<{ text: string }>
  aiSummarize(payload: SummarizePayload): Promise<{ summaryId: string }>
  aiSummaryGet(documentId: string): Promise<AiSummary | null>

  aiChatSend(payload: ChatSendPayload): Promise<{ runId: string }>
  aiChatResume(payload: ChatResumePayload): Promise<{ runId: string }>
  aiChatCancel(payload: ChatCancelPayload): Promise<{ ack: boolean }>
  aiChatThreads(query?: ChatThreadsQuery): Promise<ChatThread[]>
  aiChatHistory(threadId: string): Promise<ChatMessage[]>
  aiChatTraces(threadId: string): Promise<unknown[]>
  aiChatPendingInterrupt(threadId: string): Promise<unknown | null>
  aiChatDeleteThread(threadId: string): Promise<{ ack: boolean }>
  aiChatRenameThread(threadId: string, payload: RenameThreadPayload): Promise<ChatThread>
  aiChatMemories(threadId: string): Promise<WorkspaceAgentMemory[]>
  aiChatUpdateMemory(threadId: string, memoryId: string, payload: MemoryUpdatePayload): Promise<WorkspaceAgentMemory>
  aiChatDeleteMemory(threadId: string, memoryId: string): Promise<{ ack: boolean }>

  aiReportsList(workspaceId?: string): Promise<AiReport[]>
  aiReportsDelete(reportId: string): Promise<{ ack: boolean }>
  aiReportsUpdate(reportId: string, patch: ReportPatchPayload): Promise<AiReport>

  workspacesList(): Promise<Workspace[]>
  workspacesCreate(payload: WorkspaceCreatePayload): Promise<Workspace>
  workspacesUpdate(workspaceId: string, payload: WorkspaceCreatePayload): Promise<Workspace>
  workspacesDelete(workspaceId: string): Promise<{ ack: boolean }>
  workspacesOpenSandbox(workspaceId: string): Promise<{ ack: boolean }>

  workspaceItemsList(workspaceId: string): Promise<WorkspaceItem[]>
  workspaceItemsCreate(workspaceId: string, input: WorkspaceItemInput): Promise<WorkspaceItem>
  workspaceItemsDelete(workspaceId: string, itemId: string): Promise<{ ack: boolean }>
  workspaceItemsReorder(workspaceId: string, payload: WorkspaceItemsReorderPayload): Promise<{ ack: boolean }>
  workspaceItemResize(workspaceId: string, itemId: string, payload: WorkspaceItemSizePayload): Promise<WorkspaceItem>
  workspaceItemMove(workspaceId: string, payload: WorkspaceItemMovePayload): Promise<WorkspaceItem>

  workspaceAssetsList(workspaceId: string): Promise<WorkspaceAsset[]>
  workspaceAssetsAddFiles(workspaceId: string, payload: WorkspaceAssetsFilesPayload): Promise<WorkspaceAsset[]>
  workspaceAssetPreview(workspaceId: string, assetId: string): Promise<WorkspaceAssetTextPreview>
  workspaceAssetOpen(workspaceId: string, assetId: string): Promise<{ ack: boolean }>
  workspaceAssetReveal(workspaceId: string, assetId: string): Promise<{ ack: boolean }>
  workspaceAssetDelete(workspaceId: string, assetId: string): Promise<{ ack: boolean }>

  workspaceCanvasGet(workspaceId: string): Promise<unknown>
  workspaceCanvasUpdate(workspaceId: string, canvas: unknown): Promise<unknown>
  workspaceConnectionsList(workspaceId: string): Promise<WorkspaceConnection[]>
  workspaceConnectionsCreate(workspaceId: string, input: WorkspaceConnectionInput): Promise<WorkspaceConnection>
  workspaceConnectionsDelete(workspaceId: string, connectionId: string): Promise<{ ack: boolean }>
  workspaceNotesList(workspaceId: string): Promise<WorkspaceNote[]>
  workspaceNotesCreate(workspaceId: string, input: WorkspaceNoteInput): Promise<WorkspaceNote>
  workspaceNotesUpdate(workspaceId: string, noteId: string, input: WorkspaceNoteInput): Promise<WorkspaceNote>
  workspaceNotesDelete(workspaceId: string, noteId: string): Promise<{ ack: boolean }>

  mineruStatus(): Promise<MineruEngineStatus>
  mineruInstall(payload?: MineruInstallPayload): Promise<{ ack: boolean }>
  mineruCancelInstall(): Promise<{ ack: boolean }>
  mineruUninstall(): Promise<{ ack: boolean }>
  ocrStart(payload: OcrStartPayload): Promise<{ jobId: string }>
  ocrCancel(payload: OcrCancelPayload): Promise<{ ack: boolean }>
  ocrState(): Promise<OcrDocumentState>
  ocrMarkdown(jobId: string): Promise<{ markdown: string }>

  exportJson(payload: ExportJsonPayload): Promise<unknown>
  exportBibtex(payload: ExportBibtexPayload): Promise<unknown>
  exportBibtexString(documentIds: string[]): Promise<{ bibtex: string }>

  clipboardWriteText(payload: ClipboardWritePayload): Promise<{ ack: boolean }>
  clipboardCopyMarkdown(payload: ClipboardCopyMarkdownPayload): Promise<{ ack: boolean }>
  clipboardCopyWorkspaceAsset(payload: ClipboardCopyAssetPayload): Promise<{ ack: boolean }>
}

export interface ServerWs {
  connect(): Promise<void>
  disconnect(): void
  isConnected(): boolean
  on(event: WsEventName, cb: WsEventListener): () => void
  off(event: WsEventName, cb: WsEventListener): void
  subscribe(topics: string[]): void
  unsubscribe(topics: string[]): void
  ping(): void
  sendConnectorResult(reply: ConnectorResult): void
  sendConnectorError(reply: ConnectorErrorReply): void
}

export interface ServerClient {
  http: ServerHttp
  ws: ServerWs
}

function toIpcError(error: IpcError): IpcError {
  return { code: error.code, message: error.message }
}

function makeError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  if (entries.length === 0) return ''
  const search = new URLSearchParams()
  for (const [key, value] of entries) {
    search.set(key, String(value))
  }
  return `?${search.toString()}`
}

export function createServerClient(
  lifecycle: ServerLifecycle,
  nativeRpc: NativeRpc,
  deps: ServerClientDeps = {}
): ServerClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  const WebSocketCtor = deps.WebSocketCtor ?? WebSocket
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const connectorTimeoutMs = deps.connectorTimeoutMs ?? CONNECTOR_DEFAULT_TIMEOUT_MS
  const wsReconnectMaxAttempts = deps.wsReconnectMaxAttempts ?? WS_RECONNECT_MAX_ATTEMPTS

  async function getConnection(): Promise<ServerConnection> {
    return lifecycle.getServerBaseUrl()
  }

  async function request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}
  ): Promise<T> {
    const conn = await getConnection()
    const url = `${conn.baseUrl}${path}${buildQuery(options.query ?? {})}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          [TOKEN_HEADER]: conn.token,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      })
    } catch (e) {
      clearTimeout(timer)
      if (e instanceof Error && e.name === 'AbortError') {
        throw makeError('timeout', `Request timed out after ${requestTimeoutMs}ms: ${method} ${path}`)
      }
      throw makeError('network_error', e instanceof Error ? e.message : String(e))
    }
    clearTimeout(timer)

    let payload: Result<T>
    try {
      payload = (await response.json()) as Result<T>
    } catch (e) {
      throw makeError('bad_response', `Failed to parse response: ${e instanceof Error ? e.message : String(e)}`)
    }

    if (payload.ok) return payload.data
    throw makeError(payload.error.code, payload.error.message)
  }

  function get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return request<T>('GET', path, { query })
  }

  function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, { body })
  }

  function patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PATCH', path, { body })
  }

  function del<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return request<T>('DELETE', path, { query })
  }

  function put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PUT', path, { body })
  }

  const http: ServerHttp = {
    systemReady: () => get<{ status: string }>('/ready'),
    systemShutdown: () => post<{ ack: boolean }>('/shutdown'),

    documentsList: (query) => get<Document[]>('/documents', query),
    documentsCount: (query) => get<{ count: number }>('/documents/count', query),
    documentsSearch: (q) => get<Document[]>('/documents/search', { q }),
    documentsGet: (id) => get<Document>(`/documents/${id}`),
    documentsUpdate: (id, p) => patch<Document>(`/documents/${id}`, p),
    documentsSetStarred: (id, starred) => post<Document>(`/documents/${id}/starred`, { starred }),
    documentsDelete: (id) => del<{ ack: boolean }>(`/documents/${id}`),
    documentsBulkDelete: (ids) => post<{ ack: boolean }>('/documents/bulk-delete', { ids }),
    documentsBulkCategorize: (payload) => post<{ ack: boolean }>('/documents/bulk-categorize', payload),
    documentsBulkRefreshMetadata: (ids) => post<{ ack: boolean }>('/documents/bulk-refresh-metadata', { ids }),
    documentsRefreshMetadata: (id) => post<Document>(`/documents/${id}/refresh-metadata`),
    documentsRelocate: (id, payload) => post<Document>(`/documents/${id}/relocate`, payload),
    documentsRestoreFile: (id) => post<Document>(`/documents/${id}/restore-file`),
    documentsOpenPdf: (id) => post<{ ack: boolean }>(`/documents/${id}/open-pdf`),
    documentsOpenInFinder: (id) => post<{ ack: boolean }>(`/documents/${id}/open-in-finder`),

    importFiles: (payload) => post<{ imported: Document[]; skipped: Array<{ path: string; reason: string }> }>('/import/files', payload),
    importFolder: (payload) => post<{ imported: Document[] }>('/import/folder', payload),
    importJson: (payload) => post<{ imported: number }>('/import/json', payload),
    importZotero: (payload) => post<{ imported: number }>('/import/zotero', payload),
    importMendeley: (payload) => post<{ imported: number }>('/import/mendeley', payload),
    importIdentifier: (payload) => post<{ documentId: string }>('/import/identifier', payload),

    categoriesList: () => get<Category[]>('/categories'),
    categoriesCreate: (payload) => post<Category>('/categories', payload),
    categoriesUpdate: (id, p) => patch<Category>(`/categories/${id}`, p),
    categoriesDelete: (id) => del<{ ack: boolean }>(`/categories/${id}`),
    categoriesAssign: (id, payload) => post<{ ack: boolean }>(`/categories/${id}/assign`, payload),
    categoriesUnassign: (id, payload) => post<{ ack: boolean }>(`/categories/${id}/unassign`, payload),

    watchList: () => get<WatchFolder[]>('/watch'),
    watchAdd: (payload) => post<WatchFolder>('/watch', payload),
    watchRemove: (id) => del<{ ack: boolean }>(`/watch/${id}`),
    watchToggle: (id, payload) => post<WatchFolder>(`/watch/${id}/toggle`, payload),

    librarySwitch: (payload) => post<{ ack: boolean }>('/library/switch', payload),

    settingsGet: () => get<Record<string, unknown>>('/settings'),
    settingsUpdate: (changes) => patch('/settings', changes),
    settingsWebSearchGet: () => get<WebSearchConfig>('/settings/web-search'),
    settingsWebSearchUpdate: (p) => patch<WebSearchConfig>('/settings/web-search', p),
    settingsWebSearchTest: (query) => post<WebSearchTestResult>('/settings/web-search/test', { query }),

    aiProvidersList: () => get<AiProvider[]>('/ai/providers'),
    aiProvidersCreate: (input) => post<AiProvider>('/ai/providers', input),
    aiProvidersUpdate: (id, input) => patch<AiProvider>(`/ai/providers/${id}`, input),
    aiProvidersDelete: (id) => del<{ ack: boolean }>(`/ai/providers/${id}`),
    aiProvidersTest: (id, payload) => post<{ ok: boolean; model?: string }>(`/ai/providers/${id}/test`, payload),
    aiProvidersModels: (id, payload) => post<{ models: string[] }>(`/ai/providers/${id}/models`, payload),

    aiDocTextGet: (id) => get<{ text: string }>(`/ai/doc-text/${id}`),
    aiSummarize: (payload) => post<{ summaryId: string }>('/ai/summarize', payload),
    aiSummaryGet: (id) => get<AiSummary | null>(`/ai/summary/${id}`),

    aiChatSend: (payload) => post<{ runId: string }>('/ai/chat/send', payload),
    aiChatResume: (payload) => post<{ runId: string }>('/ai/chat/resume', payload),
    aiChatCancel: (payload) => post<{ ack: boolean }>('/ai/chat/cancel', payload),
    aiChatThreads: (query) => get<ChatThread[]>('/ai/chat/threads', query),
    aiChatHistory: (id) => get<ChatMessage[]>(`/ai/chat/threads/${id}/history`),
    aiChatTraces: (id) => get<unknown[]>(`/ai/chat/threads/${id}/traces`),
    aiChatPendingInterrupt: (id) => get<unknown | null>(`/ai/chat/threads/${id}/pending-interrupt`),
    aiChatDeleteThread: (id) => del<{ ack: boolean }>(`/ai/chat/threads/${id}`),
    aiChatRenameThread: (id, payload) => patch<ChatThread>(`/ai/chat/threads/${id}`, payload),
    aiChatMemories: (id) => get<WorkspaceAgentMemory[]>(`/ai/chat/threads/${id}/memories`),
    aiChatUpdateMemory: (id, memoryId, payload) => put<WorkspaceAgentMemory>(`/ai/chat/threads/${id}/memories/${memoryId}`, payload),
    aiChatDeleteMemory: (id, memoryId) => del<{ ack: boolean }>(`/ai/chat/threads/${id}/memories/${memoryId}`),

    aiReportsList: (workspaceId) => get<AiReport[]>('/ai/reports', { workspaceId }),
    aiReportsDelete: (id) => del<{ ack: boolean }>(`/ai/reports/${id}`),
    aiReportsUpdate: (id, changes) => patch<AiReport>(`/ai/reports/${id}`, changes),

    workspacesList: () => get<Workspace[]>('/workspaces'),
    workspacesCreate: (payload) => post<Workspace>('/workspaces', payload),
    workspacesUpdate: (id, payload) => patch<Workspace>(`/workspaces/${id}`, payload),
    workspacesDelete: (id) => del<{ ack: boolean }>(`/workspaces/${id}`),
    workspacesOpenSandbox: (id) => post<{ ack: boolean }>(`/workspaces/${id}/open-sandbox`),

    workspaceItemsList: (id) => get<WorkspaceItem[]>(`/workspaces/${id}/items`),
    workspaceItemsCreate: (id, input) => post<WorkspaceItem>(`/workspaces/${id}/items`, input),
    workspaceItemsDelete: (id, itemId) => del<{ ack: boolean }>(`/workspaces/${id}/items/${itemId}`),
    workspaceItemsReorder: (id, payload) => post<{ ack: boolean }>(`/workspaces/${id}/items/reorder`, payload),
    workspaceItemResize: (id, itemId, payload) => patch<WorkspaceItem>(`/workspaces/${id}/items/${itemId}/size`, payload),
    workspaceItemMove: (id, payload) => post<WorkspaceItem>(`/workspaces/${id}/items/move`, payload),

    workspaceAssetsList: (id) => get<WorkspaceAsset[]>(`/workspaces/${id}/assets`),
    workspaceAssetsAddFiles: (id, payload) => post<WorkspaceAsset[]>(`/workspaces/${id}/assets/files`, payload),
    workspaceAssetPreview: (id, assetId) => get<WorkspaceAssetTextPreview>(`/workspaces/${id}/assets/${assetId}/preview`),
    workspaceAssetOpen: (id, assetId) => post<{ ack: boolean }>(`/workspaces/${id}/assets/${assetId}/open`),
    workspaceAssetReveal: (id, assetId) => post<{ ack: boolean }>(`/workspaces/${id}/assets/${assetId}/reveal`),
    workspaceAssetDelete: (id, assetId) => del<{ ack: boolean }>(`/workspaces/${id}/assets/${assetId}`),

    workspaceCanvasGet: (id) => get<unknown>(`/workspaces/${id}/canvas`),
    workspaceCanvasUpdate: (id, canvas) => put<unknown>(`/workspaces/${id}/canvas`, canvas),
    workspaceConnectionsList: (id) => get<WorkspaceConnection[]>(`/workspaces/${id}/connections`),
    workspaceConnectionsCreate: (id, input) => post<WorkspaceConnection>(`/workspaces/${id}/connections`, input),
    workspaceConnectionsDelete: (id, connectionId) => del<{ ack: boolean }>(`/workspaces/${id}/connections/${connectionId}`),
    workspaceNotesList: (id) => get<WorkspaceNote[]>(`/workspaces/${id}/notes`),
    workspaceNotesCreate: (id, input) => post<WorkspaceNote>(`/workspaces/${id}/notes`, input),
    workspaceNotesUpdate: (id, noteId, input) => patch<WorkspaceNote>(`/workspaces/${id}/notes/${noteId}`, input),
    workspaceNotesDelete: (id, noteId) => del<{ ack: boolean }>(`/workspaces/${id}/notes/${noteId}`),

    mineruStatus: () => get<MineruEngineStatus>('/mineru/status'),
    mineruInstall: (payload) => post<{ ack: boolean }>('/mineru/install', payload ?? {}),
    mineruCancelInstall: () => post<{ ack: boolean }>('/mineru/cancel-install'),
    mineruUninstall: () => post<{ ack: boolean }>('/mineru/uninstall'),
    ocrStart: (payload) => post<{ jobId: string }>('/ocr/start', payload),
    ocrCancel: (payload) => post<{ ack: boolean }>('/ocr/cancel', payload),
    ocrState: () => get<OcrDocumentState>('/ocr/state'),
    ocrMarkdown: (jobId) => get<{ markdown: string }>(`/ocr/${jobId}/markdown`),

    exportJson: (payload) => post<unknown>('/export/json', payload),
    exportBibtex: (payload) => post<unknown>('/export/bibtex', payload),
    exportBibtexString: (ids) => get<{ bibtex: string }>('/export/bibtex-string', { documentIds: ids.join(',') }),

    clipboardWriteText: (payload) => post<{ ack: boolean }>('/clipboard/write-text', payload),
    clipboardCopyMarkdown: (payload) => post<{ ack: boolean }>('/clipboard/copy-markdown', payload),
    clipboardCopyWorkspaceAsset: (payload) => post<{ ack: boolean }>('/clipboard/copy-workspace-asset', payload)
  }

  const listeners = new Map<WsEventName, Set<WsEventListener>>()
  let ws: WebSocket | null = null
  let connection: ServerConnection | null = null
  let connectPromise: Promise<void> | null = null
  let reconnectAttempts = 0
  let manualClose = false

  function ensureListeners(event: WsEventName): Set<WsEventListener> {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    return set
  }

  function dispatch(event: WsEventName, data: unknown): void {
    const set = listeners.get(event)
    if (!set) return
    for (const cb of set) {
      try {
        cb(data)
      } catch (e) {
        logger.warn(`serverClient:listener-error ${event}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  function sendRaw(message: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('serverClient:send-failed ws not open')
      return
    }
    ws.send(JSON.stringify(message))
  }

  function sendConnectorResultImpl(reply: ConnectorResult): void {
    sendRaw({ event: 'connector.result', data: reply })
  }

  function sendConnectorErrorImpl(reply: ConnectorErrorReply): void {
    sendRaw({ event: 'connector.error', data: reply })
  }

  async function forwardToNative(
    route: string,
    body: unknown
  ): Promise<Result<unknown>> {
    let info: NativeRpcInfo
    try {
      info = await nativeRpc.start()
    } catch (e) {
      return {
        ok: false,
        error: { code: 'native_unavailable', message: e instanceof Error ? e.message : String(e) }
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), connectorTimeoutMs)
    try {
      const res = await fetchImpl(`${info.baseUrl}${route}`, {
        method: 'POST',
        headers: {
          'x-refora-token': info.token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal
      })
      return (await res.json()) as Result<unknown>
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return { ok: false, error: { code: 'connector_timeout', message: `Native RPC timed out: ${route}` } }
      }
      return {
        ok: false,
        error: { code: 'native_error', message: e instanceof Error ? e.message : String(e) }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function handleConnectorRequest(event: WsEventName, request: ConnectorRequest): Promise<void> {
    const { requestId } = request
    let route: string
    let body: Record<string, unknown>
    switch (event) {
      case 'connector.trash-item':
        route = '/native/trash-item'
        body = { path: request.path }
        break
      case 'connector.open-path':
        route = '/native/open-path'
        body = { path: request.path }
        break
      case 'connector.show-in-folder':
        route = '/native/show-in-folder'
        body = { path: request.path }
        break
      case 'connector.dialog-open-directory':
        route = '/native/dialog-open-directory'
        body = { title: request.title }
        break
      case 'connector.clipboard-write':
        route = '/native/clipboard-write'
        body = { text: request.text }
        break
      case 'connector.get-api-key':
        route = '/native/get-api-key'
        body = { providerId: request.providerId }
        break
      default:
        sendConnectorErrorImpl({ requestId, ok: false, error: { code: 'unknown_connector', message: `Unknown connector event: ${event}` } })
        return
    }
    const result = await forwardToNative(route, body)
    if (result.ok) {
      sendConnectorResultImpl({ requestId, ok: true, data: result.data })
    } else {
      sendConnectorErrorImpl({ requestId, ok: false, error: toIpcError(result.error) })
    }
  }

  function handleMessage(raw: string): void {
    let message: { event?: string; data?: unknown; topics?: unknown }
    try {
      message = JSON.parse(raw) as { event?: string; data?: unknown; topics?: unknown }
    } catch (e) {
      logger.warn(`serverClient:parse-error ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const eventName = message.event
    if (!eventName) return
    const event = eventName as WsEventName
    const data = message.data ?? (
      (event === 'subscribed' || event === 'unsubscribed') && Array.isArray(message.topics)
        ? { topics: message.topics }
        : undefined
    )
    if (event.startsWith('connector.')) {
      const request = (data ?? {}) as ConnectorRequest
      if (typeof request.requestId === 'string') {
        void handleConnectorRequest(event, request)
      }
      return
    }
    dispatch(event, data)
  }

  function scheduleReconnect(): void {
    if (manualClose) return
    if (reconnectAttempts >= wsReconnectMaxAttempts) {
      logger.error(`serverClient:reconnect exhausted (${wsReconnectMaxAttempts} attempts)`)
      return
    }
    reconnectAttempts += 1
    const backoff = Math.min(
      WS_RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1),
      WS_RECONNECT_MAX_MS
    )
    logger.warn(`serverClient:reconnect in ${backoff}ms (attempt ${reconnectAttempts}/${wsReconnectMaxAttempts})`)
    setTimeout(() => {
      if (manualClose) return
      connectPromise = doConnect().catch((e) => {
        logger.warn(`serverClient:reconnect failed: ${e instanceof Error ? e.message : String(e)}`)
        connectPromise = null
      })
    }, backoff)
  }

  async function doConnect(): Promise<void> {
    connection = await getConnection()
    const url = `ws://127.0.0.1:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
    ws = new WebSocketCtor(url)
    await new Promise<void>((resolve, reject) => {
      if (!ws) {
        reject(makeError('ws_error', 'WebSocket not initialized'))
        return
      }
      const onOpen = (): void => {
        cleanup()
        reconnectAttempts = 0
        resolve()
      }
      const onError = (): void => {
        cleanup()
        reject(makeError('ws_error', `Failed to connect to ${url}`))
      }
      const cleanup = (): void => {
        ws?.removeEventListener('open', onOpen)
        ws?.removeEventListener('error', onError)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
    })

    if (!ws) return
    ws.addEventListener('message', (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : ''
      handleMessage(data)
    })
    ws.addEventListener('close', () => {
      if (manualClose) return
      scheduleReconnect()
    })
    ws.addEventListener('error', (event: Event) => {
      logger.warn(`serverClient:ws-error ${event.type}`)
    })
  }

  const wsApi: ServerWs = {
    async connect(): Promise<void> {
      if (ws && ws.readyState === WebSocket.OPEN) return
      if (connectPromise) return connectPromise
      connectPromise = doConnect().finally(() => {
        connectPromise = null
      })
      return connectPromise
    },
    disconnect(): void {
      manualClose = true
      connectPromise = null
      reconnectAttempts = 0
      if (ws) {
        try {
          ws.close()
        } catch {
          // ignore
        }
        ws = null
      }
      manualClose = false
    },
    isConnected(): boolean {
      return ws !== null && ws.readyState === WebSocket.OPEN
    },
    on(event, cb): () => void {
      const set = ensureListeners(event)
      set.add(cb)
      return () => {
        set.delete(cb)
      }
    },
    off(event, cb): void {
      const set = listeners.get(event)
      if (set) set.delete(cb)
    },
    subscribe(topics): void {
      sendRaw({ event: 'subscribe', data: { topics } })
    },
    unsubscribe(topics): void {
      sendRaw({ event: 'unsubscribe', data: { topics } })
    },
    ping(): void {
      sendRaw({ event: 'ping' })
    },
    sendConnectorResult: sendConnectorResultImpl,
    sendConnectorError: sendConnectorErrorImpl
  }

  return { http, ws: wsApi }
}

export type { ServerLifecycle, NativeRpc }
