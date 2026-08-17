import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  createContext,
  useContext,
  useMemo
} from 'react'
import { api } from '../ipc'
import { injectThemeCssVars } from '../theme/tokens'
import type { ThemeMode } from '../../shared/ipc-types'

export type { ThemeMode } from '../../shared/ipc-types'
export type ResolvedTheme = 'dark' | 'light'

interface ThemeContextValue {
  mode: ThemeMode
  resolvedTheme: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

const STORAGE_KEY = 'theme'

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyResolvedTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute('data-theme', resolved)
  injectThemeCssVars(resolved)
}

injectThemeCssVars(getSystemTheme())

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system')
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)

  const resolvedTheme = mode === 'system' ? systemTheme : mode

  useLayoutEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    api.settings
      .get<string>(STORAGE_KEY, 'system')
      .then((saved: string) => {
        const m = saved === 'dark' || saved === 'light' ? saved : 'system'
        setModeState(m)
        api.appearance.setThemeSource(m).catch(() => {})
      })
      .catch(() => {
        setModeState('system')
        api.appearance.setThemeSource('system').catch(() => {})
      })
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      setSystemTheme(getSystemTheme())
    }
    handler()
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode)
    api.appearance.setThemeSource(newMode).catch(() => {})
    api.settings.set(STORAGE_KEY, newMode).catch(() => {})
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedTheme, setMode }),
    [mode, resolvedTheme, setMode]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used within <AppThemeProvider>')
  }
  return ctx
}
