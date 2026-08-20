import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvider, ReforaApi } from '../../src/shared/ipc-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      ({
        'settings.title': 'Settings',
        'settings.sectionGeneral.title': 'General',
        'settings.sectionGeneral.desc': 'Library and network',
        'settings.sectionAppearance.title': 'Appearance',
        'settings.sectionAppearance.desc': 'Theme and language',
        'settings.sync.title': 'Cloud Sync',
        'settings.sync.desc': 'Metadata sync controls',
        'settings.sync.loading': 'Loading account status',
        'settings.sync.loadFailed': 'Failed to load account status',
        'settings.sync.tryAgain': 'Try again',
        'settings.sync.accountConnected': 'Account connected',
        'settings.sync.engineUnavailableTitle': 'Metadata sync is not available yet',
        'settings.sync.engineUnavailableDescription': 'The data engine is disabled.',
        'settings.sync.noUploadTitle': 'No library data is being uploaded',
        'settings.sync.noUploadDescription': 'PDFs and metadata remain on this Mac.',
        'settings.sync.enable': 'Enable metadata sync',
        'settings.sync.disabledHint': 'No library data is sent.',
        'settings.sync.enabledHint': 'Metadata sync is allowed.',
        'settings.sync.scopeHint': 'PDF files are excluded.',
        'settings.sync.privacyTitle': 'Local-first by design',
        'settings.sync.manageAccount': 'Manage account',
        'settings.sync.accountRequiredTitle': 'Sign in before enabling sync',
        'settings.sync.accountRequiredDescription': 'Open your account first.',
        'settings.sync.openAccount': 'Open account',
        'account.loading': 'Loading account',
        'account.welcomeBack': 'Welcome back',
        'account.signInDescription': 'Sign in on this device.',
        'account.createTitle': 'Create your Refora account',
        'account.createDescription': 'Your library stays local.',
        'account.authMode': 'Account action',
        'account.signIn': 'Sign in',
        'account.createAccount': 'Create account',
        'account.email': 'Email',
        'account.emailPlaceholder': 'you@example.com',
        'account.password': 'Password',
        'account.confirmPassword': 'Confirm password',
        'account.passwordMismatch': 'The passwords do not match.',
        'account.showPassword': 'Show password',
        'account.hidePassword': 'Hide password',
        'account.localFirstHint': 'Sync stays off until enabled.',
        'account.confirmationTitle': 'Check your inbox',
        'account.confirmationDescription': 'Open the confirmation email.',
        'account.resendConfirmation': 'Resend confirmation email',
        'account.confirmationResent': 'Confirmation email sent',
        'account.resendFailed': 'Failed to resend confirmation',
        'account.backToSignIn': 'Back to sign in',
        'account.emailConfirmedTitle': 'Email confirmed',
        'account.emailConfirmedDescription': 'Your account is ready.',
        'account.continueToSignIn': 'Continue to sign in',
        'settings.mineru.title': 'MinerU OCR',
        'settings.mineru.desc': 'Local structured parsing',
        'settings.mineru.installLocation': 'Install location',
        'settings.mineru.locationHint': 'Managed location',
        'settings.mineru.requirements': 'Requires disk space',
        'settings.mineru.state.installing': 'Installing',
        'settings.mineru.state.installed': 'Installed',
        'settings.mineru.state.notInstalled': 'Not installed',
        'settings.mineru.install': 'Install MinerU',
        'settings.mineru.progress.installingMineru': 'Installing MinerU dependencies',
        'settings.mineru.progress.downloadingModels': 'Downloading MinerU models',
        'settings.mineru.progress.completed': 'Installation complete',
        'settings.mineru.progressStep': 'Step',
        'settings.mineru.elapsed': 'Elapsed',
        'settings.aiProviders.title': 'AI Providers',
        'settings.aiProviders.desc': 'Model providers and API keys',
        'settings.modelSettings.tabsLabel': 'Model connection type',
        'settings.modelSettings.cli': 'Local CLI',
        'settings.modelSettings.api': 'API providers',
        'settings.agentProfiles.title': 'Local CLI agents',
        'settings.agentProfiles.desc': 'Detected CLI agents',
        'settings.agentProfiles.rescan': 'Scan again',
        'settings.agentProfiles.addCli': 'Add CLI agent',
        'settings.agentProfiles.configure': 'Configure',
        'settings.agentProfiles.notFound': 'Executable not found',
        'settings.libraryFolder': 'Library Folder',
        'settings.libraryFolderAutoImportHint': 'Auto import',
        'settings.chooseFolder': 'Choose Folder',
        'settings.switching': 'Switching',
        'settings.proxy': 'Proxy',
        'settings.crossrefMailto': 'Crossref Mailto',
        'settings.theme': 'Theme',
        'settings.language': 'Language',
        'settings.sidebarCollapsed': 'Collapse Sidebar',
        'settings.aiProviders.connect': 'Connect',
        'settings.aiProviders.customProvider': 'Custom provider',
        'settings.aiProviders.providerApi': 'Provider API',
        'settings.aiProviders.advancedSettings': 'Advanced settings',
        'settings.aiProviders.model': 'Model',
        'settings.aiProviders.searchModels': 'Search models…',
        'settings.aiProviders.fetchModels': 'Fetch models',
        'settings.aiProviders.allModels': 'All provider models',
        'settings.aiProviders.modelSelectionHint': 'Choose models',
        'settings.aiProviders.modelsNotLoaded': 'Fetch models to choose them',
        'settings.aiProviders.addModel': 'Add model',
        'settings.aiProviders.active': 'Active',
        'settings.aiProviders.setActive': 'Set Active',
        'settings.aiProviders.reasoningControl': 'Reasoning parameter',
        'common.done': 'Done',
        'common.cancel': 'Cancel'
      } as Record<string, string>)[key] ?? (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}))

vi.mock('../../src/renderer/hooks/useTheme', () => ({
  useTheme: () => ({ mode: 'system', resolvedTheme: 'light', setMode: vi.fn() })
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

const { AiProvidersSection } = await import(
  '../../src/renderer/components/AiProvidersSection'
)
const { default: SettingsModal } = await import(
  '../../src/renderer/components/SettingsModal'
)
const { default: AccountModal } = await import(
  '../../src/renderer/components/AccountModal'
)
const { useSyncAccountStore } = await import(
  '../../src/renderer/store/syncAccountStore'
)

const api = (window as unknown as { api: ReforaApi }).api

describe('AiProvidersSection', () => {
  const create = vi.fn()
  const set = vi.fn()

  beforeEach(() => {
    create.mockReset()
    set.mockReset()
    api.aiProviders.list = vi.fn().mockResolvedValue([])
    api.aiProviders.listModels = vi.fn().mockResolvedValue({
      ok: true,
      models: [
        {
          id: 'gpt-5.6-terra',
          supportsVariants: false,
          supportsReasoning: true,
          reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          supportsVision: true,
          supportsTools: true,
          supportedParameters: []
        }
      ]
    })
    api.aiProviders.create = create.mockImplementation(async (input) =>
      ({
        id: 'provider-openai',
        presetId: input.presetId ?? 'custom',
        name: input.name,
        baseUrl: input.baseUrl,
        apiProtocol: input.apiProtocol ?? 'openai-compatible',
        reasoningControl: input.reasoningControl ?? 'openai',
        reasoningEffort: input.reasoningEffort ?? 'medium',
        model: input.model,
        models: input.models ?? null,
        baseModel: input.baseModel ?? input.model,
        variant: input.variant ?? '',
        variantFormat: input.variantFormat ?? 'none',
        hasKey: true,
        temperature: input.temperature ?? null,
        maxTokens: input.maxTokens ?? null,
        createdAt: 0
      }) satisfies AiProvider
    )
    api.settings.get = vi.fn().mockResolvedValue('')
    api.settings.set = set.mockResolvedValue(undefined)
    api.sync.status = vi.fn().mockResolvedValue({
      configured: true,
      syncAvailable: false,
      signedIn: true,
      enabled: false,
      state: 'disabled',
      account: { id: 'user-1', email: 'reader@example.com' }
    })
    api.mineru.status = vi.fn().mockResolvedValue({
      state: 'notInstalled',
      installRoot: '/Volumes/Models',
      installPath: null,
      version: null,
      architecture: 'arm64',
      pythonPath: null,
      modelConfigPath: null,
      installedAt: null,
      diskBytes: null,
      error: null,
      progress: null
    })
    api.mineru.install = vi.fn()
    api.mineru.cancelInstall = vi.fn()
    api.events.onMineruInstallProgress = vi.fn()
    useSyncAccountStore.setState({
      status: null,
      loading: false,
      loadFailed: false,
      confirmation: null
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('connects OpenAI with all provider models when advanced settings are untouched', async () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    const { container } = render(<AiProvidersSection />)

    expect(container.querySelector('[data-provider-icon="openai"] svg')).toBeInTheDocument()
    expect(container.querySelector('[data-provider-icon="deepseek"] svg')).toBeInTheDocument()
    expect(screen.queryByText('OA')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0])

    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText('sk-…'), {
      target: { value: 'sk-test' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: 'openai',
        apiProtocol: 'openai-responses',
        apiKey: 'sk-test',
        model: 'gpt-5.6-terra',
        models: null,
        reasoningEffort: 'medium'
      })
    )
    expect(api.aiProviders.listModels).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalledWith('activeProviderId', expect.anything())
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'refora:ai-providers-changed' })
    )
  })

  it('fetches, searches, and selects multiple models inline in one dialog', async () => {
    api.aiProviders.listModels = vi.fn().mockResolvedValue({
      ok: true,
      models: [
        {
          id: 'gpt-5.6-terra',
          supportsVariants: false,
          supportsReasoning: true,
          reasoningEfforts: ['medium'],
          supportsVision: true,
          supportsTools: true,
          supportedParameters: []
        },
        {
          id: 'gpt-5.6-mini',
          supportsVariants: false,
          supportsReasoning: false,
          reasoningEfforts: [],
          supportsVision: false,
          supportsTools: true,
          supportedParameters: []
        }
      ]
    })
    render(<AiProvidersSection />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0])
    const providerDialog = screen.getByRole('dialog')
    fireEvent.change(within(providerDialog).getByPlaceholderText('sk-…'), {
      target: { value: 'sk-test' }
    })
    fireEvent.click(within(providerDialog).getByRole('button', { name: 'Advanced settings' }))

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const search = within(providerDialog).getByPlaceholderText('Search models…')
    fireEvent.click(within(providerDialog).getByRole('button', { name: 'Fetch models' }))
    await waitFor(() => expect(api.aiProviders.listModels).toHaveBeenCalledTimes(1))
    fireEvent.change(search, {
      target: { value: 'terra' }
    })
    fireEvent.click(await within(providerDialog).findByRole('option', { name: /gpt-5\.6-terra/ }))
    fireEvent.change(search, { target: { value: 'mini' } })
    fireEvent.click(await within(providerDialog).findByRole('option', { name: /gpt-5\.6-mini/ }))
    fireEvent.click(within(providerDialog).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ models: ['gpt-5.6-terra', 'gpt-5.6-mini'] })
    )
  })

  it('saves an allowed reasoning effort when the model does not support the preset default', async () => {
    api.aiProviders.listModels = vi.fn().mockResolvedValue({
      ok: true,
      models: [
        {
          id: 'gpt-5.6-terra',
          supportsVariants: false,
          supportsReasoning: true,
          reasoningEfforts: ['high'],
          supportsVision: true,
          supportsTools: true,
          supportedParameters: []
        }
      ]
    })
    render(<AiProvidersSection />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0])
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText('sk-…'), {
      target: { value: 'sk-test' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Advanced settings' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fetch models' }))
    fireEvent.click(await within(dialog).findByRole('option', { name: /gpt-5\.6-terra/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high', models: ['gpt-5.6-terra'] })
    )
  })

  it('does not show or offer an active provider state', async () => {
    api.aiProviders.list = vi.fn().mockResolvedValue([
      {
        id: 'provider-openai',
        presetId: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiProtocol: 'openai-responses',
        reasoningControl: 'openai',
        reasoningEffort: 'medium',
        model: 'gpt-5.6-terra',
        models: ['gpt-5.6-terra'],
        baseModel: 'gpt-5.6-terra',
        variant: '',
        variantFormat: 'none',
        hasKey: true,
        temperature: null,
        maxTokens: null,
        createdAt: 0
      }
    ])

    render(<AiProvidersSection />)

    await screen.findByText('gpt-5.6-terra')
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set Active' })).not.toBeInTheDocument()
  })

  it('opens a custom provider form with protocol and base URL fields', async () => {
    render(<AiProvidersSection />)

    fireEvent.click(screen.getByRole('button', { name: /Custom provider/ }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Provider API')).toBeInTheDocument()
    expect(within(dialog).getByPlaceholderText('https://api.example.com/v1')).toBeInTheDocument()
    expect(within(dialog).getByText('Reasoning parameter')).toBeInTheDocument()
  })

  it('switches settings content through the left navigation', async () => {
    render(<SettingsModal open onClose={vi.fn()} />)

    const navigation = await screen.findByRole('navigation', { name: 'Settings' })
    const layout = document.querySelector('[data-settings-layout]')
    expect(layout).not.toHaveClass('rounded-xl', 'border')
    expect(layout?.querySelector('aside')).toHaveClass('settings-sidebar-surface')
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
    expect(within(navigation).getByRole('button', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    expect(screen.getByText('Library Folder')).toBeInTheDocument()

    fireEvent.click(within(navigation).getByRole('button', { name: 'AI Providers' }))

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Local CLI' })).toHaveAttribute('aria-selected', 'true')
    )
    fireEvent.click(screen.getByRole('tab', { name: 'API providers' }))
    expect(await screen.findByRole('heading', { name: 'AI Providers' })).toBeInTheDocument()
    expect(screen.queryByText('Library Folder')).not.toBeInTheDocument()

    fireEvent.click(within(navigation).getByRole('button', { name: 'Appearance' }))

    expect(screen.getByText('Theme')).toBeInTheDocument()
    expect(screen.getByText('Language')).toBeInTheDocument()

    fireEvent.click(within(navigation).getByRole('button', { name: 'Cloud Sync' }))

    expect(await screen.findByText('Metadata sync is not available yet')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Enable metadata sync' })).not.toBeInTheDocument()
    expect(screen.getByText('No library data is being uploaded')).toBeInTheDocument()
  })

  it('uses a focused sign-up flow and confirms the password before submission', async () => {
    api.sync.resendConfirmation = vi.fn().mockResolvedValue(undefined)
    api.sync.status = vi.fn().mockResolvedValue({
      configured: true,
      syncAvailable: false,
      signedIn: false,
      enabled: false,
      state: 'signedOut',
      account: null
    })
    api.sync.signUp = vi.fn().mockResolvedValue({
      confirmationRequired: true,
      status: {
        configured: true,
        syncAvailable: false,
        signedIn: false,
        enabled: false,
        state: 'signedOut',
        account: null
      }
    })

    render(
      <AccountModal
        open
        onClose={vi.fn()}
        onOpenSyncSettings={vi.fn()}
      />
    )

    expect(await screen.findByText('Welcome back')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Create account' }))
    expect(screen.getByText('Create your Refora account')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'reader@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-1' } })
    const confirmation = screen.getByLabelText('Confirm password')
    fireEvent.change(confirmation, { target: { value: 'secret-2' } })
    fireEvent.submit(confirmation.closest('form') as HTMLFormElement)

    expect(screen.getByRole('alert')).toHaveTextContent('The passwords do not match.')
    expect(api.sync.signUp).not.toHaveBeenCalled()

    fireEvent.change(confirmation, { target: { value: 'secret-1' } })
    fireEvent.submit(confirmation.closest('form') as HTMLFormElement)

    expect(await screen.findByText('Check your inbox')).toBeInTheDocument()
    expect(api.sync.signUp).toHaveBeenCalledWith({
      email: 'reader@example.com',
      password: 'secret-1'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Resend confirmation email' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Confirmation email sent')
    expect(api.sync.resendConfirmation).toHaveBeenCalledWith({ email: 'reader@example.com' })
  })

  it('keeps authentication out of Cloud Sync settings', async () => {
    const onOpenAccount = vi.fn()
    api.sync.status = vi.fn().mockResolvedValue({
      configured: true,
      syncAvailable: false,
      signedIn: false,
      enabled: false,
      state: 'signedOut',
      account: null
    })
    useSyncAccountStore.setState({
      status: null,
      loading: false,
      loadFailed: false,
      confirmation: null
    })

    render(
      <SettingsModal
        open
        onClose={vi.fn()}
        initialPage="sync"
        onOpenAccount={onOpenAccount}
      />
    )

    expect(await screen.findByText('Sign in before enabling sync')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open account' }))
    expect(onOpenAccount).toHaveBeenCalledTimes(1)
  })

  it('turns a desktop auth callback into a clear confirmation result', async () => {
    const signedOutStatus = {
      configured: true,
      syncAvailable: false,
      signedIn: false,
      enabled: false,
      state: 'signedOut' as const,
      account: null
    }
    api.sync.status = vi.fn().mockResolvedValue(signedOutStatus)
    useSyncAccountStore.setState({
      status: signedOutStatus,
      loading: false,
      loadFailed: false,
      confirmation: { status: 'confirmed', message: null }
    })

    render(
      <AccountModal
        open
        onClose={vi.fn()}
        onOpenSyncSettings={vi.fn()}
      />
    )

    expect(screen.getByText('Email confirmed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue to sign in' }))
    expect(await screen.findByText('Welcome back')).toBeInTheDocument()
  })

  it('shows a confirmation result even when another account session is already loaded', async () => {
    const signedInStatus = {
      configured: true,
      syncAvailable: false,
      signedIn: true,
      enabled: false,
      state: 'disabled' as const,
      account: { id: 'user-1', email: 'reader@example.com' }
    }
    api.sync.status = vi.fn().mockResolvedValue(signedInStatus)
    useSyncAccountStore.setState({
      status: signedInStatus,
      loading: false,
      loadFailed: false,
      confirmation: { status: 'confirmed', message: null }
    })

    render(
      <AccountModal
        open
        onClose={vi.fn()}
        onOpenSyncSettings={vi.fn()}
      />
    )

    expect(screen.getByText('Email confirmed')).toBeInTheDocument()
  })

  it('shows the MinerU install path and progress in Settings', async () => {
    api.mineru.status = vi.fn().mockResolvedValue({
      state: 'installing',
      installRoot: '/Volumes/Models',
      installPath: '/Volumes/Models/Refora/MinerU/3.4.4/darwin-arm64',
      version: '3.4.4',
      architecture: 'arm64',
      pythonPath: null,
      modelConfigPath: null,
      installedAt: null,
      diskBytes: null,
      error: null,
      progress: {
        installId: 'install-1',
        startedAt: Date.now() - 5000,
        stage: 'installingMineru',
        currentArtifact: null,
        bytesReceived: 0,
        bytesTotal: null,
        percent: 42,
        cancellable: true,
        message: 'Installing MinerU 3.4.4'
      }
    })

    render(<SettingsModal open onClose={vi.fn()} />)
    const navigation = await screen.findByRole('navigation', { name: 'Settings' })
    fireEvent.click(within(navigation).getByRole('button', { name: 'MinerU OCR' }))

    expect(await screen.findByText('/Volumes/Models')).toBeInTheDocument()
    expect(screen.getByText('Installing MinerU dependencies')).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('uses moving indeterminate progress for model downloads without a measurable total', async () => {
    api.mineru.status = vi.fn().mockResolvedValue({
      state: 'installing',
      installRoot: '/Volumes/Models',
      installPath: '/Volumes/Models/Refora/MinerU/3.4.4/darwin-arm64',
      version: '3.4.4',
      architecture: 'arm64',
      pythonPath: null,
      modelConfigPath: null,
      installedAt: null,
      diskBytes: null,
      error: null,
      progress: {
        installId: 'install-1',
        startedAt: Date.now() - 5000,
        stage: 'downloadingModels',
        currentArtifact: 'MinerU models',
        bytesReceived: 0,
        bytesTotal: null,
        percent: null,
        cancellable: true,
        message: 'Downloading MinerU models'
      }
    })

    const { container } = render(<SettingsModal open onClose={vi.fn()} />)
    const navigation = await screen.findByRole('navigation', { name: 'Settings' })
    fireEvent.click(within(navigation).getByRole('button', { name: 'MinerU OCR' }))

    expect(await screen.findByText('Downloading MinerU models')).toBeInTheDocument()
    expect(container.querySelector('.mineru-progress-indeterminate')).toBeInTheDocument()
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
    expect(screen.getByText('Elapsed')).toBeInTheDocument()
  })

  it('refreshes to installed immediately after the completed progress event', async () => {
    let emitProgress: ((payload: {
      installId: string
      startedAt: number
      stage: 'completed'
      currentArtifact: null
      bytesReceived: number
      bytesTotal: null
      percent: number
      cancellable: boolean
      message: string
    }) => void) | null = null
    api.events.onMineruInstallProgress = vi.fn((callback) => {
      emitProgress = callback
    })
    api.mineru.status = vi.fn()
      .mockResolvedValueOnce({
        state: 'installing',
        installRoot: '/Volumes/Models',
        installPath: '/Volumes/Models/Refora/MinerU/3.4.4/darwin-arm64',
        version: '3.4.4',
        architecture: 'arm64',
        pythonPath: null,
        modelConfigPath: null,
        installedAt: null,
        diskBytes: null,
        error: null,
        progress: null
      })
      .mockResolvedValueOnce({
        state: 'installed',
        installRoot: '/Volumes/Models',
        installPath: '/Volumes/Models/Refora/MinerU/3.4.4/darwin-arm64',
        version: '3.4.4',
        architecture: 'arm64',
        pythonPath: '/Volumes/Models/python',
        modelConfigPath: '/Volumes/Models/mineru.json',
        installedAt: Date.now(),
        diskBytes: null,
        error: null,
        progress: null
      })

    render(<SettingsModal open onClose={vi.fn()} />)
    const navigation = await screen.findByRole('navigation', { name: 'Settings' })
    fireEvent.click(within(navigation).getByRole('button', { name: 'MinerU OCR' }))
    expect(await screen.findByText('Installing')).toBeInTheDocument()

    act(() => {
      emitProgress?.({
        installId: 'install-1',
        startedAt: Date.now() - 5000,
        stage: 'completed',
        currentArtifact: null,
        bytesReceived: 0,
        bytesTotal: null,
        percent: 100,
        cancellable: false,
        message: 'ready'
      })
    })

    expect(await screen.findByText('Installed')).toBeInTheDocument()
    expect(screen.queryByText('100%')).not.toBeInTheDocument()
    expect(api.mineru.status).toHaveBeenCalledTimes(2)
  })

  it('allows cancelling while the install request is still pending', async () => {
    let emitProgress: ((payload: {
      installId: string
      startedAt: number
      stage: 'installingMineru'
      currentArtifact: null
      bytesReceived: number
      bytesTotal: null
      percent: number
      cancellable: boolean
      message: string
    }) => void) | null = null
    let rejectInstall: (error: Error) => void = () => undefined
    api.events.onMineruInstallProgress = vi.fn((callback) => {
      emitProgress = callback
    })
    api.mineru.install = vi.fn(() => new Promise((_resolve, reject) => {
      rejectInstall = reject
    }))
    api.mineru.cancelInstall = vi.fn(async () => {
      rejectInstall(new Error('MinerU installation was cancelled'))
      return api.mineru.status()
    })

    render(<SettingsModal open onClose={vi.fn()} />)
    const navigation = await screen.findByRole('navigation', { name: 'Settings' })
    fireEvent.click(within(navigation).getByRole('button', { name: 'MinerU OCR' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Install MinerU' }))
    await waitFor(() => expect(api.mineru.install).toHaveBeenCalledTimes(1))

    act(() => {
      emitProgress?.({
        installId: 'install-1',
        startedAt: Date.now(),
        stage: 'installingMineru',
        currentArtifact: null,
        bytesReceived: 0,
        bytesTotal: null,
        percent: 42,
        cancellable: true,
        message: 'Installing MinerU 3.4.4'
      })
    })

    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    await waitFor(() => expect(api.mineru.cancelInstall).toHaveBeenCalledTimes(1))
  })
})
