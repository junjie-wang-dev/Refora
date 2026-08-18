import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReforaApi } from '../../src/shared/ipc-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      ({
        'settings.modelSettings.tabsLabel': 'Model connection type',
        'settings.modelSettings.cli': 'Local CLI',
        'settings.modelSettings.api': 'API providers',
        'settings.agentProfiles.title': 'Local CLI agents',
        'settings.agentProfiles.desc': 'Detected CLI agents',
        'settings.agentProfiles.rescan': 'Scan again',
        'settings.agentProfiles.addCli': 'Add CLI agent',
        'settings.agentProfiles.configure': 'Configure',
        'settings.agentProfiles.addAnotherRuntime': 'Add another',
        'settings.agentProfiles.notFound': 'Executable not found',
        'settings.agentProfiles.modelCount': 'Model options',
        'settings.agentProfiles.cliHint': 'Local CLI hint',
        'settings.agentProfiles.name': 'Name',
        'settings.agentProfiles.runtime': 'CLI runtime',
        'settings.agentProfiles.executable': 'Executable path',
        'settings.agentProfiles.detectedPath': 'Detected path',
        'settings.agentProfiles.model': 'Model',
        'settings.agentProfiles.reasoning': 'Reasoning effort',
        'settings.agentProfiles.reasoningManaged': 'Managed automatically by Gemini CLI',
        'settings.agentProfiles.searchPolicy': 'Web search policy',
        'settings.agentProfiles.nativeSearchAvailable': 'Native Web search available',
        'settings.agentProfiles.status.ready': 'Ready',
        'settings.agentProfiles.status.missing': 'Not installed',
        'settings.agentProfiles.search.auto': 'Automatic',
        'settings.agentProfiles.search.native': 'Provider native',
        'settings.agentProfiles.search.refora': 'Refora search',
        'settings.agentProfiles.search.disabled': 'Disabled',
        'settings.aiProviders.effort.low': 'Low',
        'settings.aiProviders.effort.medium': 'Medium',
        'settings.aiProviders.effort.high': 'High',
        'settings.aiProviders.effort.xhigh': 'Extra high',
        'settings.aiProviders.effort.max': 'Maximum',
        'settings.aiProviders.effort.ultra': 'Ultra',
        'common.cancel': 'Cancel',
        'common.save': 'Save'
      } as Record<string, string>)[key] ?? (typeof fallback === 'string' ? fallback : key)
  })
}))

vi.mock('../../src/renderer/components/AiProvidersSection', () => ({
  AiProvidersSection: () => <h2>API settings</h2>
}))

const { ModelSettingsSection } = await import(
  '../../src/renderer/components/ModelSettingsSection'
)

const api = (window as unknown as { api: ReforaApi }).api

describe('ModelSettingsSection', () => {
  beforeEach(() => {
    api.agentProfiles.list = vi.fn().mockResolvedValue([])
    api.agentProfiles.scanRuntimes = vi.fn().mockResolvedValue([
      {
        ok: true,
        runtimeId: 'codex',
        label: 'OpenAI Codex CLI',
        defaultExecutable: 'codex',
        available: true,
        executablePath: '/Users/test/.local/bin/codex',
        version: 'codex-cli 1.0.0',
        authenticated: true,
        reasoningMode: 'select',
        capabilities: { nativeWebSearch: true, mcp: true, sessionResume: true },
        models: [
          {
            id: 'default',
            label: 'CLI default',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'medium'
          },
          {
            id: 'gpt-5.6-sol',
            label: 'GPT-5.6-Sol',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
            defaultReasoningEffort: 'low'
          }
        ]
      },
      {
        ok: false,
        runtimeId: 'gemini',
        label: 'Gemini CLI',
        defaultExecutable: 'gemini',
        available: false,
        reasoningMode: 'managed',
        capabilities: { nativeWebSearch: true, mcp: true, sessionResume: true },
        models: [
          {
            id: 'default',
            label: 'Auto (CLI default)',
            reasoningEfforts: [],
            defaultReasoningEffort: null
          },
          {
            id: 'flash',
            label: 'Flash',
            reasoningEfforts: [],
            defaultReasoningEffort: null
          }
        ]
      }
    ])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('scans local CLIs and follows each runtime model and reasoning capabilities', async () => {
    render(<ModelSettingsSection />)

    expect(screen.getByRole('tab', { name: 'Local CLI' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(await screen.findByText('codex-cli 1.0.0')).toBeInTheDocument()
    expect(screen.getByText('/Users/test/.local/bin/codex')).toBeInTheDocument()
    expect(api.agentProfiles.scanRuntimes).toHaveBeenCalledOnce()

    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[0])
    const codexDialog = screen.getByRole('dialog')
    fireEvent.change(within(codexDialog).getByRole('combobox', { name: 'Model' }), {
      target: { value: 'gpt-5.6-sol' }
    })
    const effort = within(codexDialog).getByRole('combobox', { name: 'Reasoning effort' })
    expect(within(effort).getByRole('option', { name: 'Ultra' })).toBeInTheDocument()
    expect(within(effort).queryByRole('option', { name: 'settings.aiProviders.effort.minimal' }))
      .not.toBeInTheDocument()
    fireEvent.click(within(codexDialog).getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Configure' })[1])
    const geminiDialog = screen.getByRole('dialog')
    expect(
      within(geminiDialog).getByText('Managed automatically by Gemini CLI')
    ).toBeInTheDocument()
    expect(
      within(geminiDialog).queryByRole('combobox', { name: 'Reasoning effort' })
    ).not.toBeInTheDocument()
  })

  it('switches between local CLI and API provider tabs', async () => {
    render(<ModelSettingsSection />)
    await waitFor(() => expect(api.agentProfiles.scanRuntimes).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('tab', { name: 'API providers' }))

    expect(screen.getByText('API settings')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'API providers' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })
})
