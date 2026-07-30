import { api } from '../ipc'
import type { Dispatch, SetStateAction, MutableRefObject } from 'react'
import type {
  AgentInterrupt,
  AgentInterruptDecision,
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

export const MAX_INPUT_LENGTH = 32000

export interface UseChatStreamParams {
  activeWorkspaceId: string | null
  activeDocumentId: string | null
  activeProviderId: string
  activeThreadId: string | null
  requestModel: string
  deepThinking: boolean
  reasoningEffort?: AiReasoningEffort
  setActiveThreadId: (id: string) => void
  setChatStreaming: (streaming: boolean) => void
  fetchThreads: (options?: { selectLatestIfNone?: boolean }) => Promise<void>
}

export interface UseChatStreamReturn {
  messages: ChatMessage[]
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
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
  displayMessages: ChatMessage[]
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
  await api.settings.set(RECENT_MODELS_KEY, JSON.stringify(next))
}

export function localMessage(
  threadId: string,
  role: ChatMessage['role'],
  content: string
): ChatMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    role,
    content,
    createdAt: Date.now()
  }
}

export function mergeTraceStep(prev: AgentTraceStep[], step: AgentTraceStep): AgentTraceStep[] {
  const idx = prev.findIndex((s) => s.id === step.id)
  if (idx === -1) {
    return [...prev, step].sort((a, b) => a.seq - b.seq)
  }
  const next = prev.slice()
  next[idx] = step
  return next
}
