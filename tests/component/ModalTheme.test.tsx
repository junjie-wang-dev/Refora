import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  setThemeSource: vi.fn(),
  onLibrarySwitched: vi.fn(),
  showToast: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({
  api: {
    settings: {
      get: mocks.get,
      set: mocks.set
    },
    appearance: {
      setThemeSource: mocks.setThemeSource
    },
    events: {
      onLibrarySwitched: mocks.onLibrarySwitched
    }
  }
}))

vi.mock('@renderer/i18n', () => ({
  default: {
    t: (key: string) => key
  }
}))

vi.mock('@renderer/store/documentStore', () => ({
  useDocumentStore: {
    getState: () => ({ showToast: mocks.showToast })
  }
}))

import { AppThemeProvider, useTheme } from '@renderer/hooks/useTheme'

let prefersDark = false
const mediaListeners = new Set<() => void>()

function installMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' && prefersDark,
    media: query,
    onchange: null,
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn()
  }))
}

function ThemeReader() {
  const { mode, resolvedTheme } = useTheme()
  return (
    <>
      <output data-testid="theme-mode">{mode}</output>
      <output data-testid="resolved-theme">{resolvedTheme}</output>
    </>
  )
}

function ThemeChanger() {
  const { setMode } = useTheme()
  return (
    <>
      <button onClick={() => setMode('light')}>Use light theme</button>
      <button onClick={() => setMode('system')}>Use system theme</button>
    </>
  )
}

describe('AppThemeProvider', () => {
  beforeEach(() => {
    prefersDark = false
    mediaListeners.clear()
    installMatchMedia()
    mocks.get.mockReset().mockResolvedValue('system')
    mocks.set.mockReset().mockResolvedValue(undefined)
    mocks.setThemeSource.mockReset().mockResolvedValue(undefined)
    mocks.onLibrarySwitched.mockReset().mockReturnValue(vi.fn())
    mocks.showToast.mockReset()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    cleanup()
    mediaListeners.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('loads and applies the saved theme', async () => {
    mocks.get.mockResolvedValue('dark')

    render(
      <AppThemeProvider>
        <ThemeReader />
      </AppThemeProvider>
    )

    await waitFor(() => expect(screen.getByTestId('theme-mode')).toHaveTextContent('dark'))
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(mocks.setThemeSource).toHaveBeenLastCalledWith('dark')
  })

  it('shares theme changes between children and persists them', async () => {
    prefersDark = true

    render(
      <AppThemeProvider>
        <ThemeReader />
        <ThemeChanger />
      </AppThemeProvider>
    )

    await waitFor(() => expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark'))
    fireEvent.click(screen.getByRole('button', { name: 'Use light theme' }))

    expect(screen.getByTestId('theme-mode')).toHaveTextContent('light')
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(mocks.set).toHaveBeenCalledWith('theme', 'light')
    await waitFor(() => expect(mocks.setThemeSource).toHaveBeenLastCalledWith('light'))
  })

  it('reapplies the system theme when the media query changes', async () => {
    render(
      <AppThemeProvider>
        <ThemeReader />
      </AppThemeProvider>
    )

    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'))
    prefersDark = true
    act(() => {
      mediaListeners.forEach((listener) => listener())
    })
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark')
    await waitFor(() => expect(mocks.setThemeSource).toHaveBeenLastCalledWith('system'))
  })

  it('keeps component tokens in sync when returning from dark to a light system theme', async () => {
    prefersDark = true
    mocks.get.mockResolvedValue('dark')

    render(
      <AppThemeProvider>
        <ThemeReader />
        <ThemeChanger />
      </AppThemeProvider>
    )

    await waitFor(() => expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark'))
    fireEvent.click(screen.getByRole('button', { name: 'Use system theme' }))
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark')

    prefersDark = false
    act(() => {
      mediaListeners.forEach((listener) => listener())
    })

    expect(screen.getByTestId('theme-mode')).toHaveTextContent('system')
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    await waitFor(() => expect(mocks.setThemeSource).toHaveBeenLastCalledWith('system'))
  })

  it('falls back to the system theme when loading the saved value fails', async () => {
    prefersDark = true
    mocks.get.mockRejectedValue(new Error('settings unavailable'))

    render(
      <AppThemeProvider>
        <ThemeReader />
      </AppThemeProvider>
    )

    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
    expect(screen.getByTestId('theme-mode')).toHaveTextContent('system')
    expect(mocks.setThemeSource).toHaveBeenLastCalledWith('system')
    expect(mocks.showToast).toHaveBeenCalledWith('common.settingsLoadFailed')
  })

  it('reloads the saved theme after switching libraries', async () => {
    mocks.get.mockResolvedValueOnce('light').mockResolvedValueOnce('dark')

    render(
      <AppThemeProvider>
        <ThemeReader />
      </AppThemeProvider>
    )

    await waitFor(() => expect(screen.getByTestId('theme-mode')).toHaveTextContent('light'))
    const [[handleLibrarySwitched]] = mocks.onLibrarySwitched.mock.calls
    act(() => handleLibrarySwitched())

    await waitFor(() => expect(screen.getByTestId('theme-mode')).toHaveTextContent('dark'))
    expect(mocks.setThemeSource).toHaveBeenLastCalledWith('dark')
  })
})
