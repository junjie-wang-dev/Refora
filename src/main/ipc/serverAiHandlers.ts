import { randomUUID } from 'node:crypto'
import { IpcChannel } from '../../shared/ipc-channels'
import type {
  AgentInterrupt,
  AgentResumeRequest,
  AgentRun,
  AgentTraceStep,
  AiReport,
  AiSummary,
  ChatMessage,
  ChatSendRequest,
  ChatThread,
  Result,
  WorkspaceAgentMemory
} from '../../shared/ipc-types'
import type {
  ChatResumePayload,
  ServerClient,
} from '../services/serverClient'

function errorResult(error: unknown): Result<never> {
  const value = error as { code?: unknown; message?: unknown }
  return {
    ok: false,
    error: {
      code: typeof value?.code === 'string' ? value.code : 'internal_error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

async function asyncWrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return errorResult(error)
  }
}

export interface ServerAiHandlerDeps {
  serverClient: ServerClient
}

export function createServerAiHandlers(deps: ServerAiHandlerDeps) {
  const { http } = deps.serverClient

  return {
    [IpcChannel.AiDocTextGet]: (documentId: string): Promise<Result<string>> =>
      asyncWrap(async () => (await http.aiDocTextGet(documentId)).text),
    [IpcChannel.AiSummarize]: (documentId: string): Promise<Result<void>> =>
      asyncWrap(async () => {
        await http.aiSummarize({ documentId })
      }),
    [IpcChannel.AiSummaryGet]: (documentId: string): Promise<Result<AiSummary | null>> =>
      asyncWrap(() => http.aiSummaryGet(documentId)),

    [IpcChannel.AiChatSend]: (
      request: ChatSendRequest
    ): Promise<Result<{ threadId: string; runId: string }>> =>
      asyncWrap(async () => {
        const runId = request.runId?.trim() || randomUUID()
        const result = await http.aiChatSend({
          ...request,
          runId
        })
        return result
      }),
    [IpcChannel.AiChatResume]: (request: AgentResumeRequest): Promise<Result<void>> =>
      asyncWrap(async () => {
        await http.aiChatResume(request as ChatResumePayload)
      }),
    [IpcChannel.AiChatCancel]: (runId: string): Promise<Result<void>> =>
      asyncWrap(async () => {
        await http.aiChatCancel({ runId })
      }),
    [IpcChannel.AiChatHistory]: (threadId: string): Promise<Result<ChatMessage[]>> =>
      asyncWrap(() => http.aiChatHistory(threadId)),
    [IpcChannel.AiChatThreads]: (workspaceId: string | null): Promise<Result<ChatThread[]>> =>
      asyncWrap(() => http.aiChatThreads(workspaceId === null ? {} : { workspaceId })),
    [IpcChannel.AiChatTraces]: (threadId: string): Promise<Result<AgentTraceStep[]>> =>
      asyncWrap(async () => (await http.aiChatTraces(threadId)) as AgentTraceStep[]),
    [IpcChannel.AiChatRun]: (runId: string): Promise<Result<AgentRun>> =>
      asyncWrap(() => http.aiChatRun(runId)),
    [IpcChannel.AiChatPendingInterrupt]: (runId: string): Promise<Result<AgentInterrupt | null>> =>
      asyncWrap(async () => (await http.aiChatPendingInterrupt(runId)) as AgentInterrupt | null),
    [IpcChannel.AiChatRenameThread]: (
      threadId: string,
      title: string
    ): Promise<Result<ChatThread>> =>
      asyncWrap(() => http.aiChatRenameThread(threadId, { title })),
    [IpcChannel.AiChatDeleteThread]: (threadId: string): Promise<Result<void>> =>
      asyncWrap(async () => {
        await http.aiChatDeleteThread(threadId)
      }),
    [IpcChannel.AiWorkspaceMemoriesList]: (
      workspaceId: string | null
    ): Promise<Result<WorkspaceAgentMemory[]>> =>
      asyncWrap(() => http.aiChatMemories(workspaceId)),
    [IpcChannel.AiWorkspaceMemoryUpdate]: (
      workspaceId: string | null,
      path: string,
      content: string
    ): Promise<Result<WorkspaceAgentMemory>> =>
      asyncWrap(() => http.aiChatUpdateMemory(workspaceId, path, { value: content })),
    [IpcChannel.AiWorkspaceMemoryDelete]: (
      workspaceId: string | null,
      path: string
    ): Promise<Result<void>> =>
      asyncWrap(async () => {
        await http.aiChatDeleteMemory(workspaceId, path)
      }),

    [IpcChannel.AiReportsList]: (workspaceId: string): Promise<Result<AiReport[]>> =>
      asyncWrap(() => http.aiReportsList(workspaceId)),
    [IpcChannel.AiReportsDelete]: (reportId: string): Promise<Result<void>> =>
      asyncWrap(async () => {
        await http.aiReportsDelete(reportId)
      }),
    [IpcChannel.AiReportsUpdate]: (
      reportId: string,
      patch: { title?: string; contentMd?: string }
    ): Promise<Result<AiReport>> => asyncWrap(() => http.aiReportsUpdate(reportId, patch))
  }
}

export type ServerAiHandlerMap = ReturnType<typeof createServerAiHandlers>
