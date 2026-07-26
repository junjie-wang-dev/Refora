import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import type {
  AgentInterrupt,
  AgentInterruptDecision,
  AgentTraceStep,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatInterruptedEvent,
  ChatMessage,
  ChatReasoningEvent,
  ChatTokenEvent,
  ChatTraceEvent,
  ChatTitleUpdatedEvent
} from '../../shared/ipc-types'
import { useWorkspaceStore } from '../store/workspaceStore'
import {
  MAX_INPUT_LENGTH,
  pushRecentModel,
  localMessage,
  mergeTraceStep,
  type ChatSendContext,
  type ChatReplacementOptions,
  type UseChatStreamParams,
  type UseChatStreamReturn
} from '../utils/chatUtils'

interface ResumeRetryContext {
  interrupt: AgentInterrupt
  decision: AgentInterruptDecision
  editedActions?: Array<{ name: string; args: Record<string, unknown> }>
}

const MIN_LIVE_ACTIVITY_MS = 160
const LIVE_ACTIVITY_TOOL_NAMES = new Set(['write_file', 'edit_file', 'write_todos'])

function reviewedOcrDocumentId(context: ResumeRetryContext): string | null {
  if (context.decision === 'reject') return null
  const action = context.interrupt.actions.find((candidate) => candidate.name === 'prepare_paper_ocr')
  if (!action) return null
  const edited = context.decision === 'edit'
    ? context.editedActions?.find((candidate) => candidate.name === action.name)
    : null
  const docId = (edited?.args ?? action.args).docId
  return typeof docId === 'string' && docId.trim() ? docId.trim() : null
}

export function useChatStream({
  activeWorkspaceId,
  activeProviderId,
  activeThreadId,
  requestModel,
  deepThinking,
  reasoningEffort,
  setActiveThreadId,
  setChatStreaming,
  fetchThreads
}: UseChatStreamParams): UseChatStreamReturn {
  const { t } = useTranslation()

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [traceSteps, setTraceSteps] = useState<AgentTraceStep[]>([])
  const [streaming, setStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [canRetry, setCanRetry] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [pendingInterrupt, setPendingInterrupt] = useState<AgentInterrupt | null>(null)
  const [activeOcrDocumentId, setActiveOcrDocumentId] = useState<string | null>(null)

  const threadIdRef = useRef<string | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const streamingTextRef = useRef('')
  const streamingReasoningRef = useRef('')
  const streamingStepOutputRef = useRef(new Map<string, string>())
  const streamingStartTimeRef = useRef<number | null>(null)
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelledRef = useRef(false)
  const cancelledRunRef = useRef<string | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const isSendingRef = useRef(false)
  const retrySendRef = useRef<ChatSendContext | null>(null)
  const pendingInterruptRef = useRef<AgentInterrupt | null>(null)
  const resumeRetryRef = useRef<ResumeRetryContext | null>(null)
  const latestSendRef = useRef<ChatSendContext | null>(null)
  const hadMessagesRef = useRef(false)
  const stickToBottomRef = useRef(true)
  const disposedRef = useRef(false)
  const liveActivityStartedAtRef = useRef(new Map<string, number>())
  const deferredTraceTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  )

  const displayMessages = useMemo(() => messages.filter((m) => m.role !== 'tool'), [messages])

  useEffect(() => {
    threadIdRef.current = activeThreadId
    if (!isSendingRef.current) {
      for (const timer of deferredTraceTimersRef.current.values()) clearTimeout(timer)
      deferredTraceTimersRef.current.clear()
      liveActivityStartedAtRef.current.clear()
      retrySendRef.current = null
      latestSendRef.current = null
      cancelledRef.current = false
      cancelledRunRef.current = null
      setCanRetry(false)
      streamingTextRef.current = ''
      streamingReasoningRef.current = ''
      streamingStepOutputRef.current.clear()
      setStreamingText('')
      setStreamingReasoning('')
      setStreaming(false)
      activeRunIdRef.current = null
      setActiveRunId(null)
      setError(null)
      pendingInterruptRef.current = null
      setPendingInterrupt(null)
      resumeRetryRef.current = null
      setActiveOcrDocumentId(null)
    }
    stickToBottomRef.current = true
    if (!activeThreadId) {
      setMessages([])
      setTraceSteps([])
      hadMessagesRef.current = false
      setLoadingHistory(false)
      return
    }
    if (isSendingRef.current) {
      setLoadingHistory(false)
      return
    }
    let cancelled = false
    setLoadingHistory(true)
    void Promise.all([
      api.ai.chatHistory(activeThreadId),
      api.ai.chatTraces(activeThreadId)
    ])
      .then(([history, traces]) => {
        if (cancelled || threadIdRef.current !== activeThreadId) return
        setMessages(history)
        setTraceSteps(traces)
        hadMessagesRef.current = history.length > 0
        setLoadingHistory(false)
        const runSteps = traces
          .filter((step) => step.kind === 'run')
          .sort((left, right) => right.startedAt - left.startedAt || right.seq - left.seq)
        if (runSteps[0]) {
          void api.ai.chatPendingInterrupt(runSteps[0].runId).then((interrupt) => {
            if (!cancelled && threadIdRef.current === activeThreadId) {
              pendingInterruptRef.current = interrupt
              setPendingInterrupt(interrupt)
            }
          }).catch(() => undefined)
        }
      })
      .catch(() => {
        if (cancelled) return
        setMessages([])
        setTraceSteps([])
        setLoadingHistory(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeThreadId])

  const scheduleStreamingFlush = useCallback(() => {
    if (rafIdRef.current != null) return
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      setStreamingText(streamingTextRef.current)
      setStreamingReasoning(streamingReasoningRef.current)
      if (streamingStepOutputRef.current.size > 0) {
        setTraceSteps((prev) =>
          prev.map((step) => {
            const output = streamingStepOutputRef.current.get(step.id)
            return output === undefined ? step : { ...step, output }
          })
        )
      }
    })
  }, [])

  const mergeLiveTraceStep = useCallback((step: AgentTraceStep) => {
    const keepVisible = step.name !== null && LIVE_ACTIVITY_TOOL_NAMES.has(step.name)
    if (!keepVisible) {
      setTraceSteps((prev) => mergeTraceStep(prev, step))
      return
    }
    const existingTimer = deferredTraceTimersRef.current.get(step.id)
    if (existingTimer) {
      clearTimeout(existingTimer)
      deferredTraceTimersRef.current.delete(step.id)
    }
    if (step.status === 'running') {
      if (!liveActivityStartedAtRef.current.has(step.id)) {
        liveActivityStartedAtRef.current.set(step.id, Date.now())
      }
      setTraceSteps((prev) => mergeTraceStep(prev, step))
      return
    }
    const receivedAt = liveActivityStartedAtRef.current.get(step.id)
    const remaining = receivedAt === undefined
      ? 0
      : MIN_LIVE_ACTIVITY_MS - (Date.now() - receivedAt)
    if (remaining <= 0) {
      liveActivityStartedAtRef.current.delete(step.id)
      setTraceSteps((prev) => mergeTraceStep(prev, step))
      return
    }
    const timer = setTimeout(() => {
      deferredTraceTimersRef.current.delete(step.id)
      liveActivityStartedAtRef.current.delete(step.id)
      setTraceSteps((prev) => mergeTraceStep(prev, step))
    }, remaining)
    deferredTraceTimersRef.current.set(step.id, timer)
  }, [])

  const chatHandlersRef = useRef<{
    onToken: (payload: ChatTokenEvent) => void
    onReasoning: (payload: ChatReasoningEvent) => void
    onDone: (payload: ChatDoneEvent) => void
    onError: (payload: ChatErrorEvent) => void
    onTrace: (payload: ChatTraceEvent) => void
    onInterrupted: (payload: ChatInterruptedEvent) => void
    onTitleUpdated: (payload: ChatTitleUpdatedEvent) => void
  } | null>(null)

  if (!chatHandlersRef.current) {
    chatHandlersRef.current = {
      onToken: (payload: ChatTokenEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        streamingTextRef.current += payload.token
        if (payload.stepId) {
          const current = streamingStepOutputRef.current.get(payload.stepId) ?? ''
          const output = current + payload.token
          streamingStepOutputRef.current.set(payload.stepId, output)
          setTraceSteps((prev) =>
            prev.map((step) => step.id === payload.stepId ? { ...step, output } : step)
          )
        }
        scheduleStreamingFlush()
      },
      onReasoning: (payload: ChatReasoningEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        streamingReasoningRef.current += payload.token
        if (payload.stepId) {
          const current = streamingStepOutputRef.current.get(payload.stepId) ?? ''
          const output = current + payload.token
          streamingStepOutputRef.current.set(payload.stepId, output)
          setTraceSteps((prev) =>
            prev.map((step) => step.id === payload.stepId ? { ...step, output } : step)
          )
        }
        scheduleStreamingFlush()
      },
      onDone: (payload: ChatDoneEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        cancelledRef.current = false
        if (rafIdRef.current != null) {
          cancelAnimationFrame(rafIdRef.current)
          rafIdRef.current = null
        }
        isSendingRef.current = false
        activeRunIdRef.current = null
        setActiveRunId(null)
        retrySendRef.current = null
        cancelledRunRef.current = null
        setCanRetry(false)
        resumeRetryRef.current = null
        setMessages((prev) => [
          ...prev,
          localMessage(payload.threadId, 'assistant', payload.finalText)
        ])
        streamingTextRef.current = ''
        streamingReasoningRef.current = ''
        streamingStepOutputRef.current.clear()
        setStreamingText('')
        setStreamingReasoning('')
        setStreaming(false)
        pendingInterruptRef.current = null
        setPendingInterrupt(null)
        setActiveOcrDocumentId(null)
      },
      onError: (payload: ChatErrorEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        if (rafIdRef.current != null) {
          cancelAnimationFrame(rafIdRef.current)
          rafIdRef.current = null
        }
        isSendingRef.current = false
        const resumeRetry = resumeRetryRef.current
        const failedResume = resumeRetry?.interrupt.runId === payload.runId ? resumeRetry : null
        activeRunIdRef.current = failedResume?.interrupt.runId ?? null
        setActiveRunId(failedResume?.interrupt.runId ?? null)
        cancelledRef.current = false
        cancelledRunRef.current = null
        if (failedResume) {
          pendingInterruptRef.current = failedResume.interrupt
          setPendingInterrupt(failedResume.interrupt)
        } else if (retrySendRef.current) {
          retrySendRef.current = {
            ...retrySendRef.current,
            threadId: payload.threadId,
            runId: payload.runId ?? retrySendRef.current.runId,
            persisted: true
          }
        }
        setCanRetry(failedResume !== null || retrySendRef.current !== null)
        setError(payload.message)
        streamingTextRef.current = ''
        streamingReasoningRef.current = ''
        streamingStepOutputRef.current.clear()
        setStreamingText('')
        setStreamingReasoning('')
        setStreaming(false)
        setActiveOcrDocumentId(null)
      },
      onTrace: (payload: ChatTraceEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        if (payload.step.kind === 'reasoning' || payload.step.kind === 'message') {
          const current = streamingStepOutputRef.current.get(payload.step.id)
          if (payload.step.output != null || current === undefined) {
            streamingStepOutputRef.current.set(payload.step.id, payload.step.output ?? '')
          }
        }
        mergeLiveTraceStep(payload.step)
      },
      onInterrupted: (payload: ChatInterruptedEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        if (rafIdRef.current != null) {
          cancelAnimationFrame(rafIdRef.current)
          rafIdRef.current = null
        }
        isSendingRef.current = false
        resumeRetryRef.current = null
        pendingInterruptRef.current = payload.interrupt
        setPendingInterrupt(payload.interrupt)
        setCanRetry(false)
        setError(null)
        setActiveOcrDocumentId(null)
        setStreamingText(streamingTextRef.current)
        setStreamingReasoning(streamingReasoningRef.current)
        setStreaming(false)
      },
      onTitleUpdated: (payload: ChatTitleUpdatedEvent) => {
        useWorkspaceStore.setState((s) => ({
          threads: s.threads.map((t2) =>
            t2.id === payload.threadId ? { ...t2, title: payload.title } : t2
          )
        }))
      }
    }
  }

  useEffect(() => {
    const h = chatHandlersRef.current!
    api.events.onAiChatToken(h.onToken)
    api.events.onAiChatReasoning(h.onReasoning)
    api.events.onAiChatDone(h.onDone)
    api.events.onAiChatError(h.onError)
    api.events.onAiChatTrace(h.onTrace)
    api.events.onAiChatInterrupted(h.onInterrupted)
    api.events.onAiChatTitleUpdated(h.onTitleUpdated)
    return () => {
      api.events.off('ai:chat:token', h.onToken)
      api.events.off('ai:chat:reasoning', h.onReasoning)
      api.events.off('ai:chat:done', h.onDone)
      api.events.off('ai:chat:error', h.onError)
      api.events.off('ai:chat:trace', h.onTrace)
      api.events.off('ai:chat:interrupted', h.onInterrupted)
      api.events.off('ai:chat:titleUpdated', h.onTitleUpdated)
    }
  }, [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current)
      for (const timer of deferredTraceTimersRef.current.values()) clearTimeout(timer)
      deferredTraceTimersRef.current.clear()
      liveActivityStartedAtRef.current.clear()
      if (isSendingRef.current && activeRunIdRef.current) {
        void api.ai.chatCancel(activeRunIdRef.current).catch(() => undefined)
      }
      isSendingRef.current = false
      setChatStreaming(false)
    }
  }, [])

  useEffect(() => {
    setChatStreaming(streaming)
  }, [streaming, setChatStreaming])

  useEffect(() => {
    if (streaming) {
      streamingStartTimeRef.current = Date.now()
      setElapsedSeconds(0)
      elapsedTimerRef.current = setInterval(() => {
        if (streamingStartTimeRef.current != null) {
          setElapsedSeconds(Math.floor((Date.now() - streamingStartTimeRef.current) / 1000))
        }
      }, 1000)
    } else {
      if (elapsedTimerRef.current != null) {
        clearInterval(elapsedTimerRef.current)
        elapsedTimerRef.current = null
      }
      streamingStartTimeRef.current = null
    }
    return () => {
      if (elapsedTimerRef.current != null) {
        clearInterval(elapsedTimerRef.current)
        elapsedTimerRef.current = null
      }
    }
  }, [streaming])

  const cancelRun = useCallback((runId: string) => {
    if (cancelledRunRef.current === runId) return
    cancelledRunRef.current = runId
    void api.ai.chatCancel(runId).catch((e) => {
      cancelledRef.current = false
      cancelledRunRef.current = null
      setCanRetry(false)
      setError(errorMessage(e, 'Failed to stop response'))
    })
  }, [])

  const sendText = useCallback(async (
    text: string,
    attachments: string[],
    existingThread: string | null,
    replacement: ChatReplacementOptions = {}
  ) => {
    if (isSendingRef.current) return
    if (!activeProviderId || !text.trim() || streaming) return
    cancelledRef.current = false
    if (text.length > MAX_INPUT_LENGTH) {
      setError(t('workspace.chat.inputTooLong', 'Message is too long. Please shorten it.'))
      return
    }
    setMessages((prev) => [...prev, localMessage(existingThread ?? '', 'user', text)])
    setStreaming(true)
    isSendingRef.current = true
    const requestedRunId = globalThis.crypto?.randomUUID?.() ??
      `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    activeRunIdRef.current = requestedRunId
    setActiveRunId(requestedRunId)
    streamingTextRef.current = ''
    streamingReasoningRef.current = ''
    streamingStepOutputRef.current.clear()
    setStreamingText('')
    setStreamingReasoning('')
    setError(null)
    setCanRetry(false)
    pendingInterruptRef.current = null
    setPendingInterrupt(null)
    resumeRetryRef.current = null
    setActiveOcrDocumentId(null)
    hadMessagesRef.current = true
    stickToBottomRef.current = true
    const sendContext: ChatSendContext = {
      text,
      attachments: [...attachments],
      threadId: existingThread,
      runId: requestedRunId,
      persisted: false
    }
    retrySendRef.current = sendContext
    latestSendRef.current = sendContext
    cancelledRunRef.current = null
    try {
      const model = requestModel || undefined
      if (model) void pushRecentModel(model, activeProviderId)
      const { threadId, runId } = await api.ai.chatSend({
        workspaceId: activeWorkspaceId,
        threadId: existingThread ?? undefined,
        runId: requestedRunId,
        text,
        providerId: activeProviderId,
        model,
        replaceLastExchange: replacement.replaceLastExchange,
        replaceRunId: replacement.replaceRunId ?? undefined,
        features: {
          deepThinking,
          ...(reasoningEffort ? { reasoningEffort } : {})
        },
        attachments: attachments.length > 0
          ? attachments.map((docId) => ({ type: 'document' as const, docId }))
          : undefined
      })
      if (disposedRef.current) {
        void api.ai.chatCancel(runId).catch(() => undefined)
        return
      }
      if (activeRunIdRef.current === requestedRunId) {
        activeRunIdRef.current = runId
        setActiveRunId(runId)
      }
      const resolvedContext = { ...sendContext, threadId, runId, persisted: true }
      if (retrySendRef.current === sendContext) retrySendRef.current = resolvedContext
      if (latestSendRef.current === sendContext) latestSendRef.current = resolvedContext
      if (!existingThread) {
        setActiveThreadId(threadId)
        threadIdRef.current = threadId
      }
      if (cancelledRef.current) cancelRun(runId)
      void fetchThreads()
    } catch (e) {
      if (disposedRef.current) return
      cancelledRef.current = false
      cancelledRunRef.current = null
      activeRunIdRef.current = null
      setActiveRunId(null)
      setCanRetry(true)
      setError(errorMessage(e, 'Failed to send message'))
      isSendingRef.current = false
      setStreaming(false)
      setStreamingText('')
      setStreamingReasoning('')
      setActiveOcrDocumentId(null)
    }
  }, [
    activeWorkspaceId,
    activeProviderId,
    streaming,
    setActiveThreadId,
    requestModel,
    deepThinking,
    reasoningEffort,
    fetchThreads,
    cancelRun,
    t
  ])

  const resumeInterrupt = useCallback(async (context: ResumeRetryContext) => {
    if (isSendingRef.current) return
    resumeRetryRef.current = context
    isSendingRef.current = true
    pendingInterruptRef.current = null
    setPendingInterrupt(null)
    activeRunIdRef.current = context.interrupt.runId
    setActiveRunId(context.interrupt.runId)
    setActiveOcrDocumentId(reviewedOcrDocumentId(context))
    setStreaming(true)
    setCanRetry(false)
    setError(null)
    try {
      await api.ai.chatResume({
        threadId: context.interrupt.threadId,
        runId: context.interrupt.runId,
        decisions: context.interrupt.actions.map((action, index) => context.decision === 'edit'
          ? {
              type: 'edit' as const,
              editedAction: context.editedActions?.[index] ?? { name: action.name, args: action.args }
            }
          : { type: context.decision })
      })
    } catch (resumeError) {
      if (disposedRef.current) return
      isSendingRef.current = false
      pendingInterruptRef.current = context.interrupt
      setPendingInterrupt(context.interrupt)
      activeRunIdRef.current = context.interrupt.runId
      setActiveRunId(context.interrupt.runId)
      setActiveOcrDocumentId(null)
      setStreaming(false)
      setCanRetry(true)
      setError(errorMessage(resumeError, 'Failed to resume agent'))
    }
  }, [])

  const handleRetry = useCallback(() => {
    const resume = resumeRetryRef.current
    if (resume && pendingInterruptRef.current?.id === resume.interrupt.id) {
      void resumeInterrupt(resume)
      return
    }
    const last = retrySendRef.current
    if (!last) return
    setMessages((prev) => {
      const idx = prev.findLastIndex((m) => m.role === 'user' && m.content === last.text)
      if (idx === -1) return prev
      return prev.filter((_, i) => i !== idx)
    })
    if (last.runId) {
      setTraceSteps((prev) => prev.filter((step) => step.runId !== last.runId))
    }
    void sendText(last.text, last.attachments, last.threadId, {
      replaceLastExchange: last.persisted,
      replaceRunId: last.persisted ? last.runId : null
    })
  }, [resumeInterrupt, sendText])

  const clearError = useCallback(() => {
    retrySendRef.current = null
    resumeRetryRef.current = null
    setCanRetry(false)
    setError(null)
  }, [])

  const handleCancel = useCallback(() => {
    cancelledRef.current = true
    if (activeRunIdRef.current) cancelRun(activeRunIdRef.current)
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    setStreamingText(streamingTextRef.current)
    setStreamingReasoning(streamingReasoningRef.current)
  }, [cancelRun])

  const handleRegenerate = useCallback(() => {
    let text = ''
    let attachments: string[] = []
    let threadId = activeThreadId
    const latestSend = latestSendRef.current
    if (latestSend && latestSend.threadId === activeThreadId) {
      text = latestSend.text
      attachments = latestSend.attachments
      threadId = latestSend.threadId
    } else {
      for (let i = displayMessages.length - 1; i >= 0; i--) {
        if (displayMessages[i].role === 'user') {
          text = displayMessages[i].content
          break
        }
      }
    }
    if (!text.trim()) return
    const runSteps = traceSteps
      .filter((s) => s.kind === 'run')
      .slice()
      .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq)
    const lastRunId = runSteps.length > 0 ? runSteps[runSteps.length - 1].runId : null
    setMessages((prev) => {
      let lastUserIdx = -1
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx === -1) return prev
      return prev.slice(0, lastUserIdx)
    })
    if (lastRunId) {
      setTraceSteps((prev) => prev.filter((s) => s.runId !== lastRunId))
    }
    void sendText(text, attachments, threadId, {
      replaceLastExchange: true,
      replaceRunId: lastRunId
    })
  }, [displayMessages, activeThreadId, traceSteps, sendText])

  const resolveInterrupt = useCallback(async (
    decision: AgentInterruptDecision,
    editedActions?: Array<{ name: string; args: Record<string, unknown> }>
  ) => {
    const interrupt = pendingInterruptRef.current
    if (!interrupt) return
    await resumeInterrupt({ interrupt, decision, editedActions })
  }, [resumeInterrupt])

  return {
    messages, setMessages, traceSteps, setTraceSteps,
    streaming, streamingText, streamingReasoning, activeRunId, elapsedSeconds,
    error, setError, clearError, canRetry, loadingHistory, displayMessages, pendingInterrupt,
    activeOcrDocumentId,
    sendText, handleCancel, handleRetry, handleRegenerate,
    resolveInterrupt,
    stickToBottomRef, threadIdRef, hadMessagesRef
  }
}
