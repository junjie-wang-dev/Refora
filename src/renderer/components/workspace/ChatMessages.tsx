import {
  useState,
  useEffect,
  useMemo,
  memo,
  useCallback,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import {
  Check,
  Copy,
  ArrowCounterClockwise,
  ArrowDown,
  CaretDown
} from '@phosphor-icons/react'
import ReactMarkdown from 'react-markdown'
import {
  REMARK_PLUGINS,
  REHYPE_PLUGINS,
  createReforaDocMarkdownComponents,
  urlTransform
} from '../../utils/markdown'
import { useDocumentStore } from '../../store/documentStore'
import { useSettingsModalStore } from '../../store/settingsModalStore'
import { Button as UiButton } from '../ui'
import { AgentTraceStepItem } from './AgentTrace'
import AgentTodoList from './AgentTodoList'
import type { AgentTraceStep, AiProvider } from '../../../shared/ipc-types'
import { openDocumentPdf } from '../../utils/openPdf'
import i18n from '../../i18n'
import {
  enrichChatMessages,
  type ChatTerminalStatus,
  type ChatTimelineMessage
} from '../../utils/chatUtils'

const MARKDOWN_COMPONENTS = createReforaDocMarkdownComponents(
  (docId) => openDocumentPdf(docId),
  () => useDocumentStore.getState().showToast(
    i18n.t('workspace.openDocFailed') as string
  )
)

const StreamingMarkdown = memo(function StreamingMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={urlTransform}>{content}</ReactMarkdown>
  )
})

function CopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copyLabel = copied
    ? t('workspace.chat.copied', 'Copied')
    : t('workspace.chat.copy', 'Copy')
  return (
    <button
      type="button"
      className={`chat-message-action ${
        className ?? 'text-muted opacity-60'
      }`}
      title={copyLabel}
      aria-label={copyLabel}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

function ReasoningPanel({
  content,
  streaming = false
}: {
  content: string
  streaming?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(streaming)
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])
  const toggleLabel = open
    ? t('workspace.chat.reasoningCollapse', 'Hide reasoning')
    : t('workspace.chat.reasoningExpand', 'Show reasoning')

  return (
    <section className="chat-reasoning-panel" data-timeline-kind="reasoning">
      <button
        type="button"
        className="chat-reasoning-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={toggleLabel}
        title={toggleLabel}
      >
        <span className="chat-reasoning-label min-w-0 truncate text-left">
          {t('workspace.chat.deepThinking', 'Deep Thinking')}
        </span>
        <CaretDown
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open && (
        <div className="chat-reasoning-content chat-markdown-muted">
          <StreamingMarkdown content={content} />
        </div>
      )}
    </section>
  )
}

function AnswerSegment({
  content,
  streaming = false,
  terminalStatus
}: {
  content: string
  streaming?: boolean
  terminalStatus?: ChatTerminalStatus
}) {
  const { t } = useTranslation()

  return (
    <section className="chat-timeline-answer" data-timeline-kind="message">
      <div
        className={`chat-assistant-content ${streaming ? 'chat-streaming-content ' : ''}chat-markdown`}
        aria-label={streaming ? t('workspace.chat.streamingResponse', 'AI response') : undefined}
      >
        {content && <StreamingMarkdown content={content} />}
        {terminalStatus === 'cancelled' && (
          <span className="block italic text-muted">
            {t('workspace.chat.responseCancelled', 'Response cancelled by user')}
          </span>
        )}
        {terminalStatus === 'failed' && (
          <span className="block italic text-muted">
            {t('workspace.chat.runFailed', 'The agent run failed.')}
          </span>
        )}
      </div>
    </section>
  )
}

function RunTimeline({
  steps,
  fallbackAnswer,
  fallbackReasoning,
  terminalStatus,
  streaming,
  elapsedSeconds
}: {
  steps: AgentTraceStep[]
  fallbackAnswer: string
  fallbackReasoning: string
  terminalStatus?: ChatTerminalStatus
  streaming: boolean
  elapsedSeconds: number
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(streaming)
  useEffect(() => {
    setOpen(streaming)
  }, [streaming])
  const lastStepStatus = steps.length > 0 ? steps[steps.length - 1].status : null
  const ordered = useMemo(
    () => [...steps]
      .filter((step) => step.kind !== 'run' && step.kind !== 'todo')
      .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq),
    [steps, steps.length, lastStepStatus]
  )
  const hasReasoningStep = ordered.some((step) => step.kind === 'reasoning')
  const messageSteps = ordered.filter((step) => step.kind === 'message')
  const messageOutputs = messageSteps.map((step) => step.output ?? '')
  const tracedAnswer = [
    messageOutputs.join('\n\n'),
    messageOutputs.join(''),
    messageOutputs.at(-1) ?? ''
  ]
    .filter((candidate, index, candidates) => candidate && candidates.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => fallbackAnswer.startsWith(candidate)) ?? null
  const lastMessageStep = messageSteps.at(-1)
  const finalMessageStep = tracedAnswer !== null && (
    !streaming || ordered.at(-1)?.id === lastMessageStep?.id
  )
    ? lastMessageStep
    : undefined
  const timelineSteps = ordered.filter(
    (step) => step.kind !== 'llm' && step.id !== finalMessageStep?.id
  )
  const answerRemainder = messageSteps.length === 0
    ? fallbackAnswer
    : tracedAnswer !== null
      ? fallbackAnswer.slice(tracedAnswer.length)
      : fallbackAnswer
  const finalAnswer = finalMessageStep
    ? `${finalMessageStep.output ?? ''}${answerRemainder}`
    : answerRemainder
  const hasCollapsibleContent = timelineSteps.some((step) => {
    if (step.kind === 'reasoning') return !!step.output || step.status === 'running'
    if (step.kind === 'message') return !!step.output
    return true
  }) || (!hasReasoningStep && !!fallbackReasoning)
  const runSteps = useMemo(
    () => steps
      .filter((step) => step.kind === 'run')
      .sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq),
    [steps, steps.length, lastStepStatus]
  )
  const firstRunStep = runSteps[0]
  const lastRunStep = runSteps.at(-1)
  const completedSteps = steps.filter((step) => step.endedAt != null)
  const startedAt = firstRunStep?.startedAt ?? (steps.length > 0 ? Math.min(...steps.map((step) => step.startedAt)) : null)
  const endedAt = lastRunStep?.endedAt ?? (completedSteps.length > 0 ? Math.max(...completedSteps.map((step) => step.endedAt!)) : null)
  const duration = streaming
    ? formatElapsed(elapsedSeconds)
    : startedAt != null && endedAt != null
      ? formatRunDuration(endedAt - startedAt)
      : null
  const hasError = terminalStatus === 'failed' || steps.some((step) => step.status === 'error')
  const runLabel = streaming
    ? t('workspace.chat.traceRunningLabel', 'running…')
    : hasError
      ? t('workspace.chat.traceCompletedError', 'Completed with an error')
      : terminalStatus === 'cancelled'
        ? t('workspace.chat.traceCancelledLabel', 'Cancelled')
        : t('workspace.chat.traceLlmDone', 'Completed')
  const toggleLabel = open
    ? t('workspace.chat.traceCollapse', 'Hide details')
    : t('workspace.chat.traceExpand', 'Show details')

  return (
    <>
      <div className="chat-run-timeline">
        <button
          type="button"
          className="chat-run-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <span className="chat-run-label">{runLabel}</span>
          {duration && <span className="chat-run-duration">{duration}</span>}
          <CaretDown
            className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? '' : '-rotate-90'}`}
          />
        </button>
        {open && (
          <div className="chat-agent-timeline">
            {timelineSteps.map((step) => {
              if (step.kind === 'reasoning') {
                if (!step.output && step.status !== 'running') return null
                return (
                  <ReasoningPanel
                    key={step.id}
                    content={step.output ?? ''}
                    streaming={streaming && step.status === 'running'}
                  />
                )
              }
              if (step.kind === 'message') {
                if (!step.output) return null
                return (
                  <AnswerSegment
                    key={step.id}
                    content={step.output}
                    streaming={streaming && step.status === 'running'}
                  />
                )
              }
              return <AgentTraceStepItem key={step.id} step={step} />
            })}
            {!hasReasoningStep && fallbackReasoning && (
              <ReasoningPanel
                content={fallbackReasoning}
                streaming={streaming}
              />
            )}
            {streaming && !hasCollapsibleContent && !finalAnswer && (
              <div className="chat-thinking-state">
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="thinking-dot" />
                <span className="ml-1 text-xs text-muted">
                  {t('workspace.chat.thinking', 'Thinking…')} · {formatElapsed(elapsedSeconds)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      {(finalAnswer || terminalStatus === 'cancelled' || terminalStatus === 'failed') && (
        <AnswerSegment
          content={finalAnswer}
          terminalStatus={terminalStatus}
          streaming={streaming && (!finalMessageStep || finalMessageStep.status === 'running')}
        />
      )}
    </>
  )
}

function formatRunDuration(ms: number): string {
  const duration = Math.max(0, ms)
  if (duration < 1000) return `${duration}ms`
  return `${(duration / 1000).toFixed(duration < 10000 ? 1 : 0)}s`
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

export interface ChatMessagesProps {
  messages: ChatTimelineMessage[]
  traceSteps: AgentTraceStep[]
  streaming: boolean
  streamingText: string
  streamingReasoning: string
  activeRunId: string | null
  elapsedSeconds: number
  loadingHistory: boolean
  providers: AiProvider[]
  onRegenerate: () => void
  onSuggestionClick: (text: string) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  inputAreaHeight: number
  stickToBottomRef: React.MutableRefObject<boolean>
}

export default function ChatMessages({
  messages,
  traceSteps,
  streaming,
  streamingText,
  streamingReasoning,
  activeRunId,
  elapsedSeconds,
  loadingHistory,
  providers,
  onRegenerate,
  onSuggestionClick,
  scrollRef,
  inputAreaHeight,
  stickToBottomRef
}: ChatMessagesProps) {
  const { t } = useTranslation()
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const handleMessageContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const message = event.currentTarget
    const selection = window.getSelection()
    const selectionInsideMessage = Boolean(
      selection?.rangeCount
      && selection.anchorNode
      && selection.focusNode
      && (selection.anchorNode === message || message.contains(selection.anchorNode))
      && (selection.focusNode === message || message.contains(selection.focusNode))
    )
    const selectedText = selectionInsideMessage ? selection?.toString() ?? '' : ''
    if (!selectedText) return

    event.preventDefault()
    const items: ContextMenuItem[] = [
      {
        key: 'copySelection',
        label: t('workspace.chat.copySelection', 'Copy selected text'),
        icon: <Copy className="h-3.5 w-3.5" />,
        onClick: () => {
          void window.api.clipboard.writeText(selectedText).catch(() => {
            useDocumentStore.getState().showToast(
              t('workspace.chat.copySelectionFailed', 'Failed to copy selected text')
            )
          })
        }
      }
    ]
    showContextMenu(items)
  }, [t])

  const displayMessages = useMemo(
    () => enrichChatMessages(messages, traceSteps).filter((message) => message.role !== 'tool'),
    [messages, traceSteps]
  )
  const showEmpty = displayMessages.length === 0 && !streaming && !streamingText && !streamingReasoning
  const visibleTodoRunId = useMemo(() => {
    if (activeRunId) return activeRunId
    const orderedRuns = traceSteps
      .filter((step) => step.kind === 'run')
      .sort((left, right) => right.startedAt - left.startedAt || right.seq - left.seq)
    if (orderedRuns[0]) return orderedRuns[0].runId
    const orderedSteps = [...traceSteps].sort(
      (left, right) => right.startedAt - left.startedAt || right.seq - left.seq
    )
    return orderedSteps[0]?.runId ?? null
  }, [activeRunId, traceSteps])
  const hasVisibleTodo = traceSteps.some((step) =>
    step.kind === 'todo' && step.runId === visibleTodoRunId
  )

  const runTraceGroups = useMemo(() => {
    const sorted = [...traceSteps].sort(
      (a, b) => a.startedAt - b.startedAt || a.seq - b.seq
    )
    const map = new Map<string, AgentTraceStep[]>()
    for (const s of sorted) {
      if (!map.has(s.runId)) {
        map.set(s.runId, [])
      }
      map.get(s.runId)!.push(s)
    }
    return map
  }, [traceSteps])

  const streamingSteps = useMemo(() => {
    if (!activeRunId) return []
    return runTraceGroups.get(activeRunId) ?? []
  }, [activeRunId, runTraceGroups])

  const lastAssistantIdx = (() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i].role === 'assistant') return i
    }
    return -1
  })()

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streamingText, streamingReasoning, traceSteps])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      stickToBottomRef.current = atBottom
      setShowScrollBtn(!atBottom && messages.length > 0)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [messages.length])

  return (
    <>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto py-3"
        style={{ paddingInline: 'clamp(12px, 7cqi, 64px)' }}
        data-testid="chat-message-scroll"
      >
        {hasVisibleTodo && (
          <div className="sticky top-0 z-20 mx-auto mb-3 flex w-full max-w-[768px] flex-col gap-2">
            <AgentTodoList steps={traceSteps} activeRunId={visibleTodoRunId} />
          </div>
        )}
        {loadingHistory ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`skeleton-shimmer h-12 rounded-2xl ${
                    i % 2 === 0 ? 'max-w-[70%] w-48' : 'max-w-[70%] w-36'
                  }`}
                />
              </div>
            ))}
          </div>
        ) : showEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            {providers.length === 0 ? (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {t('workspace.chat.noProviderTitle', 'No AI Provider')}
                  </p>
                  <p className="text-xs text-muted">
                    {t('workspace.chat.noProvider', 'No AI provider configured. Add one in Settings.')}
                  </p>
                </div>
                <UiButton
                  variant="primary"
                  size="md"
                  onClick={() => useSettingsModalStore.getState().openSettings('aiProviders')}
                >
                  {t('topbar.settings', 'Settings')}
                </UiButton>
              </>
            ) : (
              <>
                <p className="text-xs text-muted">
                  {t('workspace.chatPlaceholder', 'Ask anything about the papers in this workspace.')}
                </p>
                <div className="flex flex-col gap-1.5">
                  {[
                    { key: 'summarize', text: t('workspace.chat.suggestionSummarize', 'Summarize the key contributions of these papers') },
                    { key: 'compare', text: t('workspace.chat.suggestionCompare', 'Compare the methodologies used in these papers') },
                    { key: 'report', text: t('workspace.chat.suggestionReport', 'Generate a research report') }
                  ].map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className="rounded-lg border border-border bg-panel-2 px-3 py-1.5 text-left text-label text-muted transition-colors duration-150 hover:border-accent hover:text-foreground"
                      onClick={() => onSuggestionClick(s.text)}
                    >
                      {s.text}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[768px] flex-col gap-3">
            {displayMessages.map((m, idx) => {
              const runSteps = m.runId ? (runTraceGroups.get(m.runId) ?? []) : []
              const showRegenerate =
                m.role === 'assistant' && idx === lastAssistantIdx && !streaming

              if (m.role === 'user') {
                return (
                  <div
                    key={m.id}
                    className="group flex w-full flex-col items-end"
                    onContextMenu={handleMessageContextMenu}
                  >
                    <div className="chat-user-message">
                      {m.content}
                    </div>
                    <CopyButton text={m.content} className="mt-1 text-muted opacity-0 group-hover:opacity-100" />
                  </div>
                )
              }

              return (
                <article
                  key={m.id}
                  className="chat-response-group"
                  onContextMenu={handleMessageContextMenu}
                >
                  <RunTimeline
                    steps={runSteps}
                    fallbackAnswer={m.content}
                    fallbackReasoning=""
                    terminalStatus={m.terminalStatus}
                    streaming={false}
                    elapsedSeconds={0}
                  />
                  <div className="chat-message-actions">
                    <CopyButton text={m.content} />
                    {showRegenerate && (
                      <button
                        type="button"
                        className="chat-message-action text-muted opacity-60"
                        onClick={() => onRegenerate()}
                        title={t('workspace.chat.regenerate', 'Regenerate')}
                        aria-label={t('workspace.chat.regenerate', 'Regenerate')}
                      >
                        <ArrowCounterClockwise className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
            {streaming && (
              <article
                className="chat-response-group"
                aria-live="polite"
                onContextMenu={handleMessageContextMenu}
              >
                <RunTimeline
                  steps={streamingSteps}
                  fallbackAnswer={streamingText}
                  fallbackReasoning={streamingReasoning}
                  streaming
                  elapsedSeconds={elapsedSeconds}
                />
              </article>
            )}
          </div>
        )}
      </div>

      {showScrollBtn && (
        <button
          type="button"
          className="absolute right-4 z-10 rounded-full border border-border bg-panel p-1.5 shadow-lg transition-colors duration-150 hover:bg-hover"
          style={{ bottom: inputAreaHeight > 0 ? inputAreaHeight + 8 : 80 }}
          onClick={() => {
            const el = scrollRef.current
            if (el) {
              el.scrollTop = el.scrollHeight
              stickToBottomRef.current = true
              setShowScrollBtn(false)
            }
          }}
          aria-label={t('workspace.chat.scrollToBottom', 'Scroll to bottom')}
          title={t('workspace.chat.scrollToBottom', 'Scroll to bottom')}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </>
  )
}
