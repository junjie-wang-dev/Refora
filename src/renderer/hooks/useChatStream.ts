import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import type {
  AgentInterrupt,
  AgentInterruptDecision,
  AgentRunStatus,
  AgentTraceStep,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatInterruptedEvent,
  ChatMessage,
  ChatReasoningEvent,
  ChatRunStatusEvent,
  ChatTokenEvent,
  ChatTraceEvent,
  ChatTitleUpdatedEvent
} from '../../shared/ipc-types'
import { useWorkspaceStore } from '../store/workspaceStore'
import {
  MAX_INPUT_LENGTH,
  enrichChatMessages,
  pushRecentModel,
  localMessage,
  mergeTraceStep,
  type ChatTimelineMessage,
  type ChatSendContext,
  type ChatReplacementOptions,
  type UseChatStreamParams,
  type UseChatStreamReturn
} from '../utils/chatUtils'
import {
  latestRunStep,
  reconcileStreamValue,
  recoveredStreamContent,
  replaceRunTraceSnapshot,
  reviewedOcrDocumentId,
  traceRunStatus,
  type ResumeRetryContext
} from '../utils/chatReconciliation'

const MIN_LIVE_ACTIVITY_MS = 160
const RUN_RECOVERY_POLL_MS = 5000
const LIVE_ACTIVITY_TOOL_NAMES = new Set(['write_file', 'edit_file', 'write_todos'])


export function useChatStream({
  activeWorkspaceId,
  activeDocumentId,
  activeProviderId,
  activeThreadId,
  requestModel,
  deepThinking,
  reasoningEffort,
  setChatStreaming,
  fetchThreads
}: UseChatStreamParams): UseChatStreamReturn {
  const { t } = useTranslation()

  const [messages, setMessages] = useState<ChatTimelineMessage[]>([])
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
  const traceSnapshotGenerationRef = useRef(0)
  const historyRequestGenerationRef = useRef(0)
  const reconcileGenerationRef = useRef(0)
  const liveActivityStartedAtRef = useRef(new Map<string, number>())
  const deferredTraceTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  )
  const reconcileRunSnapshotRef = useRef<((
    runId: string,
    threadId: string,
    hintedStatus?: AgentRunStatus
  ) => Promise<void>) | undefined>(undefined)
  const tRef = useRef(t)
  const fetchThreadsRef = useRef(fetchThreads)
  tRef.current = t
  fetchThreadsRef.current = fetchThreads

  const resetRunState = useCallback((resetElapsed = false) => {
    traceSnapshotGenerationRef.current += 1
    reconcileGenerationRef.current += 1
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    for (const timer of deferredTraceTimersRef.current.values()) clearTimeout(timer)
    deferredTraceTimersRef.current.clear()
    liveActivityStartedAtRef.current.clear()
    retrySendRef.current = null
    latestSendRef.current = null
    cancelledRef.current = false
    cancelledRunRef.current = null
    isSendingRef.current = false
    activeRunIdRef.current = null
    streamingTextRef.current = ''
    streamingReasoningRef.current = ''
    streamingStepOutputRef.current.clear()
    streamingStartTimeRef.current = null
    if (elapsedTimerRef.current != null) {
      clearInterval(elapsedTimerRef.current)
      elapsedTimerRef.current = null
    }
    pendingInterruptRef.current = null
    resumeRetryRef.current = null
    setCanRetry(false)
    setStreamingText('')
    setStreamingReasoning('')
    setStreaming(false)
    setActiveRunId(null)
    setError(null)
    setPendingInterrupt(null)
    setActiveOcrDocumentId(null)
    if (resetElapsed) setElapsedSeconds(0)
  }, [])

  const displayMessages = useMemo(() => messages.filter((m) => m.role !== 'tool'), [messages])

  useEffect(() => {
    threadIdRef.current = activeThreadId
    if (!isSendingRef.current) {
      resetRunState()
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
    const historyRequestGeneration = ++historyRequestGenerationRef.current
    setLoadingHistory(true)
    void Promise.allSettled([
      api.ai.chatHistory(activeThreadId),
      api.ai.chatTraces(activeThreadId)
    ])
      .then(([historyResult, tracesResult]) => {
        if (
          cancelled ||
          threadIdRef.current !== activeThreadId ||
          historyRequestGenerationRef.current !== historyRequestGeneration ||
          isSendingRef.current
        ) return
        const history = historyResult.status === 'fulfilled' ? historyResult.value : []
        const traces = tracesResult.status === 'fulfilled' ? tracesResult.value : []
        setMessages(enrichChatMessages(history, traces))
        setTraceSteps(traces)
        hadMessagesRef.current = history.length > 0
        setLoadingHistory(false)
        if (historyResult.status === 'rejected') {
          setError(errorMessage(
            historyResult.reason,
            tRef.current('workspace.chat.historyLoadFailed', 'Failed to load chat history')
          ))
        } else if (tracesResult.status === 'rejected') {
          setError(errorMessage(
            tracesResult.reason,
            tRef.current('workspace.chat.traceLoadFailed', 'Failed to load agent activity')
          ))
        } else {
          setError(null)
        }
        const runStep = latestRunStep(traces)
        const status = traceRunStatus(runStep)
        if (runStep && (status === 'running' || status === 'interrupted')) {
          activeRunIdRef.current = runStep.runId
          setActiveRunId(runStep.runId)
          isSendingRef.current = status === 'running'
          setStreaming(status === 'running')
          void reconcileRunSnapshotRef.current?.(runStep.runId, activeThreadId, status ?? undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeThreadId, resetRunState])

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

  const settleRun = useCallback((
    runId: string,
    options: {
      status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>
      threadId: string
      finalText?: string
      partialText?: string
      error?: string | null
      history?: ChatMessage[]
      traces?: AgentTraceStep[]
    }
  ) => {
    if (activeRunIdRef.current !== runId) return
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    const partial = (options.partialText ?? streamingTextRef.current).trimEnd()
    const completedText = options.status === 'completed'
      ? options.finalText?.trim() || partial
      : partial
    const terminalStatus = options.status === 'cancelled'
      ? 'cancelled' as const
      : options.status === 'failed'
        ? 'failed' as const
        : undefined

    if (options.traces) {
      traceSnapshotGenerationRef.current += 1
      setTraceSteps(options.traces)
    } else {
      const traceSnapshotGeneration = ++traceSnapshotGenerationRef.current
      void api.ai.chatTraces(options.threadId).then((snapshot) => {
        if (
          disposedRef.current ||
          threadIdRef.current !== options.threadId ||
          traceSnapshotGenerationRef.current !== traceSnapshotGeneration
        ) return
        setTraceSteps((current) => replaceRunTraceSnapshot(current, snapshot, runId))
        setMessages((current) => enrichChatMessages(current, snapshot))
      }).catch(() => undefined)
    }
    setMessages((previous) => {
      const base = options.history
        ? enrichChatMessages(options.history, options.traces ?? [])
        : previous
      const existingRunMessage = base.find(
        (message) => message.role === 'assistant' && message.runId === runId
      )
      if (existingRunMessage && terminalStatus) {
        return base.map((message) => message.id === existingRunMessage.id
          ? { ...message, content: completedText, terminalStatus }
          : message)
      }
      if (!completedText && !terminalStatus) return base
      return [
        ...base,
        localMessage(options.threadId, 'assistant', completedText, {
          runId,
          ...(terminalStatus ? { terminalStatus } : {})
        })
      ]
    })
    isSendingRef.current = false
    activeRunIdRef.current = null
    setActiveRunId(null)
    cancelledRef.current = false
    cancelledRunRef.current = null
    resumeRetryRef.current = null
    pendingInterruptRef.current = null
    setPendingInterrupt(null)
    setCanRetry(options.status === 'failed' && retrySendRef.current !== null)
    if (options.status !== 'failed') retrySendRef.current = null
    setError(options.status === 'failed' ? options.error || tRef.current(
      'workspace.chat.runFailed',
      'The agent run failed.'
    ) : null)
    streamingTextRef.current = ''
    streamingReasoningRef.current = ''
    streamingStepOutputRef.current.clear()
    setStreamingText('')
    setStreamingReasoning('')
    setStreaming(false)
    setActiveOcrDocumentId(null)
    void fetchThreadsRef.current()
  }, [])

  const reconcileRunSnapshot = useCallback(async (
    runId: string,
    threadId: string,
    hintedStatus?: AgentRunStatus
  ) => {
    const generation = ++reconcileGenerationRef.current
    const isCurrent = () =>
      generation === reconcileGenerationRef.current &&
      activeRunIdRef.current === runId &&
      threadIdRef.current === threadId
    try {
      const [run, traces] = await Promise.all([
        api.ai.chatRun(runId),
        api.ai.chatTraces(threadId)
      ])
      if (!isCurrent()) return
      setTraceSteps(traces)
      for (const step of traces) {
        if (
          step.runId === runId &&
          (step.kind === 'reasoning' || step.kind === 'message')
        ) {
          streamingStepOutputRef.current.set(step.id, step.output ?? '')
        }
      }
      streamingTextRef.current = reconcileStreamValue(
        streamingTextRef.current,
        recoveredStreamContent(traces, runId, 'message')
      )
      streamingReasoningRef.current = reconcileStreamValue(
        streamingReasoningRef.current,
        recoveredStreamContent(traces, runId, 'reasoning')
      )
      setStreamingText(streamingTextRef.current)
      setStreamingReasoning(streamingReasoningRef.current)
      if (run.status === 'queued' || run.status === 'running') {
        isSendingRef.current = true
        setStreaming(true)
        return
      }
      const history = await api.ai.chatHistory(threadId)
      if (!isCurrent()) return
      if (run.status === 'interrupted') {
        const interrupt = await api.ai.chatPendingInterrupt(runId)
        if (!isCurrent()) return
        setMessages(enrichChatMessages(history, traces))
        isSendingRef.current = false
        pendingInterruptRef.current = interrupt
        setPendingInterrupt(interrupt)
        setStreamingText(streamingTextRef.current)
        setStreamingReasoning(streamingReasoningRef.current)
        setStreaming(false)
        setCanRetry(false)
        setError(run.error)
        setActiveOcrDocumentId(null)
        return
      }
      settleRun(runId, {
        status: run.status,
        threadId,
        finalText: history.filter((message) => message.role === 'assistant').at(-1)?.content,
        error: run.error,
        history,
        traces
      })
    } catch (cause) {
      if (!isCurrent()) return
      if (hintedStatus === 'failed' || hintedStatus === 'cancelled') {
        settleRun(runId, {
          status: hintedStatus,
          threadId,
          error: hintedStatus === 'failed'
            ? errorMessage(cause, tRef.current('workspace.chat.runFailed', 'The agent run failed.'))
            : null
        })
      }
    }
  }, [settleRun])
  reconcileRunSnapshotRef.current = reconcileRunSnapshot

  const chatHandlersRef = useRef<{
    onToken: (payload: ChatTokenEvent) => void
    onReasoning: (payload: ChatReasoningEvent) => void
    onDone: (payload: ChatDoneEvent) => void
    onError: (payload: ChatErrorEvent) => void
    onTrace: (payload: ChatTraceEvent) => void
    onInterrupted: (payload: ChatInterruptedEvent) => void
    onRunStatus: (payload: ChatRunStatusEvent) => void
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
        }
        scheduleStreamingFlush()
      },
      onDone: (payload: ChatDoneEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        const status = cancelledRef.current
          ? 'cancelled'
          : 'completed'
        settleRun(payload.runId, {
          status,
          threadId: payload.threadId,
          finalText: payload.finalText
        })
      },
      onError: (payload: ChatErrorEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        const resumeRetry = resumeRetryRef.current
        const failedResume = resumeRetry?.interrupt.runId === payload.runId ? resumeRetry : null
        if (failedResume) {
          if (rafIdRef.current != null) {
            cancelAnimationFrame(rafIdRef.current)
            rafIdRef.current = null
          }
          isSendingRef.current = false
          pendingInterruptRef.current = failedResume.interrupt
          setPendingInterrupt(failedResume.interrupt)
          cancelledRef.current = false
          cancelledRunRef.current = null
          setCanRetry(true)
          setError(payload.message)
          setStreamingText(streamingTextRef.current)
          setStreamingReasoning(streamingReasoningRef.current)
          setStreaming(false)
          setActiveOcrDocumentId(null)
          return
        }
        if (retrySendRef.current) {
          retrySendRef.current = {
            ...retrySendRef.current,
            threadId: payload.threadId,
            runId: payload.runId ?? retrySendRef.current.runId,
            persisted: true
          }
        }
        settleRun(payload.runId, {
          status: 'failed',
          threadId: payload.threadId,
          partialText: payload.partialText,
          error: payload.message
        })
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
      onRunStatus: (payload: ChatRunStatusEvent) => {
        if (payload.runId !== activeRunIdRef.current) return
        if (threadIdRef.current && payload.threadId !== threadIdRef.current) return
        if (payload.status === 'queued' || payload.status === 'running') {
          isSendingRef.current = true
          setStreaming(true)
          return
        }
        void reconcileRunSnapshot(payload.runId, payload.threadId, payload.status)
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
    const disposers = [
      api.events.onAiChatToken(h.onToken),
      api.events.onAiChatReasoning(h.onReasoning),
      api.events.onAiChatDone(h.onDone),
      api.events.onAiChatError(h.onError),
      api.events.onAiChatTrace(h.onTrace),
      api.events.onAiChatInterrupted(h.onInterrupted),
      api.events.onAiChatRunStatus(h.onRunStatus),
      api.events.onAiChatTitleUpdated(h.onTitleUpdated)
    ]
    return () => disposers.forEach((dispose) => dispose())
  }, [])

  useEffect(() => {
    const resetForLibrarySwitch = () => {
      historyRequestGenerationRef.current += 1
      resetRunState(true)
      threadIdRef.current = null
      hadMessagesRef.current = false
      stickToBottomRef.current = true
      setMessages([])
      setTraceSteps([])
      setLoadingHistory(false)
      setChatStreaming(false)
    }
    return api.events.onLibrarySwitched(resetForLibrarySwitch)
  }, [resetRunState, setChatStreaming])

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
    if (!streaming || !activeRunId || !activeThreadId) return
    let reconciling = false
    const reconcile = async () => {
      if (reconciling) return
      reconciling = true
      try {
        await reconcileRunSnapshot(activeRunId, activeThreadId)
      } finally {
        reconciling = false
      }
    }
    const timer = setInterval(() => void reconcile(), RUN_RECOVERY_POLL_MS)
    return () => clearInterval(timer)
  }, [streaming, activeRunId, activeThreadId, reconcileRunSnapshot])

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
    void api.ai.chatCancel(runId).then((result) => {
      if (result.terminated || cancelledRunRef.current !== runId) return
      cancelledRef.current = false
      cancelledRunRef.current = null
      setCanRetry(false)
      setError(tRef.current('workspace.chat.stopFailed', 'Failed to stop response'))
    }).catch((e) => {
      cancelledRef.current = false
      cancelledRunRef.current = null
      setCanRetry(false)
      setError(errorMessage(e, tRef.current('workspace.chat.stopFailed', 'Failed to stop response')))
    })
  }, [])

  const sendText = useCallback(async (
    text: string,
    attachments: string[],
    existingThread: string | null,
    replacement: ChatReplacementOptions = {}
  ) => {
    if (isSendingRef.current) return
    if (pendingInterruptRef.current || !activeProviderId || !text.trim() || streaming) return
    cancelledRef.current = false
    if (text.length > MAX_INPUT_LENGTH) {
      setError(t('workspace.chat.inputTooLong', 'Message is too long. Please shorten it.'))
      return
    }
    traceSnapshotGenerationRef.current += 1
    historyRequestGenerationRef.current += 1
    setLoadingHistory(false)
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
    const contextDocumentId = Object.hasOwn(replacement, 'activeDocumentId')
      ? replacement.activeDocumentId ?? null
      : activeDocumentId
    const sendContext: ChatSendContext = {
      text,
      attachments: [...attachments],
      activeDocumentId: contextDocumentId,
      threadId: existingThread,
      runId: requestedRunId,
      persisted: false
    }
    retrySendRef.current = sendContext
    latestSendRef.current = sendContext
    cancelledRunRef.current = null
    try {
      const model = requestModel || undefined
      if (model) {
        void pushRecentModel(model, activeProviderId).catch(() => {
          setError(t('common.settingsSaveFailed'))
        })
      }
      const { threadId, runId } = await api.ai.chatSend({
        workspaceId: activeWorkspaceId,
        ...(contextDocumentId ? { activeDocumentId: contextDocumentId } : {}),
        threadId: existingThread ?? undefined,
        runId: requestedRunId,
        text,
        providerId: activeProviderId,
        agentProfileId: activeProviderId,
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
        useWorkspaceStore.getState().adoptStreamingThread(threadId)
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
      setError(errorMessage(e, t('workspace.chat.sendFailed', 'Failed to send message')))
      isSendingRef.current = false
      setStreaming(false)
      setStreamingText('')
      setStreamingReasoning('')
      setActiveOcrDocumentId(null)
    }
  }, [
    activeWorkspaceId,
    activeDocumentId,
    activeProviderId,
    streaming,
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
      setError(errorMessage(resumeError, tRef.current('workspace.chat.resumeFailed', 'Failed to resume agent')))
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
      replaceRunId: last.persisted ? last.runId : null,
      activeDocumentId: last.activeDocumentId
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
    let contextDocumentId: string | null | undefined
    let threadId = activeThreadId
    const latestSend = latestSendRef.current
    if (latestSend && latestSend.threadId === activeThreadId) {
      text = latestSend.text
      attachments = latestSend.attachments
      contextDocumentId = latestSend.activeDocumentId
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
      replaceRunId: lastRunId,
      ...(contextDocumentId !== undefined
        ? { activeDocumentId: contextDocumentId }
        : {})
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
