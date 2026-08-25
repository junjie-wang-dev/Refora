import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => {
  const labels: Record<string, string> = {
    'settings.webSearch.title': 'Web Search',
    'settings.webSearch.desc': 'Configure internet search',
    'settings.webSearch.activeProvider': 'Active search provider',
    'settings.webSearch.activeProviderHint': 'Only selected provider receives queries',
    'settings.webSearch.providers.disabled': 'Disabled',
    'settings.webSearch.providers.ddgs': 'DDGS · Keyless',
    'settings.webSearch.providers.tavily': 'Tavily',
    'settings.webSearch.providers.brave': 'Brave Search',
    'settings.webSearch.tavilyHint': 'Tavily API',
    'settings.webSearch.braveHint': 'Brave API',
    'settings.webSearch.installed': 'Installed',
    'settings.webSearch.installOnUse': 'Install on use',
    'settings.webSearch.apiKey': 'API key',
    'settings.webSearch.keyConfigured': 'Key configured',
    'settings.webSearch.keyMissing': 'Key required',
    'settings.webSearch.keepCurrentKey': 'Keep current key',
    'settings.webSearch.enterApiKey': 'Enter API key',
    'settings.webSearch.removeKey': 'Remove',
    'settings.webSearch.privacy': 'Search queries are sent to the selected provider.',
    'settings.webSearch.test': 'Save & Test',
    'settings.webSearch.testFailed': 'Test failed',
    'settings.webSearch.loadFailed': 'Load failed',
    'settings.webSearch.saveFailed': 'Save failed',
    'common.save': 'Save'
  }
  const t = (key: string, params?: Record<string, unknown>) => (
    key === 'settings.webSearch.ddgsHint'
      ? `DDGS ${params?.version ?? ''}`
      : labels[key] ?? key
  )
  return { useTranslation: () => ({ t }) }
})

import { api } from '../../src/renderer/ipc'
import { WebSearchSettings } from '../../src/renderer/components/WebSearchSettings'

describe('WebSearchSettings', () => {
  beforeEach(() => {
    vi.spyOn(api.webSearch, 'getConfig').mockResolvedValue({
      provider: 'tavily',
      hasTavilyApiKey: true,
      hasBraveApiKey: false,
      ddgsInstalled: false,
      ddgsVersion: '9.14.4'
    })
    vi.spyOn(api.webSearch, 'updateConfig').mockImplementation(async (patch) => ({
      provider: patch.provider ?? 'tavily',
      hasTavilyApiKey: true,
      hasBraveApiKey: Boolean(patch.braveApiKey),
      ddgsInstalled: false,
      ddgsVersion: '9.14.4'
    }))
    vi.spyOn(api.webSearch, 'test').mockResolvedValue({
      ok: true,
      provider: 'tavily',
      resultCount: 1
    })
  })

  afterEach(cleanup)

  it('shows key presence without exposing stored secrets and saves replacements', async () => {
    render(<WebSearchSettings />)

    const tavilyInput = await screen.findByLabelText('Tavily API key')
    expect(tavilyInput).toHaveValue('')
    expect(tavilyInput).toHaveAttribute('type', 'password')
    expect(screen.getByText('Key configured')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Brave Search API key'), {
      target: { value: 'brave-new-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.webSearch.updateConfig).toHaveBeenCalledWith({
      provider: 'tavily',
      braveApiKey: 'brave-new-key'
    }))
  }, 60_000)

  it('clears an active provider key only after disabling that provider', async () => {
    render(<WebSearchSettings />)

    await screen.findByLabelText('Tavily API key')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(api.webSearch.updateConfig).toHaveBeenCalledWith({
      provider: 'disabled',
      clearTavilyApiKey: true
    }))
  }, 60_000)
})
