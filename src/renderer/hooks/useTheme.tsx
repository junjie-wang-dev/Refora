import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  createContext,
  useContext,
  useMemo,
  useRef
} from 'react'
import { api } from '../ipc'
import i18n from '../i18n'
import { useDocumentStore } from '../store/documentStore'
import { injectThemeCssVars } from '../theme/tokens'
import type { ThemeMode } from '../../shared/ipc-types'
import { trackRendererPersistence } from '../persistence'

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
  const loadVersionRef = useRef(0)

  const resolvedTheme = mode === 'system' ? systemTheme : mode

  useLayoutEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  const loadTheme = useCallback(async (showError: boolean) => {
    const version = ++loadVersionRef.current
    let nextMode: ThemeMode = 'system'
    let errorShown = false
    try {
      const saved = await api.settings.get<string>(STORAGE_KEY, 'system')
      nextMode = saved === 'dark' || saved === 'light' ? saved : 'system'
    } catch {
      if (version !== loadVersionRef.current) return
      if (showError) {
        useDocumentStore.getState().showToast(i18n.t('common.settingsLoadFailed'))
        errorShown = true
      }
    }
    if (version !== loadVersionRef.current) return
    setModeState(nextMode)
    try {
      await api.appearance.setThemeSource(nextMode)
    } catch {
      if (version === loadVersionRef.current && showError && !errorShown) {
        useDocumentStore.getState().showToast(i18n.t('common.settingsLoadFailed'))
      }
    }
  }, [])

  useEffect(() => {
    void loadTheme(true)
    const handleLibrarySwitched = () => {
      void loadTheme(true)
    }
    api.events.onLibrarySwitched(handleLibrarySwitched)
    return () => {
      loadVersionRef.current += 1
      api.events.off('library:switched', handleLibrarySwitched)
    }
  }, [loadTheme])

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
    loadVersionRef.current += 1
    setModeState(newMode)
    void trackRendererPersistence(api.settings.set(STORAGE_KEY, newMode))
      .then(() => api.appearance.setThemeSource(newMode))
      .catch(() => {
        useDocumentStore.getState().showToast(i18n.t('common.settingsSaveFailed'))
        void loadTheme(false)
      })
  }, [loadTheme])

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
