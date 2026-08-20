import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, UserCircle, WarningCircle } from '@phosphor-icons/react'
import { IpcChannel } from '../../shared/ipc-channels'
import { api } from '../ipc'
import { useSyncAccountStore } from '../store/syncAccountStore'
import { AppThemeProvider } from '../hooks/useTheme'
import AccountModal from './AccountModal'
import { Button } from './ui'

export default function RecoveryApp() {
  const { t } = useTranslation()
  const setConfirmation = useSyncAccountStore((state) => state.setConfirmation)
  const [showAccount, setShowAccount] = useState(false)

  useEffect(() => {
    const callback = (confirmation: Parameters<typeof setConfirmation>[0]) => {
      setConfirmation(confirmation)
      setShowAccount(true)
    }
    api.events.onSyncAuthConfirmation(callback)
    return () => api.events.off(IpcChannel.EventSyncAuthConfirmation, callback)
  }, [setConfirmation])

  return (
    <AppThemeProvider>
      <main className="flex h-screen w-screen items-center justify-center bg-background p-8">
        <section className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-panel shadow-xl">
          <div className="flex flex-col items-center border-b border-border bg-panel-2/60 px-8 py-9 text-center">
            <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-error/10 text-error">
              <Database className="h-8 w-8" />
              <WarningCircle className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-panel" weight="fill" />
            </span>
            <h1 className="mt-5 text-lg font-semibold text-foreground">{t('recovery.title')}</h1>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-muted">
              {t('recovery.description')}
            </p>
          </div>
          <div className="flex flex-col gap-3 px-8 py-6">
            <div className="rounded-xl border border-border bg-background p-4 text-label leading-relaxed text-muted">
              {t('recovery.accountAvailable')}
            </div>
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              icon={<UserCircle className="h-4 w-4" />}
              onClick={() => setShowAccount(true)}
            >
              {t('recovery.openAccount')}
            </Button>
          </div>
        </section>
        <AccountModal open={showAccount} onClose={() => setShowAccount(false)} />
      </main>
    </AppThemeProvider>
  )
}
