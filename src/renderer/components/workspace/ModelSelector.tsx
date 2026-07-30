import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CaretDown, Check } from '@phosphor-icons/react'
import { useClickOutside } from '../../hooks/useClickOutside'
import {
  COMMON_VARIANTS,
  parseModelId,
  supportsModelVariants
} from '../../../shared/modelVariant'
import {
  getProviderPreset,
  reasoningEffortsForModel
} from '../../../shared/providerCatalog'
import type {
  AiProvider,
  AiReasoningEffort,
  ProviderModelInfo
} from '../../../shared/ipc-types'

export interface ModelSelectorProps {
  providers: AiProvider[]
  activeProviderId: string
  selectedModel: string
  selectedVariant: string
  providerModels: Record<string, ProviderModelInfo[]>
  loadingModels: boolean
  reasoningEffort: AiReasoningEffort
  requestModel: string
  streaming: boolean
  onApplyModel: (baseModel: string, variant?: string, providerId?: string) => Promise<void>
  onReasoningEffortChange: (effort: AiReasoningEffort) => void
}

const REASONING_EFFORT_ORDER: AiReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

function modelsForProvider(
  provider: AiProvider,
  providerModels: Record<string, ProviderModelInfo[]>
): string[] {
  const fetched = providerModels[provider.id] ?? []
  const models = provider.models?.length
    ? provider.models
    : fetched.map((model) => model.id)
  const fallback = provider.baseModel || provider.model
  const available = models.length > 0 ? models : [fallback]
  return available.filter(
    (model, index, all) => model.trim().length > 0 && all.indexOf(model) === index
  )
}

export default function ModelSelector({
  providers,
  activeProviderId,
  selectedModel,
  selectedVariant,
  providerModels,
  loadingModels,
  reasoningEffort,
  requestModel,
  streaming,
  onApplyModel,
  onReasoningEffortChange
}: ModelSelectorProps) {
  const { t } = useTranslation()
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const reasoningMenuRef = useRef<HTMLDivElement | null>(null)

  useClickOutside(menuRef, () => setModelMenuOpen(false), modelMenuOpen)
  useClickOutside(
    reasoningMenuRef,
    () => setReasoningMenuOpen(false),
    reasoningMenuOpen
  )

  const activeProvider = providers.find((provider) => provider.id === activeProviderId)
  const selectedModelInfo = (providerModels[activeProviderId] ?? []).find(
    (model) => model.id === requestModel || model.id === selectedModel
  )
  const variantCapable =
    supportsModelVariants(selectedModel) || selectedModelInfo?.supportsVariants === true
  const displayModelLabel = providers.length === 0
    ? t('workspace.chat.notConfigured', 'Not configured')
    : activeProvider && (requestModel || activeProvider.model)
      ? `${activeProvider.name}/${requestModel || activeProvider.model}`
      : t('workspace.chat.selectProvider', 'Select model / provider')
  const reasoningEffortLabel = t('workspace.chat.reasoningEffort', 'Reasoning effort')
  const reasoningEffortValue = t(
    `settings.aiProviders.effort.${reasoningEffort}`,
    reasoningEffort
  )
  const inferredReasoningEfforts = activeProvider
    ? reasoningEffortsForModel(activeProvider.presetId, requestModel || selectedModel)
    : []
  const availableReasoningEfforts = activeProvider?.reasoningControl === 'none'
    ? ['none' as const]
    : selectedModelInfo?.reasoningEfforts.length
      ? selectedModelInfo.reasoningEfforts
      : inferredReasoningEfforts.length
        ? inferredReasoningEfforts
        : activeProvider
          ? getProviderPreset(activeProvider.presetId).reasoningEfforts
          : []
  const allowedReasoningEfforts = new Set<AiReasoningEffort>([
    ...availableReasoningEfforts.filter(
      (effort) => effort !== 'none' || activeProvider?.reasoningControl === 'none'
    ),
    ...(reasoningEffort !== 'none' || activeProvider?.reasoningControl === 'none'
      ? [reasoningEffort]
      : [])
  ])
  const reasoningEffortOptions = REASONING_EFFORT_ORDER.filter((effort) =>
    allowedReasoningEfforts.has(effort)
  )

  const handleApply = (baseModel: string, variant = '', providerId?: string) => {
    void onApplyModel(baseModel, variant, providerId)
    setModelMenuOpen(false)
  }

  return (
    <>
      <div className="relative flex min-w-0 flex-1 justify-end" ref={menuRef}>
        <button
          type="button"
          className="inline-flex w-full min-w-0 max-w-[200px] items-center gap-1 rounded-lg px-2 py-1 text-label text-foreground transition-colors duration-150 hover:bg-hover disabled:opacity-40"
          onClick={() => {
            setReasoningMenuOpen(false)
            setModelMenuOpen((value) => !value)
          }}
          disabled={providers.length === 0 || streaming}
          aria-label={t('workspace.chat.selectProvider', 'Select model / provider')}
          aria-expanded={modelMenuOpen}
          aria-haspopup="listbox"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{displayModelLabel}</span>
          <CaretDown className="h-3 w-3 shrink-0 text-muted" />
        </button>

        {modelMenuOpen && (
          <div
            className="absolute bottom-full right-0 z-50 mb-1 max-h-72 w-72 overflow-y-auto rounded-xl border border-border bg-panel p-2 shadow-lg"
            role="listbox"
            tabIndex={0}
            onKeyDown={(event) => {
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]')
              )
              const currentIndex = buttons.findIndex((button) => button === document.activeElement)
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                const next = buttons[Math.min(currentIndex + 1, buttons.length - 1)] ?? buttons[0]
                next?.focus()
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                const previous = buttons[Math.max(currentIndex - 1, 0)] ?? buttons[0]
                previous?.focus()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setModelMenuOpen(false)
              }
            }}
          >
            {providers.map((provider, index) => {
              const configuredModels = modelsForProvider(provider, providerModels)
              return (
                <div key={provider.id} className={index > 0 ? 'mt-2' : ''}>
                  <p className="px-1 pb-1 text-caption font-semibold uppercase tracking-wide text-muted">
                    {provider.name}
                    {loadingModels && provider.models == null ? '…' : ''}
                  </p>
                  {configuredModels.map((model) => {
                    const parsed = parseModelId(model)
                    const baseModel = parsed.baseModel || model
                    const selected =
                      provider.id === activeProviderId &&
                      baseModel === selectedModel &&
                      parsed.variant === selectedVariant
                    return (
                      <button
                        key={`${provider.id}-${model}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-hover ${
                          selected ? 'bg-active' : ''
                        }`}
                        onClick={() => handleApply(baseModel, parsed.variant, provider.id)}
                      >
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                          {provider.name}/{model}
                        </span>
                        {selected && <Check className="h-3 w-3 shrink-0 text-accent" />}
                      </button>
                    )
                  })}
                </div>
              )
            })}

            {variantCapable && (
              <>
                <p className="mt-2 px-1 pb-1 text-caption font-semibold uppercase tracking-wide text-muted">
                  {t('workspace.chat.variant', 'Variant')}
                </p>
                <div className="flex flex-wrap gap-1 px-1 pb-1">
                  <button
                    type="button"
                    className={`rounded-md border px-2 py-0.5 text-caption ${
                      !selectedVariant
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-muted'
                    }`}
                    onClick={() => handleApply(selectedModel, '', activeProviderId)}
                  >
                    {t('settings.aiProviders.variantNone', 'None (base only)')}
                  </button>
                  {COMMON_VARIANTS.map((variant) => (
                    <button
                      key={variant}
                      type="button"
                      className={`rounded-md border px-2 py-0.5 text-caption ${
                        selectedVariant === variant
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border text-muted'
                      }`}
                      onClick={() => handleApply(selectedModel, variant, activeProviderId)}
                    >
                      {variant}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {activeProvider && (
        <div className="relative min-w-0 max-w-[112px] shrink-0" ref={reasoningMenuRef}>
          <button
            type="button"
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg px-2 py-1 text-label text-foreground transition-colors duration-150 hover:bg-hover disabled:opacity-40"
            aria-label={reasoningEffortLabel}
            aria-expanded={reasoningMenuOpen}
            aria-haspopup="listbox"
            title={`${reasoningEffortLabel}: ${reasoningEffortValue}`}
            disabled={streaming}
            onClick={() => {
              setModelMenuOpen(false)
              setReasoningMenuOpen((value) => !value)
            }}
          >
            <span className="min-w-0 flex-1 truncate font-medium">{reasoningEffortValue}</span>
            <CaretDown className="h-3 w-3 shrink-0 text-muted" />
          </button>

          {reasoningMenuOpen && (
            <div
              className="absolute bottom-full right-0 z-50 mb-1 min-w-32 rounded-xl border border-border bg-panel p-2 shadow-lg"
              role="listbox"
              tabIndex={0}
              onKeyDown={(event) => {
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    'button[role="option"]'
                  )
                )
                const currentIndex = buttons.findIndex(
                  (button) => button === document.activeElement
                )
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  const next =
                    buttons[Math.min(currentIndex + 1, buttons.length - 1)] ?? buttons[0]
                  next?.focus()
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  const previous = buttons[Math.max(currentIndex - 1, 0)] ?? buttons[0]
                  previous?.focus()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setReasoningMenuOpen(false)
                }
              }}
            >
              {reasoningEffortOptions.map((effort) => {
                const selected = effort === reasoningEffort
                return (
                  <button
                    key={effort}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`mb-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-hover ${
                      selected ? 'bg-active' : ''
                    }`}
                    onClick={() => {
                      onReasoningEffortChange(effort)
                      setReasoningMenuOpen(false)
                    }}
                  >
                    <span className="text-xs text-foreground">
                      {t(`settings.aiProviders.effort.${effort}`, effort)}
                    </span>
                    {selected && <Check className="h-3 w-3 shrink-0 text-accent" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </>
  )
}
