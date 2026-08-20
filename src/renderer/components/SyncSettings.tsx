import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle,
  CloudCheck,
  CloudSlash,
  ShieldCheck,
  UserCircle,
  WarningCircle
} from '@phosphor-icons/react'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import { useSyncAccountStore } from '../store/syncAccountStore'
import { Button } from './ui'

interface SyncSettingsProps {
  onError: (message: string | null) => void
  onOpenAccount: () => void
}

export function SyncSettings({ onError, onOpenAccount }: SyncSettingsProps) {
  const { t } = useTranslation()
  const status = useSyncAccountStore((state) => state.status)
  const loading = useSyncAccountStore((state) => state.loading)
  const loadFailed = useSyncAccountStore((state) => state.loadFailed)
  const loadAccount = useSyncAccountStore((state) => state.load)
  const setStatus = useSyncAccountStore((state) => state.setStatus)
  const [toggling, setToggling] = useState(false)

  useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  const toggle = async () => {
    if (!status) return
    setToggling(true)
    onError(null)
    try {
      setStatus(await api.sync.setEnabled(!status.enabled))
    } catch (error) {
      onError(errorMessage(error, t('settings.sync.toggleFailed')))
    } finally {
      setToggling(false)
    }
  }

  if (!status && loading) {
    return (
      <div className="flex max-w-xl animate-pulse flex-col gap-3" role="status">
        <span className="sr-only">{t('settings.sync.loading')}</span>
        <div className="h-20 rounded-xl bg-panel-2" />
        <div className="h-28 rounded-xl bg-panel-2" />
      </div>
    )
  }

  if (!status && loadFailed) {
    return (
      <div className="flex max-w-xl items-start gap-3 rounded-xl border border-error/30 bg-error/10 p-4 text-xs text-error" role="alert">
        <WarningCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t('settings.sync.loadFailed')}</span>
          <Button variant="link" className="w-fit p-0" onClick={() => void loadAccount()}>
            {t('settings.sync.tryAgain')}
          </Button>
        </div>
      </div>
    )
  }

  if (!status) {
    return <div className="text-xs text-muted" role="status">{t('settings.sync.loading')}</div>
  }

  if (!status.configured) {
    return (
      <div className="flex max-w-xl items-start gap-3 rounded-xl border border-border bg-panel p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-panel-2 text-muted">
          <CloudSlash className="h-5 w-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-xs font-semibold text-foreground">{t('settings.sync.unconfiguredTitle')}</div>
          <p className="text-label leading-relaxed text-muted">{t('settings.sync.unconfigured')}</p>
        </div>
      </div>
    )
  }

  if (!status.signedIn) {
    return (
      <div className="flex max-w-xl items-center gap-4 rounded-xl border border-border bg-panel p-5 shadow-sm">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
          <UserCircle className="h-6 w-6" weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-foreground">{t('settings.sync.accountRequiredTitle')}</div>
          <p className="mt-1 text-label leading-relaxed text-muted">
            {t('settings.sync.accountRequiredDescription')}
          </p>
        </div>
        <Button variant="primary" onClick={onOpenAccount}>
          {t('settings.sync.openAccount')}
        </Button>
      </div>
    )
  }

  if (!status.syncAvailable) {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-panel p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-panel-2 text-muted">
            <CloudSlash className="h-5 w-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="text-xs font-semibold text-foreground">
              {t('settings.sync.engineUnavailableTitle')}
            </div>
            <p className="text-label leading-relaxed text-muted">
              {t('settings.sync.engineUnavailableDescription')}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl bg-panel-2 p-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted" />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground">
              {t('settings.sync.noUploadTitle')}
            </span>
            <p className="text-label leading-relaxed text-muted">
              {t('settings.sync.noUploadDescription')}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const accountEmail = status.account?.email ?? ''
  const accountInitial = accountEmail.trim().slice(0, 1).toUpperCase() || '?'

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-panel p-4 shadow-sm">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
          {accountInitial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground">{accountEmail}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-label text-muted">
            <CheckCircle className="h-3.5 w-3.5 text-success" weight="fill" />
            <span>{t('settings.sync.accountConnected')}</span>
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onOpenAccount}>
          {t('settings.sync.manageAccount')}
        </Button>
      </div>

      <label className="flex cursor-pointer items-center gap-4 rounded-xl border border-border bg-panel p-4 transition-colors hover:bg-panel-2/60">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${status.enabled ? 'bg-success/10 text-success' : 'bg-panel-2 text-muted'}`}>
          {status.enabled ? <CloudCheck className="h-5 w-5" /> : <CloudSlash className="h-5 w-5" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs font-semibold text-foreground">{t('settings.sync.enable')}</span>
          <span className="text-label leading-relaxed text-muted">
            {status.enabled ? t('settings.sync.enabledHint') : t('settings.sync.disabledHint')}
          </span>
        </span>
        <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${status.enabled ? 'bg-accent' : 'bg-border'}`} aria-hidden="true">
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${status.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
        </span>
        <input
          type="checkbox"
          className="sr-only"
          aria-label={t('settings.sync.enable')}
          checked={status.enabled}
          disabled={toggling}
          onChange={() => void toggle()}
        />
      </label>

      <div className="flex items-start gap-3 rounded-xl bg-panel-2 p-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted" />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-foreground">{t('settings.sync.privacyTitle')}</span>
          <p className="text-label leading-relaxed text-muted">{t('settings.sync.scopeHint')}</p>
        </div>
      </div>
    </div>
  )
}
