import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvider, ProviderModelInfo } from '../../src/shared/ipc-types'
import ModelSelector from '../../src/renderer/components/workspace/ModelSelector'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key
  })
}))

vi.mock('../../src/renderer/hooks/useClickOutside', () => ({
  useClickOutside: vi.fn()
}))

const provider: AiProvider = {
  id: 'provider-1',
  presetId: 'openai',
  name: 'Provider One',
  baseUrl: 'https://api.example.com',
  apiProtocol: 'openai-responses',
  reasoningControl: 'openai',
  reasoningEffort: 'medium',
  model: 'gpt-5-high',
  models: ['gpt-5-high', 'model-beta'],
  baseModel: 'gpt-5',
  variant: 'high',
  variantFormat: 'dash',
  hasKey: true,
  temperature: null,
  maxTokens: null,
  createdAt: 0
}

const providerModel: ProviderModelInfo = {
  id: 'model-alpha',
  supportsVariants: true,
  supportsReasoning: true,
  reasoningEfforts: ['low', 'high'],
  supportsVision: true,
  supportsTools: true,
  supportedParameters: []
}

const defaultProps: React.ComponentProps<typeof ModelSelector> = {
  providers: [provider],
  activeProviderId: provider.id,
  selectedModel: 'gpt-5',
  selectedVariant: 'high',
  providerModels: { [provider.id]: [providerModel] },
  loadingModels: false,
  reasoningEffort: 'medium',
  requestModel: 'gpt-5-high',
  streaming: false,
  onApplyModel: vi.fn().mockResolvedValue(undefined),
  onReasoningEffortChange: vi.fn()
}

function renderSelector(overrides: Partial<React.ComponentProps<typeof ModelSelector>> = {}) {
  return render(<ModelSelector {...defaultProps} {...overrides} />)
}

describe('ModelSelector', () => {
  beforeEach(() => {
    defaultProps.onApplyModel = vi.fn().mockResolvedValue(undefined)
    defaultProps.onReasoningEffortChange = vi.fn()
  })

  afterEach(cleanup)

  it('disables model selection and hides reasoning effort without configured providers', () => {
    renderSelector({ providers: [], requestModel: '' })
    expect(screen.getByRole('button', { name: 'Select model / provider' })).toBeDisabled()
    expect(screen.getByText('Not configured')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reasoning effort' })).not.toBeInTheDocument()
  })

  it('shows only explicitly configured provider models and applies one', async () => {
    const user = userEvent.setup()
    renderSelector()
    const trigger = screen.getByRole('button', { name: 'Select model / provider' })
    expect(trigger).toHaveTextContent('gpt-5-high')
    expect(trigger).toHaveTextContent('API')
    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: 'Provider One/gpt-5-high' }))

    expect(defaultProps.onApplyModel).toHaveBeenCalledWith('gpt-5', 'high', 'provider-1')
    expect(screen.queryByRole('option', { name: 'Provider One/model-alpha' })).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('shows all fetched models when a provider has no explicit model list', async () => {
    const user = userEvent.setup()
    renderSelector({
      providers: [{ ...provider, models: null }],
      providerModels: {
        [provider.id]: [
          providerModel,
          { ...providerModel, id: 'model-beta', supportsVariants: false }
        ]
      }
    })

    const trigger = screen.getByRole('button', { name: 'Select model / provider' })
    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: 'Provider One/model-alpha' }))
    expect(defaultProps.onApplyModel).toHaveBeenCalledWith('model-alpha', '', 'provider-1')
  })

  it('makes the active CLI model and runtime type explicit', async () => {
    const user = userEvent.setup()
    const cliProvider: AiProvider = {
      ...provider,
      presetId: 'codex-cli',
      name: 'OpenAI Codex CLI',
      model: 'default',
      models: null,
      baseModel: 'default',
      variant: '',
      variantFormat: 'none'
    }
    renderSelector({
      providers: [cliProvider],
      activeProviderId: cliProvider.id,
      selectedModel: 'default',
      selectedVariant: '',
      requestModel: 'default',
      providerModels: {
        [cliProvider.id]: [
          {
            ...providerModel,
            id: 'default',
            providerName: 'CLI default (GPT-5.6-Luna)',
            supportsVariants: false
          },
          {
            ...providerModel,
            id: 'gpt-5.6-luna',
            providerName: 'GPT-5.6-Luna',
            defaultReasoningEffort: 'low',
            supportsVariants: false
          }
        ]
      }
    })

    const trigger = screen.getByRole('button', { name: 'Select model / provider' })
    expect(trigger).toHaveTextContent('CLI default (GPT-5.6-Luna)')
    expect(trigger).toHaveTextContent('CLI')
    expect(trigger).toHaveAttribute('title', 'OpenAI Codex CLI · default')
    await user.click(trigger)

    expect(screen.getByText('Choose model')).toBeInTheDocument()
    expect(screen.getByText('GPT-5.6-Luna')).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'OpenAI Codex CLI/gpt-5.6-luna' }))
    expect(defaultProps.onApplyModel).toHaveBeenCalledWith('gpt-5.6-luna', '', 'provider-1')
  })

  it('does not expose a custom model id input in chat', async () => {
    const user = userEvent.setup()
    renderSelector()
    await user.click(screen.getByRole('button', { name: 'Select model / provider' }))

    expect(screen.queryByPlaceholderText('model-id')).not.toBeInTheDocument()
    expect(screen.queryByText('Custom model')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
  })

  it('applies explicit variants and switches reasoning effort without a visible prefix', async () => {
    const user = userEvent.setup()
    renderSelector({ reasoningEffort: 'high' })

    const modelButton = screen.getByRole('button', { name: 'Select model / provider' })
    const effortButton = screen.getByRole('button', { name: 'Reasoning effort' })
    expect(effortButton).toHaveTextContent('high')
    expect(screen.queryByText('Reasoning effort')).not.toBeInTheDocument()
    expect(effortButton).toHaveClass('rounded-lg', 'px-2', 'py-1', 'text-label', 'hover:bg-hover')
    expect(modelButton).toHaveClass('rounded-lg', 'px-2', 'py-1', 'text-label', 'hover:bg-hover')
    expect(modelButton.parentElement).toHaveClass('min-w-0', 'flex-1', 'justify-end')
    expect(modelButton).toHaveClass('w-full', 'min-w-0', 'max-w-[230px]')
    expect(effortButton.parentElement).toHaveClass('min-w-0', 'max-w-[112px]', 'shrink-0')
    expect(effortButton).toHaveClass('min-w-0', 'max-w-full')
    expect(modelButton.querySelector('span')).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(effortButton.querySelector('span')).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.click(effortButton)
    expect(screen.queryByRole('option', { name: 'none' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'low' }))
    expect(defaultProps.onReasoningEffortChange).toHaveBeenCalledWith('low')

    await user.click(screen.getByRole('button', { name: 'Select model / provider' }))
    await user.click(screen.getByRole('button', { name: 'xhigh' }))
    expect(defaultProps.onApplyModel).toHaveBeenCalledWith('gpt-5', 'xhigh', 'provider-1')
  })

  it('supports keyboard navigation and Escape in the model list', async () => {
    const user = userEvent.setup()
    renderSelector()
    await user.click(screen.getByRole('button', { name: 'Select model / provider' }))

    const listbox = screen.getByRole('listbox')
    const options = screen.getAllByRole('option')
    options[0].focus()
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    expect(options[1]).toHaveFocus()
    fireEvent.keyDown(listbox, { key: 'ArrowUp' })
    expect(options[0]).toHaveFocus()
    fireEvent.keyDown(listbox, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
