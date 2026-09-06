import { randomUUID } from 'node:crypto'
import { IpcChannel } from '../../../shared/ipc-channels'
import type {
  AgentInterrupt,
  AgentResumeRequest,
  AgentRun,
  AgentTraceStep,
  AiReport,
  AiSummary,
  AiUsageStats,
  ChatCancelResult,
  ChatMessage,
  ChatHistoryPage,
  ChatHistoryPageRequest,
  ChatRunSnapshot,
  ChatMediaRequest,
  ChatMediaResource,
  ChatSendRequest,
  ChatThread,
  Result,
  WorkspaceAgentMemory
} from '../../../shared/ipc-types'
import type {
  ServerClient,
} from '../client'
import {
  expectAgentInterrupt,
  expectAgentTraces,
  expectChatResumePayload
} from './guards'
import { resultify as asyncWrap } from './result'

export interface ServerAiHandlerDeps {
  serverClient: ServerClient
  mediaActions?: {
    open: (id: string) => Promise<void>
    reveal: (id: string) => Promise<void>
    save: (id: string) => Promise<boolean>
    copy: (id: string) => Promise<void>
  }
}

export function createServerAiHandlers(deps: ServerAiHandlerDeps) {
  const { http } = deps.serverClient

  async function mediaAction<T>(name: 'open' | 'reveal' | 'save' | 'copy', id: string): Promise<T> {
    if (!deps.mediaActions) throw new Error('Media actions are unavailable')
    return await deps.mediaActions[name](id) as T
  }

  return {
    [IpcChannel.AiMediaResolve]: (request: ChatMediaRequest): Promise<Result<ChatMediaResource>> =>
      asyncWrap(() => http.aiMediaResolve(request)),
    [IpcChannel.AiMediaTextPreview]: (id: string): Promise<Result<{ content: string; truncated: boolean }>> =>
      asyncWrap(() => http.aiMediaTextPreview(id)),
    [IpcChannel.AiMediaOpen]: (id: string): Promise<Result<void>> => asyncWrap(() => mediaAction('open', id)),
    [IpcChannel.AiMediaReveal]: (id: string): Promise<Result<void>> => asyncWrap(() => mediaAction('reveal', id)),
    [IpcChannel.AiMediaSave]: (id: string): Promise<Result<boolean>> => asyncWrap(() => mediaAction('save', id)),
    [IpcChannel.AiMediaCopy]: (id: string): Promise<Result<void>> => asyncWrap(() => mediaAction('copy', id)),
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
        await http.aiChatResume(expectChatResumePayload(request))
      }),
    [IpcChannel.AiChatCancel]: (runId: string): Promise<Result<ChatCancelResult>> =>
      asyncWrap(() => http.aiChatCancel({ runId })),
    [IpcChannel.AiChatHistory]: (threadId: string): Promise<Result<ChatMessage[]>> =>
      asyncWrap(() => http.aiChatHistory(threadId)),
    [IpcChannel.AiChatHistoryPage]: (
      threadId: string,
      options?: ChatHistoryPageRequest
    ): Promise<Result<ChatHistoryPage>> =>
      asyncWrap(async () => {
        const page = await http.aiChatHistoryPage(threadId, options)
        return { ...page, traces: expectAgentTraces(page.traces) }
      }),
    [IpcChannel.AiChatRunSnapshot]: (
      runId: string,
      afterRevision?: number
    ): Promise<Result<ChatRunSnapshot>> =>
      asyncWrap(async () => {
        const snapshot = await http.aiChatRunSnapshot(runId, afterRevision)
        return { ...snapshot, traces: expectAgentTraces(snapshot.traces) }
      }),
    [IpcChannel.AiChatThreads]: (workspaceId: string | null): Promise<Result<ChatThread[]>> =>
      asyncWrap(() => http.aiChatThreads(workspaceId === null ? {} : { workspaceId })),
    [IpcChannel.AiUsageStats]: (): Promise<Result<AiUsageStats>> =>
      asyncWrap(() => http.aiUsageStats()),
    [IpcChannel.AiChatTraces]: (threadId: string): Promise<Result<AgentTraceStep[]>> =>
      asyncWrap(async () => expectAgentTraces(await http.aiChatTraces(threadId))),
    [IpcChannel.AiChatRun]: (runId: string): Promise<Result<AgentRun>> =>
      asyncWrap(() => http.aiChatRun(runId)),
    [IpcChannel.AiChatPendingInterrupt]: (runId: string): Promise<Result<AgentInterrupt | null>> =>
      asyncWrap(async () => expectAgentInterrupt(await http.aiChatPendingInterrupt(runId))),
    [IpcChannel.AiChatRenameThread]: (
      threadId: string,
      title: string
    ): Promise<Result<void>> =>
      asyncWrap(async () => {
        await http.aiChatRenameThread(threadId, { title })
      }),
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
