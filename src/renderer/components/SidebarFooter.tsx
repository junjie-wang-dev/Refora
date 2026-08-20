import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Gear, Monitor, Moon, Sun, User } from '@phosphor-icons/react'
import { useTheme, type ThemeMode } from '../hooks/useTheme'
import { useClickOutside } from '../hooks/useClickOutside'
import { useSyncAccountStore } from '../store/syncAccountStore'
import { Button as UiButton, IconTooltip } from './ui'

interface SidebarFooterProps {
  onOpenAccount: () => void
  onOpenSettings: () => void
}

const THEME_OPTIONS: { mode: ThemeMode; icon: React.ReactNode }[] = [
  { mode: 'system', icon: <Monitor className="h-4 w-4" /> },
  { mode: 'light', icon: <Sun className="h-4 w-4" /> },
  { mode: 'dark', icon: <Moon className="h-4 w-4" /> },
]

const THEME_LABEL_KEYS: Record<ThemeMode, string> = {
  system: 'settings.themeSystem',
  light: 'settings.themeLight',
  dark: 'settings.themeDark',
}

function accountInitial(email: string | undefined): string | null {
  const value = email?.trim()
  return value ? value.slice(0, 1).toUpperCase() : null
}

export default function SidebarFooter({ onOpenAccount, onOpenSettings }: SidebarFooterProps) {
  const { t } = useTranslation()
  const { mode: themeMode, setMode: setThemeMode } = useTheme()
  const status = useSyncAccountStore((state) => state.status)
  const loading = useSyncAccountStore((state) => state.loading)
  const loadFailed = useSyncAccountStore((state) => state.loadFailed)
  const loadAccount = useSyncAccountStore((state) => state.load)
  const [themePopoverOpen, setThemePopoverOpen] = useState(false)
  const themePopoverRef = useRef<HTMLDivElement | null>(null)
  useClickOutside(themePopoverRef, () => setThemePopoverOpen(false), themePopoverOpen)

  const currentThemeOption = THEME_OPTIONS.find((o) => o.mode === themeMode) ?? THEME_OPTIONS[0]
  const email = status?.account?.email
  const initial = accountInitial(email)
  const accountLabel = status?.signedIn && email ? email : t('sidebar.account.signIn')
  const accountHint = loading && !status
    ? t('sidebar.account.loading')
    : loadFailed
      ? t('sidebar.account.unavailable')
      : status?.signedIn && !status.syncAvailable
        ? t('sidebar.account.syncUnavailable')
        : status?.enabled
          ? t('sidebar.account.syncOn')
          : status?.signedIn
            ? t('sidebar.account.syncOff')
            : t('sidebar.account.signedOut')

  useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  return (
    <div className="mt-auto border-t border-border/70 px-2 py-2">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
          aria-label={t('sidebar.account.open')}
          onClick={onOpenAccount}
        >
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-foreground shadow-sm">
            {initial ?? <User className="h-4 w-4" />}
            {status?.signedIn && (
              <span
                className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-panel ${status.enabled ? 'bg-success' : 'bg-muted'}`}
                aria-hidden="true"
              />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">{accountLabel}</span>
            <span className="block truncate text-label text-muted">{accountHint}</span>
          </span>
        </button>

        <div className="relative" ref={themePopoverRef}>
          <IconTooltip label={t('tooltip.toggleTheme')} disabled={themePopoverOpen}>
            <UiButton
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => setThemePopoverOpen((v) => !v)}
              title={t('tooltip.toggleTheme')}
              aria-haspopup="menu"
              aria-expanded={themePopoverOpen}
            >
              {currentThemeOption.icon}
            </UiButton>
          </IconTooltip>
          {themePopoverOpen && (
            <div
              className="absolute bottom-full right-0 z-50 mb-1 rounded-lg border border-border bg-panel p-1 shadow-lg"
              role="menu"
            >
              {THEME_OPTIONS.map((opt) => {
                const isActive = themeMode === opt.mode
                return (
                  <button
                    key={opt.mode}
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors duration-150 ${
                      isActive ? 'text-accent' : 'text-foreground hover:bg-hover'
                    }`}
                    onClick={() => {
                      setThemeMode(opt.mode)
                      setThemePopoverOpen(false)
                    }}
                  >
                    <span className="flex-shrink-0">{opt.icon}</span>
                    <span className="flex-1 truncate text-left">{t(THEME_LABEL_KEYS[opt.mode])}</span>
                    {isActive && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <IconTooltip label={t('tooltip.openSettings')}>
          <UiButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={onOpenSettings}
            title={t('tooltip.openSettings')}
          >
            <Gear className="h-4 w-4" />
          </UiButton>
        </IconTooltip>
      </div>
    </div>
  )
}
