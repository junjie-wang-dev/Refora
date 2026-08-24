import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  CaretDown,
  Check,
  ImageSquare,
  PencilSimple,
  PlugsConnected,
  Plus,
  Trash,
  Wrench,
  X
} from '@phosphor-icons/react'
import {
  DeepSeek,
  Groq,
  Kimi,
  Mistral,
  Ollama,
  OpenAI,
  OpenRouter,
  Qwen,
  SiliconCloud,
  Together,
  Zhipu,
  type IconType
} from '@lobehub/icons'
import type {
  AiApiProtocol,
  AiProvider,
  AiReasoningControl,
  AiReasoningEffort,
  ProviderModelInfo
} from '../../shared/ipc-types'
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  inferModelCapabilities,
  pickDefaultModel,
  reasoningEffortsForModel,
  type ProviderPreset
} from '../../shared/providerCatalog'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import { Badge, Button, Input } from './ui'
import { useModalDialog } from '../hooks/useModalDialog'
import { useAgentCatalogStore } from '../store/agentCatalogStore'
import { cleanupDeletedAgentSelections } from '../utils/agentCatalogSettings'

interface ProviderForm {
  id: string | null
  presetId: string
  name: string
  baseUrl: string
  apiProtocol: AiApiProtocol
  reasoningControl: AiReasoningControl
  reasoningEffort: AiReasoningEffort
  apiKey: string
  model: string
  models: string[] | null
  temperature: string
  maxTokens: string
}

type TestState = 'testing' | { ok: boolean; count: number }

const PROTOCOL_OPTIONS: Array<{ value: AiApiProtocol; labelKey: string }> = [
  { value: 'openai-responses', labelKey: 'settings.aiProviders.protocolResponses' },
  { value: 'openai-compatible', labelKey: 'settings.aiProviders.protocolCompatible' }
]

const REASONING_CONTROL_OPTIONS: Array<{ value: AiReasoningControl; labelKey: string }> = [
  { value: 'openai', labelKey: 'settings.aiProviders.reasoningOpenAi' },
  { value: 'thinking', labelKey: 'settings.aiProviders.reasoningThinking' },
  { value: 'enable-thinking', labelKey: 'settings.aiProviders.reasoningEnableThinking' },
  { value: 'none', labelKey: 'settings.aiProviders.reasoningNone' }
]

const PROVIDER_ICONS: Record<string, IconType> = {
  openai: OpenAI,
  deepseek: DeepSeek,
  kimi: Kimi,
  'ollama-cloud': Ollama,
  'ollama-local': Ollama,
  glm: Zhipu,
  openrouter: OpenRouter,
  qwen: Qwen,
  siliconflow: SiliconCloud,
  together: Together,
  groq: Groq,
  mistral: Mistral
}

function ProviderIcon({ presetId, size = 18 }: { presetId: string; size?: number }) {
  const Icon = PROVIDER_ICONS[presetId]
  return (
    <span
      className="flex items-center justify-center text-foreground"
      data-provider-icon={presetId}
    >
      {Icon ? <Icon aria-hidden size={size} /> : <PlugsConnected aria-hidden size={size} />}
    </span>
  )
}

function formFromPreset(preset: ProviderPreset): ProviderForm {
  return {
    id: null,
    presetId: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiProtocol: preset.apiProtocol,
    reasoningControl: preset.reasoningControl,
    reasoningEffort: preset.defaultReasoningEffort,
    apiKey: '',
    model: preset.defaultModel,
    models: null,
    temperature: '',
    maxTokens: ''
  }
}

function formFromProvider(provider: AiProvider): ProviderForm {
  return {
    id: provider.id,
    presetId: provider.presetId,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiProtocol: provider.apiProtocol,
    reasoningControl: provider.reasoningControl,
    reasoningEffort: provider.reasoningEffort,
    apiKey: '',
    model: provider.baseModel || provider.model,
    models: provider.models,
    temperature: provider.temperature?.toString() ?? '',
    maxTokens: provider.maxTokens?.toString() ?? ''
  }
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function CapabilityBadges({ model }: { model: ProviderModelInfo }) {
  const { t } = useTranslation()
  return (
    <span className="flex shrink-0 items-center gap-1 text-text-tertiary">
      {model.supportsReasoning && (
        <span title={t('settings.aiProviders.capabilityReasoning')}>
          <Brain className="h-3.5 w-3.5" />
        </span>
      )}
      {model.supportsVision && (
        <span title={t('settings.aiProviders.capabilityVision')}>
          <ImageSquare className="h-3.5 w-3.5" />
        </span>
      )}
      {model.supportsTools && (
        <span title={t('settings.aiProviders.capabilityTools')}>
          <Wrench className="h-3.5 w-3.5" />
        </span>
      )}
    </span>
  )
}

export function AiProvidersSection() {
  const { t } = useTranslation()
  const providers = useAgentCatalogStore((state) => state.apiProviders)
  const refreshAgentCatalog = useAgentCatalogStore((state) => state.refresh)
  const removeCatalogProvider = useAgentCatalogStore((state) => state.removeProvider)
  const [form, setForm] = useState<ProviderForm | null>(null)
  const [models, setModels] = useState<ProviderModelInfo[]>([])
  const [modelFilter, setModelFilter] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testStates, setTestStates] = useState<Record<string, TestState>>({})
  const formRef = useRef<ProviderForm | null>(null)
  const modelRequestGenerationRef = useRef(0)
  formRef.current = form

  const load = useCallback(async () => {
    try {
      await refreshAgentCatalog({ loadModels: false })
    } catch (cause) {
      setError(errorMessage(cause, t('settings.aiProviders.loadFail')))
    }
  }, [refreshAgentCatalog, t])

  useEffect(() => {
    void load()
  }, [load])

  const selectedPreset = form ? getProviderPreset(form.presetId) : null
  const configuredPresetIds = new Set(providers.map((provider) => provider.presetId))
  const popularPresets = PROVIDER_PRESETS.filter((preset) => preset.popular)
  const morePresets = PROVIDER_PRESETS.filter(
    (preset) => !preset.popular && preset.id !== 'custom'
  )

  const selectedModelInfo = useMemo(() => {
    if (!form?.model) return null
    return models.find((model) => model.id === form.model) ?? null
  }, [form?.model, models])

  const reasoningEfforts = useMemo(() => {
    if (!form) return []
    if (selectedModelInfo) return selectedModelInfo.reasoningEfforts
    const fromModel = reasoningEffortsForModel(form.presetId, form.model)
    if (fromModel.length > 0 || (form.model.trim() && form.presetId !== 'custom')) {
      return fromModel
    }
    return getProviderPreset(form.presetId).reasoningEfforts
  }, [form, selectedModelInfo])

  const filteredModels = useMemo(() => {
    const selectedModels = (form?.models ?? [])
      .filter((model) => !models.some((candidate) => candidate.id === model))
      .map((model) => ({
        id: model,
        providerName: form?.name,
        supportsVariants: false,
        ...inferModelCapabilities(form?.presetId ?? 'custom', model)
      }))
    const availableModels = [...selectedModels, ...models]
    const query = modelFilter.trim().toLowerCase()
    return query
      ? availableModels.filter((model) => model.id.toLowerCase().includes(query))
      : availableModels
  }, [form?.models, form?.name, form?.presetId, modelFilter, models])

  const manualModelId = modelFilter.trim()
  const canAddManualModel = !!form &&
    !!manualModelId &&
    !form.models?.includes(manualModelId) &&
    (form.presetId === 'custom' || (!loadingModels && models.length === 0))

  const openPreset = (preset: ProviderPreset) => {
    modelRequestGenerationRef.current += 1
    const next = formFromPreset(preset)
    formRef.current = next
    setForm(next)
    setModels([])
    setLoadingModels(false)
    setModelFilter('')
    setShowAdvanced(preset.id === 'custom')
    setError(null)
  }

  const fetchModels = async (current: ProviderForm): Promise<ProviderModelInfo[] | null> => {
    const generation = ++modelRequestGenerationRef.current
    const requestIdentity = [
      current.id ?? '',
      current.presetId,
      current.baseUrl.trim(),
      current.apiKey.trim()
    ].join('\u0000')
    const isCurrent = () => {
      const active = formRef.current
      if (!active || modelRequestGenerationRef.current !== generation) return false
      return [
        active.id ?? '',
        active.presetId,
        active.baseUrl.trim(),
        active.apiKey.trim()
      ].join('\u0000') === requestIdentity
    }
    setLoadingModels(true)
    setError(null)
    try {
      const result = await api.aiProviders.listModels({
        providerId: current.id ?? undefined,
        presetId: current.presetId,
        baseUrl: current.baseUrl.trim() || undefined,
        apiKey: current.apiKey.trim() || undefined
      })
      if (!isCurrent()) return null
      if (!result.ok) {
        setModels([])
        setError(result.error || t('settings.aiProviders.modelsFetchFail'))
        return null
      }
      setModels(result.models)
      return result.models
    } catch (cause) {
      if (!isCurrent()) return null
      setModels([])
      setError(errorMessage(cause, t('settings.aiProviders.modelsFetchFail')))
      return null
    } finally {
      if (modelRequestGenerationRef.current === generation) setLoadingModels(false)
    }
  }

  const openEdit = (provider: AiProvider) => {
    const next = formFromProvider(provider)
    modelRequestGenerationRef.current += 1
    formRef.current = next
    setForm(next)
    setModels([])
    setModelFilter('')
    setShowAdvanced(true)
    setError(null)
    void fetchModels(next)
  }

  const closeForm = () => {
    modelRequestGenerationRef.current += 1
    formRef.current = null
    setForm(null)
    setModels([])
    setLoadingModels(false)
    setModelFilter('')
    setError(null)
  }
  const dialogRef = useModalDialog<HTMLDivElement>(!!form, closeForm)

  const toggleModel = (model: string) => {
    if (!form) return
    const selected = form.models ?? []
    const next = selected.includes(model)
      ? selected.filter((candidate) => candidate !== model)
      : [...selected, model]
    setForm({
      ...form,
      model: next.includes(form.model) ? form.model : next[0] ?? form.model,
      models: next.length > 0 ? next : null
    })
  }

  const addManualModel = () => {
    if (!form || !canAddManualModel) return
    const selected = form.models ?? []
    setForm({
      ...form,
      model: selected.length > 0 ? form.model : manualModelId,
      models: [...selected, manualModelId]
    })
    setModelFilter('')
  }

  const save = async () => {
    if (!form || !selectedPreset) return
    if (!form.name.trim() || !form.baseUrl.trim()) {
      setError(t('settings.aiProviders.requiredProviderFields'))
      return
    }
    if (selectedPreset.apiKeyRequired && !form.apiKey.trim() && !form.id) {
      setError(t('settings.aiProviders.apiKeyRequired'))
      return
    }

    setSaving(true)
    setError(null)
    try {
      const modelIds = models.map((model) => model.id)
      const model = form.models?.includes(form.model.trim())
        ? form.model.trim()
        : form.models?.[0] || form.model.trim() || pickDefaultModel(selectedPreset, modelIds)
      if (!model) {
        setError(t('settings.aiProviders.modelRequired'))
        return
      }
      const savedModelInfo = models.find((candidate) => candidate.id === model)
      const inferredReasoningEfforts = reasoningEffortsForModel(form.presetId, model)
      const allowedReasoningEfforts = savedModelInfo
        ? savedModelInfo.reasoningEfforts
        : inferredReasoningEfforts.length > 0 || (model && form.presetId !== 'custom')
          ? inferredReasoningEfforts
          : selectedPreset.reasoningEfforts
      const reasoningEffort = form.reasoningControl === 'none'
        ? 'none'
        : allowedReasoningEfforts.includes(form.reasoningEffort)
          ? form.reasoningEffort
          : allowedReasoningEfforts[0] ?? form.reasoningEffort

      const payload = {
        presetId: form.presetId,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        apiProtocol: form.apiProtocol,
        reasoningControl: form.reasoningControl,
        reasoningEffort,
        model,
        models: form.models,
        baseModel: model,
        variant: '',
        variantFormat: 'none' as const,
        temperature: parseOptionalNumber(form.temperature),
        maxTokens: parseOptionalNumber(form.maxTokens),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
      }

      if (form.id) {
        await api.aiProviders.update(form.id, payload)
      } else {
        await api.aiProviders.create(payload)
      }
      closeForm()
      await load()
    } catch (cause) {
      const code = (cause as { code?: string }).code
      setError(
        code === 'encryption_unavailable'
          ? t('settings.aiProviders.encryptionUnavailable')
          : errorMessage(cause, t('settings.aiProviders.saveFail'))
      )
    } finally {
      setSaving(false)
    }
  }

  const testProvider = async (provider: AiProvider) => {
    setTestStates((state) => ({ ...state, [provider.id]: 'testing' }))
    try {
      const result = await api.aiProviders.test(provider.id)
      setTestStates((state) => ({
        ...state,
        [provider.id]: { ok: result.ok, count: result.models?.length ?? 0 }
      }))
    } catch {
      setTestStates((state) => ({ ...state, [provider.id]: { ok: false, count: 0 } }))
    }
  }

  const removeProvider = async (provider: AiProvider) => {
    let deleted = false
    try {
      const profile = useAgentCatalogStore.getState().profiles.find(
        (candidate) => candidate.apiProviderId === provider.id
      )
      await api.aiProviders.delete(provider.id)
      deleted = true
      removeCatalogProvider(provider.id)
      if (formRef.current?.id === provider.id) closeForm()
      await cleanupDeletedAgentSelections({ providerId: provider.id, profileId: profile?.id })
      await load()
    } catch (cause) {
      if (deleted) {
        await load().catch(() => undefined)
        setError(t('settings.aiProviders.deleteCleanupFail'))
      } else {
        setError(errorMessage(cause, t('settings.aiProviders.deleteFail')))
      }
    }
  }

  const renderPresetRows = (presets: readonly ProviderPreset[]) => (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      {presets.map((preset, index) => {
        const configured = configuredPresetIds.has(preset.id)
        return (
          <div
            key={preset.id}
            className={`flex items-center gap-3 px-3 py-3 ${index > 0 ? 'border-t border-border-secondary' : ''}`}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel-2">
              <ProviderIcon presetId={preset.id} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                {preset.name}
                {configured && (
                  <Badge variant="accent" size="sm" subtle>
                    {t('settings.aiProviders.configured')}
                  </Badge>
                )}
              </span>
              <span className="mt-0.5 block text-label text-muted">
                {t(`settings.aiProviders.providers.${preset.id}`, preset.description)}
              </span>
            </span>
            <Button
              variant={configured ? 'ghost' : 'secondary'}
              size="md"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => openPreset(preset)}
            >
              {configured
                ? t('settings.aiProviders.addAnother')
                : t('settings.aiProviders.connect')}
            </Button>
          </div>
        )
      })}
    </div>
  )

  const selectedCapabilities = form
    ? selectedModelInfo ?? {
        id: form.model,
        providerName: form.name,
        supportsVariants: false,
        ...inferModelCapabilities(form.presetId, form.model)
      }
    : null

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h4 className="text-sm font-semibold text-foreground">
          {t('settings.aiProviders.title')}
        </h4>
        <p className="mt-0.5 text-label text-muted">{t('settings.aiProviders.desc')}</p>
      </div>

      {providers.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-label font-medium text-muted">
            {t('settings.aiProviders.configuredProviders')}
          </span>
          <div className="flex flex-col gap-2">
            {providers.map((provider) => {
              const state = testStates[provider.id]
              return (
                <div
                  key={provider.id}
                  className="flex items-center gap-3 rounded-xl border border-border bg-panel-2 px-3 py-2.5"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background">
                    <ProviderIcon presetId={provider.presetId} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                      {provider.name}
                    </span>
                    <span className="mt-0.5 block truncate text-label text-muted">
                      {provider.models?.length
                        ? provider.models.join(' · ')
                        : t('settings.aiProviders.allModels')}
                    </span>
                    {state && state !== 'testing' && (
                      <span className={`text-label ${state.ok ? 'text-success' : 'text-error'}`}>
                        {state.ok
                          ? t('settings.aiProviders.testOk', { count: state.count })
                          : t('settings.aiProviders.testFail')}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      loading={state === 'testing'}
                      title={t('settings.aiProviders.test')}
                      onClick={() => void testProvider(provider)}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      title={t('settings.aiProviders.edit')}
                      onClick={() => openEdit(provider)}
                    >
                      <PencilSimple className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      className="text-error"
                      title={t('settings.aiProviders.delete')}
                      onClick={() => void removeProvider(provider)}
                    >
                      <Trash className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-label font-medium text-muted">
          {t('settings.aiProviders.popularProviders')}
        </span>
        {renderPresetRows(popularPresets)}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-label font-medium text-muted">
          {t('settings.aiProviders.moreProviders')}
        </span>
        {renderPresetRows(morePresets)}
      </div>

      <button
        type="button"
        className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-panel-2 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-hover"
        onClick={() => openPreset(getProviderPreset('custom'))}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-background text-muted">
          <Plus className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-foreground">
            {t('settings.aiProviders.customProvider')}
          </span>
          <span className="mt-0.5 block text-label text-muted">
            {t('settings.aiProviders.providers.custom')}
          </span>
        </span>
      </button>

      {error && !form && (
        <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{error}</div>
      )}

      {form && selectedPreset && (
        <div
          ref={dialogRef}
          className="dialog-overlay z-[1000]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-dialog-title"
          tabIndex={-1}
        >
          <div className="dialog-panel flex max-h-[min(760px,calc(100vh-48px))] w-[min(620px,calc(100vw-48px))] flex-col gap-4 overflow-hidden p-0">
            <div className="flex items-start gap-3 border-b border-border px-5 py-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-panel-2">
                <ProviderIcon presetId={selectedPreset.id} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <h3 id="provider-dialog-title" className="text-sm font-semibold text-foreground">
                  {form.id
                    ? t('settings.aiProviders.editProvider', { name: form.name })
                    : form.presetId === 'custom'
                      ? t('settings.aiProviders.customProvider')
                      : t('settings.aiProviders.connectProvider', { name: selectedPreset.name })}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {t(`settings.aiProviders.providers.${selectedPreset.id}`, selectedPreset.description)}
                </p>
              </span>
              <Button variant="ghost" size="sm" iconOnly onClick={closeForm} title={t('common.cancel')}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex flex-col gap-4 overflow-y-auto px-5">
              {form.presetId === 'custom' && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
                    <span className="text-xs font-medium text-foreground">
                      {t('settings.aiProviders.name')}
                    </span>
                    <Input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      placeholder={t('settings.aiProviders.customNamePlaceholder')}
                    />
                  </label>
                  <label className="col-span-2 flex flex-col gap-1.5 sm:col-span-1">
                    <span className="text-xs font-medium text-foreground">
                      {t('settings.aiProviders.providerApi')}
                    </span>
                    <select
                      className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                      value={form.apiProtocol}
                      onChange={(event) =>
                        setForm({ ...form, apiProtocol: event.target.value as AiApiProtocol })
                      }
                    >
                      {PROTOCOL_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="col-span-2 flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {t('settings.aiProviders.baseUrl')}
                    </span>
                    <Input
                      value={form.baseUrl}
                      onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                      placeholder="https://api.example.com/v1"
                    />
                  </label>
                </div>
              )}

              {selectedPreset.apiKeyRequired || form.presetId === 'custom' ? (
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t('settings.aiProviders.apiKey')}
                    {form.id && (
                      <span className="ml-1 font-normal text-muted">
                        {t('settings.aiProviders.apiKeyHint')}
                      </span>
                    )}
                  </span>
                  <Input
                    type="password"
                    value={form.apiKey}
                    onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                    placeholder={form.id ? '••••••••' : 'sk-…'}
                    autoFocus={form.presetId !== 'custom'}
                  />
                  {form.presetId === 'custom' && (
                    <span className="text-label text-muted">
                      {t('settings.aiProviders.apiKeyOptional')}
                    </span>
                  )}
                </label>
              ) : (
                <div className="rounded-xl border border-border bg-panel-2 px-3 py-2.5 text-xs leading-relaxed text-muted">
                  {form.presetId === 'ollama-cloud'
                    ? t('settings.aiProviders.ollamaCloudHint')
                    : t('settings.aiProviders.ollamaLocalHint')}
                </div>
              )}

              <button
                type="button"
                className="flex items-center justify-between rounded-lg py-1 text-left text-xs font-medium text-foreground"
                onClick={() => setShowAdvanced((value) => !value)}
                aria-expanded={showAdvanced}
              >
                {t('settings.aiProviders.advancedSettings')}
                <CaretDown className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              </button>

              {showAdvanced && (
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel-2 p-3">
                  {form.presetId !== 'custom' && (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-label font-medium text-muted">
                        {t('settings.aiProviders.baseUrl')}
                      </span>
                      <Input
                        value={form.baseUrl}
                        onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                      />
                    </label>
                  )}

                  <div className="flex flex-col gap-1.5">
                    <span className="text-label font-medium text-muted">
                      {t('settings.aiProviders.model')}
                    </span>
                    <span className="text-label leading-relaxed text-text-tertiary">
                      {t('settings.aiProviders.modelSelectionHint')}
                    </span>
                    <div className="flex items-center gap-2">
                      <Input
                        value={modelFilter}
                        onChange={(event) => setModelFilter(event.target.value)}
                        placeholder={t('settings.aiProviders.searchModels')}
                        onPressEnter={addManualModel}
                      />
                      <Button
                        variant="secondary"
                        size="md"
                        loading={loadingModels}
                        onClick={() => void fetchModels(form)}
                      >
                        {t('settings.aiProviders.fetchModels')}
                      </Button>
                    </div>
                    <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-background p-1">
                      <button
                        type="button"
                        role="option"
                        aria-selected={form.models == null}
                        className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover ${
                          form.models == null ? 'bg-active' : ''
                        }`}
                        onClick={() => setForm({ ...form, models: null })}
                      >
                        <span className="min-w-0 flex-1 text-xs text-foreground">
                          {t('settings.aiProviders.allModels')}
                        </span>
                        {form.models == null && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                      </button>

                      {filteredModels.map((model) => {
                        const selected = form.models?.includes(model.id) === true
                        return (
                          <button
                            key={model.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover ${
                              selected ? 'bg-active' : ''
                            }`}
                            onClick={() => toggleModel(model.id)}
                          >
                            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                              {model.id}
                            </span>
                            <CapabilityBadges model={model} />
                            {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                          </button>
                        )
                      })}

                      {canAddManualModel && (
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
                          onClick={addManualModel}
                        >
                          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                            {manualModelId}
                          </span>
                          <span className="text-caption text-muted">
                            {t('settings.aiProviders.addModel')}
                          </span>
                        </button>
                      )}

                      {filteredModels.length === 0 && models.length === 0 && !canAddManualModel && (
                        <div className="px-3 py-6 text-center text-xs text-muted">
                          {loadingModels
                            ? t('settings.aiProviders.loadingModels')
                            : t('settings.aiProviders.modelsNotLoaded')}
                        </div>
                      )}

                      {models.length > 0 && filteredModels.length === 0 && !canAddManualModel && (
                        <div className="px-3 py-6 text-center text-xs text-muted">
                          {t('settings.aiProviders.noModelMatch')}
                        </div>
                      )}
                    </div>
                  </div>

                  {selectedCapabilities && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background px-2.5 py-2 text-label text-muted">
                      <CapabilityBadges model={selectedCapabilities} />
                      <span className="truncate">{form.model || t('settings.aiProviders.noModelSelected')}</span>
                      {selectedCapabilities.supportedParameters.length > 0 && (
                        <span className="truncate text-text-tertiary">
                          {selectedCapabilities.supportedParameters.join(' · ')}
                        </span>
                      )}
                    </div>
                  )}

                  {form.presetId === 'custom' && (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-label font-medium text-muted">
                        {t('settings.aiProviders.reasoningControl')}
                      </span>
                      <select
                        className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                        value={form.reasoningControl}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            reasoningControl: event.target.value as AiReasoningControl
                          })
                        }
                      >
                        {REASONING_CONTROL_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {t(option.labelKey)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {reasoningEfforts.length > 0 && form.reasoningControl !== 'none' && (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-label font-medium text-muted">
                        {t('settings.aiProviders.reasoningEffort')}
                      </span>
                      <select
                        className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                        value={reasoningEfforts.includes(form.reasoningEffort) ? form.reasoningEffort : reasoningEfforts[0]}
                        onChange={(event) =>
                          setForm({ ...form, reasoningEffort: event.target.value as AiReasoningEffort })
                        }
                      >
                        {reasoningEfforts.map((effort) => (
                          <option key={effort} value={effort}>
                            {t(`settings.aiProviders.effort.${effort}`, effort)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-label font-medium text-muted">
                        {t('settings.aiProviders.temperature')}
                      </span>
                      <Input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={form.temperature}
                        onChange={(event) => setForm({ ...form, temperature: event.target.value })}
                        placeholder={t('settings.aiProviders.providerDefault')}
                      />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-label font-medium text-muted">
                        {t('settings.aiProviders.maxTokens')}
                      </span>
                      <Input
                        type="number"
                        min="1"
                        value={form.maxTokens}
                        onChange={(event) => setForm({ ...form, maxTokens: event.target.value })}
                        placeholder={t('settings.aiProviders.providerDefault')}
                      />
                    </label>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{error}</div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
              <Button variant="ghost" size="md" onClick={closeForm}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="md" loading={saving} onClick={() => void save()}>
                {form.id ? t('common.save') : t('settings.aiProviders.connect')}
              </Button>
            </div>
          </div>

        </div>
      )}
    </section>
  )
}
