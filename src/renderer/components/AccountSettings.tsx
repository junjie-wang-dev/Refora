import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, CloudSlash, UserCircle, WarningCircle } from '@phosphor-icons/react'
import { useSyncAccountStore } from '../store/syncAccountStore'
import { Button } from './ui'

interface AccountSettingsProps {
  onOpenAccount: () => void
}

export function AccountSettings({ onOpenAccount }: AccountSettingsProps) {
  const { t } = useTranslation()
  const status = useSyncAccountStore((state) => state.status)
  const loading = useSyncAccountStore((state) => state.loading)
  const loadFailed = useSyncAccountStore((state) => state.loadFailed)
  const loadAccount = useSyncAccountStore((state) => state.load)

  useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  if (!status && loading) {
    return (
      <div className="flex max-w-xl animate-pulse flex-col gap-3" role="status">
        <span className="sr-only">{t('settings.account.loading')}</span>
        <div className="h-20 rounded-xl bg-panel-2" />
      </div>
    )
  }

  if (!status && loadFailed) {
    return (
      <div className="flex max-w-xl items-start gap-3 rounded-xl border border-error/30 bg-error/10 p-4 text-xs text-error" role="alert">
        <WarningCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t('settings.account.loadFailed')}</span>
          <Button variant="link" className="w-fit p-0" onClick={() => void loadAccount()}>
            {t('settings.account.tryAgain')}
          </Button>
        </div>
      </div>
    )
  }

  if (!status) {
    return <div className="text-xs text-muted" role="status">{t('settings.account.loading')}</div>
  }

  if (!status.configured) {
    return (
      <div className="flex max-w-xl items-start gap-3 rounded-xl border border-border bg-panel p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-panel-2 text-muted">
          <CloudSlash className="h-5 w-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-xs font-semibold text-foreground">{t('settings.account.unconfiguredTitle')}</div>
          <p className="text-label leading-relaxed text-muted">{t('settings.account.unconfigured')}</p>
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
          <div className="text-xs font-semibold text-foreground">{t('settings.account.accountRequiredTitle')}</div>
          <p className="mt-1 text-label leading-relaxed text-muted">
            {t('settings.account.accountRequiredDescription')}
          </p>
        </div>
        <Button variant="primary" onClick={onOpenAccount}>
          {t('settings.account.openAccount')}
        </Button>
      </div>
    )
  }

  const accountEmail = status.account?.email ?? ''
  const accountInitial = accountEmail.trim().slice(0, 1).toUpperCase() || '?'

  return (
    <div className="flex max-w-xl items-center gap-3 rounded-xl border border-border bg-panel p-4 shadow-sm">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-semibold text-accent">
        {accountInitial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-foreground">{accountEmail}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-label text-muted">
          <CheckCircle className="h-3.5 w-3.5 text-success" weight="fill" />
          <span>{t('settings.account.accountConnected')}</span>
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onOpenAccount}>
        {t('settings.account.manageAccount')}
      </Button>
    </div>
  )
}
