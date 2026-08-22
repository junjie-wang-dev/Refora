import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X, ArrowCounterClockwise } from '@phosphor-icons/react'
import { api } from '../../ipc'
import { errorMessage } from '../../../shared/ipc-types'
import type {
  AgentProfile,
  AiProvider,
  AiReasoningEffort,
  ProviderModelInfo
} from '../../../shared/ipc-types'
import { composeModelId, parseModelId } from '../../../shared/modelVariant'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { usePdfReaderStore } from '../../store/pdfReaderStore'
import { useChatDraftStore } from '../../store/chatDraftStore'
import { useDocumentStore } from '../../store/documentStore'
import { Button as UiButton, PanelTabHeader } from '../ui'
import { useChatStream } from '../../hooks/useChatStream'
import { AI_PROVIDERS_CHANGED_EVENT } from '../../utils/aiProviderEvents'
import { MAX_INPUT_LENGTH } from '../../utils/chatUtils'
import ChatMessages from './ChatMessages'
import ChatInput from './ChatInput'
import ModelSelector from './ModelSelector'
import ThreadHistory from './ThreadHistory'
import AgentOcrProgress from './AgentOcrProgress'
import AgentApprovalCard from './AgentApprovalCard'
import i18n from '../../i18n'
import { trackRendererPersistence } from '../../persistence'

export { parseReforaDocLink } from '../../utils/markdown'

const AI_REASONING_EFFORTS = new Set<AiReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])

function persistChatSetting(key: string, value: unknown): void {
  void trackRendererPersistence(api.settings.set(key, value)).catch(() => {
    useDocumentStore.getState().showToast(i18n.t('common.settingsSaveFailed'))
  })
}

function providerReasoningEffort(provider: AiProvider): AiReasoningEffort {
  return provider.reasoningControl === 'none' ? 'none' : provider.reasoningEffort
}

function normalizeReasoningEffort(
  value: unknown,
  fallback: AiReasoningEffort
): AiReasoningEffort {
  return typeof value === 'string' &&
    AI_REASONING_EFFORTS.has(value as AiReasoningEffort) &&
    (value !== 'none' || fallback === 'none')
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
  const configuredModels = provider.models?.length
    ? provider.models
    : [provider.model, provider.baseModel]
  return configuredModels.some((candidate) => {
    const parsed = parseModelId(candidate)
    return candidate === model || parsed.baseModel === model
  })
}

function agentOption(profile: AgentProfile, provider?: AiProvider): AiProvider {
  if (provider) {
    return {
      ...provider,
      id: profile.id,
      name: profile.name,
      model: profile.model || provider.model,
      baseModel: profile.model || provider.baseModel,
      reasoningEffort: profile.reasoningEffort
    }
  }
  const model = profile.model || 'default'
  return {
    id: profile.id,
    presetId: `${profile.cliRuntimeId ?? 'cli'}-cli`,
    name: profile.name,
    baseUrl: '',
    apiProtocol: 'openai-responses',
    reasoningControl: profile.reasoningEffort === 'none' ? 'none' : 'openai',
    reasoningEffort: profile.reasoningEffort,
    model,
    models: null,
    baseModel: model,
    variant: '',
    variantFormat: 'none',
    hasKey: true,
    temperature: null,
    maxTokens: null,
    createdAt: profile.createdAt
  }
}

interface ChatPanelProps {
  onClose?: () => void
}

export default function ChatPanel({ onClose }: ChatPanelProps = {}) {
  const { t } = useTranslation()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const panelView = useWorkspaceStore((s) => s.panelView)
  const activePdfDocumentId = usePdfReaderStore((s) => s.activeDocumentId)
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId)
  const setActiveThreadId = useWorkspaceStore((s) => s.setActiveThreadId)
  const setChatStreaming = useWorkspaceStore((s) => s.setChatStreaming)
  const startNewChat = useWorkspaceStore((s) => s.startNewChat)
  const threads = useWorkspaceStore((s) => s.threads)
  const fetchThreads = useWorkspaceStore((s) => s.fetchThreads)
  const pendingChatDraft = useChatDraftStore((s) => s.pending)
  const consumeChatDraft = useChatDraftStore((s) => s.consume)

  const [providers, setProviders] = useState<AiProvider[]>([])
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([])
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
  const handledChatDraftIdsRef = useRef(new Set<number>())
  const providerLoadVersionRef = useRef(0)

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
    activeDocumentId: panelView === 'pdf' ? activePdfDocumentId : null,
    activeProviderId,
    activeThreadId,
    requestModel,
    deepThinking,
    reasoningEffort: selectedReasoningEffort,
    setActiveThreadId,
    setChatStreaming,
    fetchThreads
  })

  const canSend = !!activeProviderId &&
    !!input.trim() &&
    input.trim().length <= MAX_INPUT_LENGTH &&
    !chat.streaming &&
    !chat.pendingInterrupt

  useEffect(() => {
    if (!pendingChatDraft || handledChatDraftIdsRef.current.has(pendingChatDraft.id)) return
    handledChatDraftIdsRef.current.add(pendingChatDraft.id)
    setInput((current) => {
      if (pendingChatDraft.mode === 'prefill' && !current.trim()) {
        return pendingChatDraft.text
      }
      return [current.trimEnd(), pendingChatDraft.text].filter(Boolean).join('\n\n')
    })
    consumeChatDraft(pendingChatDraft.id)
    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length
    })
    return () => window.cancelAnimationFrame(frame)
  }, [consumeChatDraft, pendingChatDraft])

  const loadProviders = useCallback(async () => {
    const loadVersion = ++providerLoadVersionRef.current
    try {
      const [
        profiles,
        apiProviders,
        activeProfileId,
        savedProfileId,
        legacyActiveProviderId,
        legacySavedProviderId,
        savedModel,
        savedVariant,
        savedReasoningEffort
      ] = await Promise.all([
        api.agentProfiles.list(),
        api.aiProviders.list(),
        api.settings.get<string>('activeAgentProfileId', ''),
        api.settings.get<string>('chatSelectedAgentProfileId', ''),
        api.settings.get<string>('activeProviderId', ''),
        api.settings.get<string>('chatSelectedProviderId', ''),
        api.settings.get<string>('chatSelectedModel', ''),
        api.settings.get<string>('chatSelectedVariant', ''),
        api.settings.get<AiReasoningEffort | ''>('chatReasoningEffort', '')
      ])
      if (loadVersion !== providerLoadVersionRef.current) return
      const apiProvidersById = new Map(
        apiProviders.map((provider) => [provider.id, provider])
      )
      const resolvedProfiles = profiles.length > 0
        ? profiles
        : apiProviders.map((provider): AgentProfile => ({
            id: provider.id,
            name: provider.name,
            kind: 'api',
            apiProviderId: provider.id,
            cliRuntimeId: null,
            executablePath: null,
            model: provider.model,
            reasoningEffort: provider.reasoningEffort,
            nativeWebSearch: false,
            webSearchPolicy: 'auto',
            createdAt: provider.createdAt,
            updatedAt: provider.createdAt
          }))
      const list = resolvedProfiles.flatMap((profile) => {
        if (profile.kind === 'cli') return [agentOption(profile)]
        const provider = profile.apiProviderId
          ? apiProvidersById.get(profile.apiProviderId)
          : undefined
        return provider ? [agentOption(profile, provider)] : []
      })
      setAgentProfiles(resolvedProfiles)
      setProviders(list)
      const providerIds = new Set(list.map((provider) => provider.id))
      const legacySavedProfileId = resolvedProfiles.find(
        (profile) => profile.apiProviderId === legacySavedProviderId
      )?.id
      const legacyActiveProfileId = resolvedProfiles.find(
        (profile) => profile.apiProviderId === legacyActiveProviderId
      )?.id
      const activeIsValid = !!activeProfileId && providerIds.has(activeProfileId)
      const savedProviderIsValid = !!savedProfileId && providerIds.has(savedProfileId)
      const nextId =
        (savedProviderIsValid && savedProfileId) ||
        (activeIsValid && activeProfileId) ||
        (legacySavedProfileId && providerIds.has(legacySavedProfileId) && legacySavedProfileId) ||
        (legacyActiveProfileId && providerIds.has(legacyActiveProfileId) && legacyActiveProfileId) ||
        (list.length > 0 ? list[0].id : '')
      setActiveProviderId(nextId)
      const p = list.find((x) => x.id === nextId)
      if (p) {
        const fallback = defaultModelForProvider(p)
        const useSavedModel = !!savedModel && (
          savedProfileId === nextId ||
          (legacySavedProfileId === nextId && providerAllowsModel(p, savedModel))
        )
        const fallbackReasoningEffort = providerReasoningEffort(p)
        const nextReasoningEffort = savedProfileId === nextId || legacySavedProfileId === nextId
          ? normalizeReasoningEffort(savedReasoningEffort, fallbackReasoningEffort)
          : fallbackReasoningEffort
        setSelectedModel(useSavedModel ? savedModel : fallback.model)
        setSelectedVariant(useSavedModel ? savedVariant : fallback.variant)
        setSelectedReasoningEffort(nextReasoningEffort)
      }
      if (nextId) {
        persistChatSetting('activeAgentProfileId', nextId)
        persistChatSetting('chatSelectedAgentProfileId', nextId)
        const selectedProfile = resolvedProfiles.find((profile) => profile.id === nextId)
        if (selectedProfile?.apiProviderId) {
          persistChatSetting('activeProviderId', selectedProfile.apiProviderId)
        }
        if (p) {
          const fallback = defaultModelForProvider(p)
          const useSavedModel = !!savedModel && (
            savedProfileId === nextId ||
            (legacySavedProfileId === nextId && providerAllowsModel(p, savedModel))
          )
          const fallbackReasoningEffort = providerReasoningEffort(p)
          const nextReasoningEffort = savedProfileId === nextId || legacySavedProfileId === nextId
            ? normalizeReasoningEffort(savedReasoningEffort, fallbackReasoningEffort)
            : fallbackReasoningEffort
          persistChatSetting('chatSelectedModel', useSavedModel ? savedModel : fallback.model)
          persistChatSetting('chatSelectedVariant', useSavedModel ? savedVariant : fallback.variant)
          persistChatSetting('chatReasoningEffort', nextReasoningEffort)
        }
      }
    } catch (e) {
      if (loadVersion === providerLoadVersionRef.current) {
        chat.setError(errorMessage(e, t('workspace.chat.providersLoadFailed')))
      }
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
    const reloadProviders = () => {
      providerLoadVersionRef.current += 1
      setProviders([])
      setAgentProfiles([])
      setActiveProviderId('')
      setSelectedModel('')
      setSelectedVariant('')
      setSelectedReasoningEffort('none')
      void loadProviders()
    }
    api.events.onLibrarySwitched(reloadProviders)
    return () => {
      providerLoadVersionRef.current += 1
      api.events.off('library:switched', reloadProviders)
    }
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
          const profile = agentProfiles.find((candidate) => candidate.id === provider.id)
          const result = profile?.kind === 'cli'
            ? await api.agentProfiles.listModels(profile.id)
            : await api.aiProviders.listModels({
                providerId: profile?.apiProviderId ?? provider.id
              })
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
  }, [agentProfiles, providers])

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
      const nextProvider = providers.find((provider) => provider.id === nextProviderId)
      const nextRequestModel = composeModelId(
        baseModel,
        variant,
        nextProvider?.variantFormat ?? 'dash'
      )
      const nextModelInfo = (providerModels[nextProviderId] ?? []).find(
        (model) => model.id === nextRequestModel || model.id === baseModel
      )
      const providerDefaultEffort = nextProvider
        ? providerReasoningEffort(nextProvider)
        : 'none'
      const nextReasoningEffort = nextProvider?.reasoningControl === 'none'
        ? 'none'
        : nextModelInfo?.reasoningEfforts.length
          ? !providerChanged && nextModelInfo.reasoningEfforts.includes(selectedReasoningEffort)
            ? selectedReasoningEffort
            : nextModelInfo.defaultReasoningEffort ??
              (nextModelInfo.reasoningEfforts.includes(providerDefaultEffort)
                ? providerDefaultEffort
                : nextModelInfo.reasoningEfforts[0])
          : providerDefaultEffort
      if (providerId && providerId !== activeProviderId) {
        const nextProfile = agentProfiles.find((profile) => profile.id === providerId)
        setActiveProviderId(providerId)
        persistChatSetting('activeAgentProfileId', providerId)
        if (nextProfile?.apiProviderId) {
          persistChatSetting('activeProviderId', nextProfile.apiProviderId)
        }
      }
      setSelectedReasoningEffort(nextReasoningEffort)
      persistChatSetting('chatReasoningEffort', nextReasoningEffort)
      setSelectedModel(baseModel)
      setSelectedVariant(variant)
      persistChatSetting('chatSelectedAgentProfileId', nextProviderId)
      persistChatSetting('chatSelectedModel', baseModel)
      persistChatSetting('chatSelectedVariant', variant)
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
      agentProfiles,
      chat.messages.length,
      providerModels,
      providers,
      chat.hadMessagesRef,
      selectedReasoningEffort
    ]
  )

  const applyReasoningEffort = useCallback(
    (effort: AiReasoningEffort) => {
      const nextEffort = activeProvider?.reasoningControl === 'none' ? 'none' : effort
      setSelectedReasoningEffort(nextEffort)
      persistChatSetting('chatReasoningEffort', nextEffort)
    },
    [activeProvider?.reasoningControl]
  )

  const handleSend = useCallback(() => {
    if (!input.trim() || chat.streaming) return
    const text = input.trim()
    if (text.length > MAX_INPUT_LENGTH) {
      chat.setError(t('workspace.chat.inputTooLong', 'Message is too long. Please shorten it.'))
      return
    }
    const atts = [...selectedAttachments]
    setInput('')
    setSelectedAttachments([])
    setAttachMenuOpen(false)
    void chat.sendText(text, atts, activeThreadId)
  }, [activeThreadId, chat, input, selectedAttachments, t])

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
      chat.setError(t('workspace.chat.exportFailed'))
    }
  }, [threads, chat.setError, t])

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
