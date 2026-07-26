import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X, ArrowCounterClockwise } from '@phosphor-icons/react'
import { api } from '../../ipc'
import { errorMessage } from '../../../shared/ipc-types'
import type {
  AiProvider,
  AiReasoningEffort,
  ProviderModelInfo
} from '../../../shared/ipc-types'
import { composeModelId, parseModelId } from '../../../shared/modelVariant'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { Button as UiButton, PanelTabHeader } from '../ui'
import { useChatStream } from '../../hooks/useChatStream'
import { AI_PROVIDERS_CHANGED_EVENT } from '../../utils/aiProviderEvents'
import ChatMessages from './ChatMessages'
import ChatInput from './ChatInput'
import ModelSelector from './ModelSelector'
import ThreadHistory from './ThreadHistory'
import AgentOcrProgress from './AgentOcrProgress'
import AgentApprovalCard from './AgentApprovalCard'

export { parseReforaDocLink } from '../../utils/markdown'

const AI_REASONING_EFFORTS = new Set<AiReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

function providerReasoningEffort(provider: AiProvider): AiReasoningEffort {
  return provider.reasoningControl === 'none' ? 'none' : provider.reasoningEffort
}

function normalizeReasoningEffort(
  value: unknown,
  fallback: AiReasoningEffort
): AiReasoningEffort {
  return typeof value === 'string' && AI_REASONING_EFFORTS.has(value as AiReasoningEffort)
    ? value as AiReasoningEffort
    : fallback
}

function defaultModelForProvider(provider: AiProvider): { model: string; variant: string } {
  const configured = provider.models?.[0] ?? provider.model
  const parsed = parseModelId(configured)
  return {
    model: parsed.baseModel || provider.baseModel || configured,
    variant: parsed.variant || (configured === provider.model ? provider.variant : '')
  }
}

function providerAllowsModel(provider: AiProvider, model: string): boolean {
  if (!provider.models?.length) return true
  return provider.models.some((candidate) => {
    const parsed = parseModelId(candidate)
    return candidate === model || parsed.baseModel === model
  })
}

interface ChatPanelProps {
  onClose?: () => void
}

export default function ChatPanel({ onClose }: ChatPanelProps = {}) {
  const { t } = useTranslation()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId)
  const setActiveThreadId = useWorkspaceStore((s) => s.setActiveThreadId)
  const setChatStreaming = useWorkspaceStore((s) => s.setChatStreaming)
  const startNewChat = useWorkspaceStore((s) => s.startNewChat)
  const threads = useWorkspaceStore((s) => s.threads)
  const fetchThreads = useWorkspaceStore((s) => s.fetchThreads)

  const [providers, setProviders] = useState<AiProvider[]>([])
  const [activeProviderId, setActiveProviderId] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedVariant, setSelectedVariant] = useState('')
  const [selectedReasoningEffort, setSelectedReasoningEffort] =
    useState<AiReasoningEffort>('none')
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelInfo[]>>({})
  const [modelSwitchHint, setModelSwitchHint] = useState<'model' | 'provider' | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)

  const [input, setInput] = useState('')
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([])
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)

  const [inputAreaHeight, setInputAreaHeight] = useState(0)

  const [threadMenuOpen, setThreadMenuOpen] = useState(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const inputAreaRef = useRef<HTMLDivElement | null>(null)

  const activeProvider = providers.find((p) => p.id === activeProviderId) ?? null
  const deepThinking =
    !!activeProvider &&
    activeProvider.reasoningControl !== 'none' &&
    selectedReasoningEffort !== 'none'

  const activeThread = threads.find((th) => th.id === activeThreadId)
  const activeThreadTitle = activeThread?.title?.trim()
    ? activeThread.title.trim()
    : t('workspace.chat.newConversation', 'New conversation')

  const requestModel = useMemo(() => {
    if (!selectedModel) return ''
    const format = activeProvider?.variantFormat ?? 'dash'
    return composeModelId(selectedModel, selectedVariant, format)
  }, [selectedModel, selectedVariant, activeProvider?.variantFormat])

  const chat = useChatStream({
    activeWorkspaceId,
    activeProviderId,
    activeThreadId,
    requestModel,
    deepThinking,
    reasoningEffort: selectedReasoningEffort,
    setActiveThreadId,
    setChatStreaming,
    fetchThreads
  })

  const canSend = !!activeProviderId && !!input.trim() && !chat.streaming && !chat.pendingInterrupt

  const loadProviders = useCallback(async () => {
    try {
      const [
        list,
        active,
        savedProviderId,
        savedModel,
        savedVariant,
        savedReasoningEffort
      ] = await Promise.all([
        api.aiProviders.list(),
        api.settings.get<string>('activeProviderId', ''),
        api.settings.get<string>('chatSelectedProviderId', ''),
        api.settings.get<string>('chatSelectedModel', ''),
        api.settings.get<string>('chatSelectedVariant', ''),
        api.settings.get<AiReasoningEffort | ''>('chatReasoningEffort', '')
      ])
      setProviders(list)
      const providerIds = new Set(list.map((provider) => provider.id))
      const activeIsValid = !!active && providerIds.has(active)
      const savedProviderIsValid = !!savedProviderId && providerIds.has(savedProviderId)
      const nextId =
        (savedProviderIsValid && savedProviderId) ||
        (activeIsValid && active) ||
        (list.length > 0 ? list[0].id : '')
      setActiveProviderId(nextId)
      const p = list.find((x) => x.id === nextId)
      if (p) {
        const fallback = defaultModelForProvider(p)
        const useSavedModel =
          savedProviderId === nextId && !!savedModel && providerAllowsModel(p, savedModel)
        const fallbackReasoningEffort = providerReasoningEffort(p)
        const nextReasoningEffort = savedProviderId === nextId
          ? normalizeReasoningEffort(savedReasoningEffort, fallbackReasoningEffort)
          : fallbackReasoningEffort
        setSelectedModel(useSavedModel ? savedModel : fallback.model)
        setSelectedVariant(useSavedModel ? savedVariant : fallback.variant)
        setSelectedReasoningEffort(nextReasoningEffort)
      }
      if (nextId) {
        void api.settings.set('activeProviderId', nextId)
        void api.settings.set('chatSelectedProviderId', nextId)
        if (p) {
          const fallback = defaultModelForProvider(p)
          const useSavedModel =
            savedProviderId === nextId && !!savedModel && providerAllowsModel(p, savedModel)
          const fallbackReasoningEffort = providerReasoningEffort(p)
          const nextReasoningEffort = savedProviderId === nextId
            ? normalizeReasoningEffort(savedReasoningEffort, fallbackReasoningEffort)
            : fallbackReasoningEffort
          void api.settings.set('chatSelectedModel', useSavedModel ? savedModel : fallback.model)
          void api.settings.set('chatSelectedVariant', useSavedModel ? savedVariant : fallback.variant)
          void api.settings.set('chatReasoningEffort', nextReasoningEffort)
        }
      }
    } catch (e) {
      chat.setError(errorMessage(e, 'Failed to load providers'))
    }
  }, [])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  useEffect(() => {
    void fetchThreads({ selectLatestIfNone: true })
  }, [activeWorkspaceId, fetchThreads])

  useEffect(() => {
    const reloadProviders = () => void loadProviders()
    window.addEventListener(AI_PROVIDERS_CHANGED_EVENT, reloadProviders)
    return () => window.removeEventListener(AI_PROVIDERS_CHANGED_EVENT, reloadProviders)
  }, [loadProviders])

  useEffect(() => {
    if (providers.length === 0) {
      setProviderModels({})
      return
    }
    let cancelled = false
    setLoadingModels(true)
    void Promise.all(
      providers.map(async (provider) => {
        try {
          const result = await api.aiProviders.listModels({ providerId: provider.id })
          return [provider.id, result.ok ? result.models : []] as const
        } catch {
          return [provider.id, []] as const
        }
      })
    )
      .then((entries) => {
        if (cancelled) return
        setProviderModels(Object.fromEntries(entries))
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false)
      })
    return () => {
      cancelled = true
    }
  }, [providers])

  useEffect(() => {
    setSelectedAttachments([])
    setAttachMenuOpen(false)
  }, [activeWorkspaceId, activeThreadId])

  useEffect(() => {
    const onShortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        const el = textareaRef.current
        if (!chat.streaming && el) {
          e.preventDefault()
          el.focus()
        }
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [chat.streaming])

  useEffect(() => {
    const el = inputAreaRef.current
    if (!el) return
    const update = () => setInputAreaHeight(el.offsetHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const applyModel = useCallback(
    async (baseModel: string, variant = '', providerId?: string) => {
      const nextProviderId = providerId ?? activeProviderId
      if (!providers.some((provider) => provider.id === nextProviderId)) return
      const providerChanged = !!providerId && providerId !== activeProviderId
      if (providerId && providerId !== activeProviderId) {
        const nextProvider = providers.find((provider) => provider.id === providerId)
        setActiveProviderId(providerId)
        void api.settings.set('activeProviderId', providerId)
        if (nextProvider) {
          const nextReasoningEffort = providerReasoningEffort(nextProvider)
          setSelectedReasoningEffort(nextReasoningEffort)
          void api.settings.set('chatReasoningEffort', nextReasoningEffort)
        }
      }
      setSelectedModel(baseModel)
      setSelectedVariant(variant)
      void api.settings.set('chatSelectedProviderId', nextProviderId)
      void api.settings.set('chatSelectedModel', baseModel)
      void api.settings.set('chatSelectedVariant', variant)
      if (providerChanged && (chat.hadMessagesRef.current || chat.messages.length > 0)) {
        setModelSwitchHint('provider')
        window.setTimeout(() => setModelSwitchHint(null), 3500)
      } else if (chat.hadMessagesRef.current || chat.messages.length > 0) {
        setModelSwitchHint('model')
        window.setTimeout(() => setModelSwitchHint(null), 3500)
      }
    },
    [
      activeProviderId,
      chat.messages.length,
      providers,
      chat.hadMessagesRef
    ]
  )

  const applyReasoningEffort = useCallback(
    (effort: AiReasoningEffort) => {
      const nextEffort = activeProvider?.reasoningControl === 'none' ? 'none' : effort
      setSelectedReasoningEffort(nextEffort)
      void api.settings.set('chatReasoningEffort', nextEffort)
    },
    [activeProvider?.reasoningControl]
  )

  const handleSend = useCallback(() => {
    if (!input.trim() || chat.streaming) return
    const text = input.trim()
    const atts = [...selectedAttachments]
    setInput('')
    setSelectedAttachments([])
    setAttachMenuOpen(false)
    void chat.sendText(text, atts, activeThreadId)
  }, [input, chat.streaming, selectedAttachments, activeThreadId, chat.sendText])

  const exportThread = useCallback(async (threadId: string) => {
    if (!threadId) return
    try {
      const history = await api.ai.chatHistory(threadId)
      const thread = threads.find((th) => th.id === threadId)
      const title = thread?.title?.trim() || `thread-${threadId.slice(0, 8)}`
      const date = new Date().toISOString().slice(0, 10)
      const lines: string[] = [`# ${title}`, '']
      for (const msg of history) {
        if (msg.role === 'user') {
          lines.push('## User', '')
        } else if (msg.role === 'assistant') {
          lines.push('## Assistant', '')
        } else {
          continue
        }
        lines.push(msg.content, '')
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title.replace(/[^\w\u4e00-\u9fff\s-]/g, '').trim() || 'conversation'}-${date}.md`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      chat.setError('Failed to export conversation')
    }
  }, [threads, chat.setError])

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background" style={{ containerType: 'inline-size' }}>
      <PanelTabHeader
        title={activeThreadTitle}
        onClose={onClose}
        closeLabel={t('workspace.chat.closePanel')}
        closeDisabled={chat.streaming}
        onTitleClick={() => setThreadMenuOpen((open) => !open)}
        titleDisabled={chat.streaming}
        actions={
          <>
            <ThreadHistory
              streaming={chat.streaming}
              onExportThread={exportThread}
              menuOpen={threadMenuOpen}
              onMenuOpenChange={setThreadMenuOpen}
            />
            <UiButton
              variant="ghost"
              size="sm"
              iconOnly
              onClick={startNewChat}
              title={t('workspace.chat.newChat', 'New chat')}
              aria-label={t('workspace.chat.newChat', 'New chat')}
              disabled={chat.streaming}
            >
              <Plus className="h-4 w-4" />
            </UiButton>
          </>
        }
      />

      <ChatMessages
        messages={chat.messages}
        traceSteps={chat.traceSteps}
        streaming={chat.streaming}
        streamingText={chat.streamingText}
        streamingReasoning={chat.streamingReasoning}
        activeRunId={chat.activeRunId}
        elapsedSeconds={chat.elapsedSeconds}
        loadingHistory={chat.loadingHistory}
        providers={providers}
        onRegenerate={chat.handleRegenerate}
        onSuggestionClick={setInput}
        scrollRef={scrollRef}
        inputAreaHeight={inputAreaHeight}
        stickToBottomRef={chat.stickToBottomRef}
      />

      {chat.activeOcrDocumentId && (
        <AgentOcrProgress
          documentId={chat.activeOcrDocumentId}
          className="shrink-0 pb-2"
          style={{ paddingInline: 'clamp(12px, 7cqi, 64px)' }}
        />
      )}

      {chat.pendingInterrupt && (
        <AgentApprovalCard
          interrupt={chat.pendingInterrupt}
          activeWorkspaceId={activeWorkspaceId}
          streaming={chat.streaming}
          onResolve={chat.resolveInterrupt}
        />
      )}

      {chat.error && (
        <div className="shrink-0 px-3 pb-1">
          <div className="flex items-center gap-2 rounded-lg bg-error/10 px-3 py-1.5 text-xs text-error">
            <span className="min-w-0 flex-1 break-words">{chat.error}</span>
            {chat.canRetry && !chat.streaming && (
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-label font-medium transition-colors duration-150 hover:bg-error/20"
                onClick={() => void chat.handleRetry()}
                title={t('workspace.chat.retry', 'Retry')}
                aria-label={t('workspace.chat.retry', 'Retry')}
              >
                <ArrowCounterClockwise className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              className="shrink-0 rounded px-1 py-0.5 transition-colors duration-150 hover:bg-error/20"
              onClick={chat.clearError}
              title={t('common.dismiss', 'Dismiss')}
              aria-label={t('common.dismiss', 'Dismiss')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {modelSwitchHint && (
        <div className="shrink-0 px-3 pb-1">
          <div className="rounded-lg bg-panel-2 px-3 py-1.5 text-label text-muted">
            {t(
              modelSwitchHint === 'provider'
                ? 'workspace.chat.providerSwitchHint'
                : 'workspace.chat.modelSwitchHint',
              modelSwitchHint === 'provider'
                ? 'Provider switched — applies to new messages only.'
                : 'Model switched — applies to new messages only.'
            )}
          </div>
        </div>
      )}

      <ChatInput
        input={input}
        onInputChange={setInput}
        streaming={chat.streaming}
        selectedAttachments={selectedAttachments}
        onSelectedAttachmentsChange={setSelectedAttachments}
        attachMenuOpen={attachMenuOpen}
        onAttachMenuOpenChange={setAttachMenuOpen}
        activeWorkspaceId={activeWorkspaceId}
        providers={providers}
        canSend={canSend}
        onSend={handleSend}
        onCancel={chat.handleCancel}
        textareaRef={textareaRef}
        inputAreaRef={inputAreaRef}
        toolbar={
          <ModelSelector
            providers={providers}
            activeProviderId={activeProviderId}
            selectedModel={selectedModel}
            selectedVariant={selectedVariant}
            providerModels={providerModels}
            loadingModels={loadingModels}
            reasoningEffort={deepThinking ? selectedReasoningEffort : 'none'}
            requestModel={requestModel}
            streaming={chat.streaming}
            onApplyModel={applyModel}
            onReasoningEffortChange={applyReasoningEffort}
          />
        }
      />
    </div>
  )
}
