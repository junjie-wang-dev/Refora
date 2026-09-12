import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettingsModal from '../../src/renderer/components/SettingsModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'settings.title': 'Settings',
      'settings.latexCompiler.title': 'LaTeX Compiler',
      'settings.latexCompiler.desc': 'Choose the local compiler',
      'settings.latexCompiler.compiler': 'Compiler',
      'settings.latexCompiler.tectonicHint': 'Tectonic hint',
      'settings.latexCompiler.executablePath': 'Compiler executable',
      'settings.latexCompiler.autoDetect': 'Detect automatically',
      'settings.latexCompiler.chooseExecutable': 'Choose File',
      'settings.latexCompiler.useAutoDetect': 'Reset',
      'settings.latexCompiler.pathHint': 'Path hint',
      'settings.latexCompiler.tectonicCacheHint': 'Tectonic downloads required support files',
      'settings.chooseFolder': 'Choose Folder'
    } as Record<string, string>)[key] ?? key,
    i18n: { language: 'en' }
  })
}))

vi.mock('../../src/renderer/hooks/useTheme', () => ({
  useTheme: () => ({ mode: 'system', resolvedTheme: 'light', setMode: vi.fn() })
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('LaTeX compiler settings', () => {
  it('loads and updates the global Tectonic executable directory', async () => {
    const values: Record<string, unknown> = {
      latexCompiler: 'tectonic',
      tectonicBinPath: '/opt/homebrew/bin'
    }
    vi.spyOn(window.api.settings, 'get').mockImplementation(async (key, fallback) => (
      key in values ? values[key] : fallback
    ) as never)
    const set = vi.spyOn(window.api.settings, 'set').mockResolvedValue(undefined)
    const openExecutable = vi.spyOn(window.api.dialog, 'openExecutable').mockResolvedValue('/custom/tectonic')

    render(<SettingsModal open initialPage="latex" onClose={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'LaTeX Compiler' })).toBeInTheDocument()
    expect(await screen.findByDisplayValue('/opt/homebrew/bin')).toBeInTheDocument()
    expect(screen.getByText(/downloads required support files/)).toBeInTheDocument()

    const executablePath = screen.getByDisplayValue('/opt/homebrew/bin')
    fireEvent.change(executablePath, { target: { value: '/custom/tectonic' } })
    fireEvent.blur(executablePath)
    await waitFor(() => expect(set).toHaveBeenCalledWith('tectonicBinPath', '/custom/tectonic'))

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('tectonicBinPath', ''))

    fireEvent.click(screen.getByRole('button', { name: 'Choose File' }))
    await waitFor(() => expect(openExecutable).toHaveBeenCalledWith('tectonic'))
    await waitFor(() => expect(set).toHaveBeenCalledWith('tectonicBinPath', '/custom/tectonic'))
  })

  it('persists compiler selection changes', async () => {
    const get = vi.spyOn(window.api.settings, 'get').mockImplementation(async (_key, fallback) => fallback as never)
    const set = vi.spyOn(window.api.settings, 'set').mockResolvedValue(undefined)

    render(<SettingsModal open initialPage="latex" onClose={vi.fn()} />)

    const compiler = await screen.findByRole('combobox')
    await waitFor(() => expect(get).toHaveBeenCalledWith('tectonicBinPath', ''))
    fireEvent.change(compiler, { target: { value: 'tectonic' } })

    await waitFor(() => expect(set).toHaveBeenCalledWith('latexCompiler', 'tectonic'))
  })
})
