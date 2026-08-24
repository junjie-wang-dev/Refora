import { api } from '../ipc'
import { trackRendererPersistence } from '../persistence'
import type { Dispatch, SetStateAction, MutableRefObject } from 'react'
import type {
  AgentInterrupt,
  AgentInterruptDecision,
  AgentRunStatus,
  AgentTraceStep,
  AiReasoningEffort,
  ChatMessage
} from '../../shared/ipc-types'

const RECENT_MODELS_KEY = 'chatRecentModels'
const MAX_RECENT = 8

export type RecentModelEntry = { model: string; providerId: string }

export type ChatSendContext = {
  text: string
  attachments: string[]
  activeDocumentId: string | null
  threadId: string | null
  runId: string | null
  persisted: boolean
}

export type ChatReplacementOptions = {
  replaceLastExchange?: boolean
  replaceRunId?: string | null
  activeDocumentId?: string | null
}

export type ChatTerminalStatus = 'cancelled' | 'failed'

export type ChatTimelineMessage = ChatMessage & {
  terminalStatus?: ChatTerminalStatus
}

export const MAX_INPUT_LENGTH = 32000

export interface UseChatStreamParams {
  activeWorkspaceId: string | null
  activeDocumentId: string | null
  activeProviderId: string
  activeThreadId: string | null
  requestModel: string
  deepThinking: boolean
  reasoningEffort?: AiReasoningEffort
  setChatStreaming: (streaming: boolean) => void
  fetchThreads: (options?: { selectLatestIfNone?: boolean }) => Promise<void>
}

export interface UseChatStreamReturn {
  messages: ChatTimelineMessage[]
  setMessages: Dispatch<SetStateAction<ChatTimelineMessage[]>>
  traceSteps: AgentTraceStep[]
  setTraceSteps: Dispatch<SetStateAction<AgentTraceStep[]>>
  streaming: boolean
  streamingText: string
  streamingReasoning: string
  activeRunId: string | null
  elapsedSeconds: number
  error: string | null
  setError: Dispatch<SetStateAction<string | null>>
  clearError: () => void
  canRetry: boolean
  loadingHistory: boolean
  displayMessages: ChatTimelineMessage[]
  pendingInterrupt: AgentInterrupt | null
  activeOcrDocumentId: string | null
  sendText: (
    text: string,
    attachments: string[],
    existingThread: string | null,
    replacement?: ChatReplacementOptions
  ) => Promise<void>
  handleCancel: () => void
  handleRetry: () => void
  handleRegenerate: () => void
  resolveInterrupt: (
    decision: AgentInterruptDecision,
    editedActions?: Array<{ name: string; args: Record<string, unknown> }>
  ) => Promise<void>
  stickToBottomRef: MutableRefObject<boolean>
  threadIdRef: MutableRefObject<string | null>
  hadMessagesRef: MutableRefObject<boolean>
}

export async function loadRecentModels(): Promise<RecentModelEntry[]> {
  try {
    const raw = await api.settings.get<string>(RECENT_MODELS_KEY, '[]')
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is RecentModelEntry =>
        typeof x === 'object' && x !== null &&
        typeof (x as Record<string, unknown>).model === 'string' &&
        typeof (x as Record<string, unknown>).providerId === 'string'
      )
      .slice(0, MAX_RECENT)
  } catch {
    return []
  }
}

export async function pushRecentModel(model: string, providerId: string): Promise<void> {
  const id = model.trim()
  if (!id || !providerId) return
  const prev = await loadRecentModels()
  const next = [
    { model: id, providerId },
    ...prev.filter((m) => m.model !== id || m.providerId !== providerId)
  ].slice(0, MAX_RECENT)
  await trackRendererPersistence(api.settings.set(RECENT_MODELS_KEY, JSON.stringify(next)))
}

export function localMessage(
  threadId: string,
  role: ChatMessage['role'],
  content: string,
  metadata: Pick<ChatTimelineMessage, 'runId' | 'terminalStatus'> = {}
): ChatTimelineMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    role,
    content,
    createdAt: Date.now(),
    ...metadata
  }
}

export function enrichChatMessages(
  messages: ChatMessage[],
  traces: AgentTraceStep[]
): ChatTimelineMessage[] {
  const runGroups = new Map<string, AgentTraceStep[]>()
  for (const step of traces) {
    const group = runGroups.get(step.runId) ?? []
    group.push(step)
    runGroups.set(step.runId, group)
  }
  const runs = [...runGroups.entries()].map(([runId, steps]) => {
    const ordered = [...steps].sort(
      (left, right) => left.startedAt - right.startedAt || left.seq - right.seq
    )
    const runStep = ordered.filter((step) => step.kind === 'run').at(-1)
    const messageOutputs = ordered
      .filter((step) => step.kind === 'message' && step.output)
      .map((step) => step.output!)
    return {
      runId,
      threadId: ordered[0]?.threadId ?? '',
      status: runStep?.status,
      startedAt: ordered[0]?.startedAt ?? 0,
      endedAt: runStep?.endedAt ?? ordered.reduce(
        (latest, step) => Math.max(latest, step.endedAt ?? step.startedAt),
        0
      ),
      terminalOutput: runStep?.output ?? null,
      messageOutputs
    }
  })
  const assignedRuns = new Set<string>()
  const terminalStatusFor = (
    status: AgentTraceStep['status'] | AgentRunStatus | undefined
  ) => status === 'cancelled'
    ? 'cancelled' as const
    : status === 'error' || status === 'failed' || status === 'interrupted'
      ? 'failed' as const
      : undefined
  const enriched = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const existingRunId = (message as ChatTimelineMessage).runId
    if (existingRunId) {
      assignedRuns.add(existingRunId)
      const run = runs.find((candidate) => candidate.runId === existingRunId)
      if (!run && !(message as ChatTimelineMessage).runStatus) return message
      const {
        terminalStatus: existingTerminalStatus,
        ...rest
      } = message as ChatTimelineMessage
      let terminalStatus = existingTerminalStatus
      if (rest.runStatus && rest.runStatus !== 'queued' && rest.runStatus !== 'running') {
        terminalStatus = terminalStatusFor(rest.runStatus)
      } else if (run?.status && run.status !== 'running') {
        terminalStatus = terminalStatusFor(run.status)
      }
      return {
        ...rest,
        ...(terminalStatus ? { terminalStatus } : {})
      }
    }
    const exact = runs
      .filter((run) =>
        !assignedRuns.has(run.runId) &&
        run.startedAt <= message.createdAt &&
        (run.messageOutputs.includes(message.content) || run.terminalOutput === message.content)
      )
      .sort((left, right) => right.endedAt - left.endedAt)[0]
    const nearest = exact ?? runs
      .filter((run) =>
        !assignedRuns.has(run.runId) &&
        run.startedAt <= message.createdAt &&
        run.messageOutputs.length > 0
      )
      .sort((left, right) => right.endedAt - left.endedAt)[0]
    if (!nearest) return message
    assignedRuns.add(nearest.runId)
    const terminalStatus: ChatTerminalStatus | undefined = terminalStatusFor(nearest.status)
    return {
      ...message,
      runId: nearest.runId,
      ...(terminalStatus ? { terminalStatus } : {})
    }
  })
  const cancelledPlaceholders: ChatTimelineMessage[] = runs
    .filter((run) => run.status === 'cancelled' && !assignedRuns.has(run.runId))
    .map((run) => ({
      id: `terminal-${run.runId}`,
      threadId: run.threadId,
      role: 'assistant',
      content: '',
      createdAt: run.endedAt || run.startedAt,
      runId: run.runId,
      terminalStatus: 'cancelled'
    }))
  if (cancelledPlaceholders.length === 0) return enriched
  return [...enriched, ...cancelledPlaceholders].sort(
    (left, right) => left.createdAt - right.createdAt
  )
}

export function mergeTraceStep(prev: AgentTraceStep[], step: AgentTraceStep): AgentTraceStep[] {
  const idx = prev.findIndex((s) => s.id === step.id)
  if (idx === -1) {
    return [...prev, step].sort(
      (a, b) => a.startedAt - b.startedAt || a.seq - b.seq
    )
  }
  const next = prev.slice()
  next[idx] = step
  return next
}
