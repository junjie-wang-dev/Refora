import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@lobehub/ui'
import {
  CheckCircle,
  ArrowsClockwise,
  CloudCheck,
  CloudSlash,
  SignOut,
  WarningCircle
} from '@phosphor-icons/react'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import { useSyncAccountStore } from '../store/syncAccountStore'
import { AccountAuthForm } from './AccountAuthForm'
import { Button } from './ui'
import type { SyncConflict } from '../../shared/sync-types'

interface AccountModalProps {
  open: boolean
  onClose: () => void
}

export default function AccountModal({ open, onClose }: AccountModalProps) {
  const { t } = useTranslation()
  const status = useSyncAccountStore((state) => state.status)
  const loading = useSyncAccountStore((state) => state.loading)
  const loadFailed = useSyncAccountStore((state) => state.loadFailed)
  const confirmation = useSyncAccountStore((state) => state.confirmation)
  const loadAccount = useSyncAccountStore((state) => state.load)
  const setStatus = useSyncAccountStore((state) => state.setStatus)
  const clearConfirmation = useSyncAccountStore((state) => state.clearConfirmation)
  const [signingOut, setSigningOut] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [conflicts, setConflicts] = useState<SyncConflict[]>([])

  useEffect(() => {
    if (!open) return
    setActionError(null)
    void loadAccount()
  }, [loadAccount, open])

  useEffect(() => {
    if (open && confirmation?.flow === 'oauth' && confirmation.status === 'confirmed') {
      void loadAccount()
    }
  }, [confirmation, loadAccount, open])

  useEffect(() => {
    if (!open || !status?.signedIn || !status.library?.conflictCount) {
      setConflicts([])
      return
    }
    void api.sync.conflicts().then(setConflicts).catch(() => setConflicts([]))
  }, [open, status?.library?.conflictCount, status?.signedIn])

  const signOut = async () => {
    setSigningOut(true)
    setActionError(null)
    try {
      setStatus(await api.sync.signOut())
    } catch (error) {
      setActionError(errorMessage(error, t('account.signOutFailed')))
    } finally {
      setSigningOut(false)
    }
  }

  const setSyncEnabled = async (enabled: boolean) => {
    setSyncBusy(true)
    setActionError(null)
    try {
      setStatus(await api.sync.setEnabled({ enabled }))
    } catch (error) {
      setActionError(errorMessage(error, t('account.syncFailed')))
      await loadAccount()
    } finally {
      setSyncBusy(false)
    }
  }

  const runSync = async () => {
    setSyncBusy(true)
    setActionError(null)
    try {
      setStatus(await api.sync.runNow())
    } catch (error) {
      setActionError(errorMessage(error, t('account.syncFailed')))
      await loadAccount()
    } finally {
      setSyncBusy(false)
    }
  }

  const resolveConflict = async (id: string, resolution: 'keep_local' | 'use_remote') => {
    setSyncBusy(true)
    setActionError(null)
    try {
      setStatus(await api.sync.resolveConflict({ id, resolution }))
      setConflicts(await api.sync.conflicts())
    } catch (error) {
      setActionError(errorMessage(error, t('account.conflictFailed')))
    } finally {
      setSyncBusy(false)
    }
  }

  let content

  if (!status && loading) {
    content = (
      <div className="flex animate-pulse flex-col gap-3 px-8 py-9" role="status">
        <span className="sr-only">{t('account.loading')}</span>
        <div className="mx-auto h-14 w-14 rounded-full bg-panel-2" />
        <div className="mx-auto h-4 w-36 rounded bg-panel-2" />
        <div className="h-28 rounded-xl bg-panel-2" />
      </div>
    )
  } else if (!status && loadFailed) {
    content = (
      <div className="flex flex-col items-center px-8 py-10 text-center" role="alert">
        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-error/10 text-error">
          <WarningCircle className="h-6 w-6" />
        </span>
        <h2 className="text-sm font-semibold text-foreground">{t('account.loadFailed')}</h2>
        <Button variant="secondary" className="mt-5" onClick={() => void loadAccount()}>
          {t('account.tryAgain')}
        </Button>
      </div>
    )
  } else if (!status) {
    content = null
  } else if (!status.configured) {
    content = (
      <div className="flex flex-col items-center px-8 py-10 text-center">
        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-panel-2 text-muted">
          <CloudSlash className="h-6 w-6" />
        </span>
        <h2 className="text-sm font-semibold text-foreground">{t('account.unconfiguredTitle')}</h2>
        <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">{t('account.unconfigured')}</p>
        <Button variant="secondary" className="mt-5" onClick={onClose}>
          {t('common.done')}
        </Button>
      </div>
    )
  } else if (confirmation) {
    const confirmed = confirmation.status === 'confirmed'
    const oauth = confirmation.flow === 'oauth'
    const provider = confirmation.provider === 'apple'
      ? t('account.apple')
      : t('account.google')
    content = (
      <div className="flex flex-col items-center px-8 py-10 text-center">
        <span className={`mb-4 flex h-14 w-14 items-center justify-center rounded-full ${confirmed ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
          {confirmed
            ? <CheckCircle className="h-7 w-7" weight="fill" />
            : <WarningCircle className="h-7 w-7" />}
        </span>
        <h2 className="text-base font-semibold text-foreground">
          {oauth
            ? t(confirmed ? 'account.oauthSuccessTitle' : 'account.oauthFailedTitle', { provider })
            : t(confirmed ? 'account.emailConfirmedTitle' : 'account.confirmationFailedTitle')}
        </h2>
        <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">
          {confirmed
            ? t(oauth ? 'account.oauthSuccessDescription' : 'account.emailConfirmedDescription')
            : confirmation.message ?? t(oauth ? 'account.oauthFailedDescription' : 'account.confirmationFailedDescription')}
        </p>
        <Button variant="primary" className="mt-6" onClick={clearConfirmation}>
          {oauth
            ? t('account.continueToAccount')
            : confirmed ? t('account.continueToSignIn') : t('account.backToAccount')}
        </Button>
      </div>
    )
  } else if (!status.signedIn) {
    content = <AccountAuthForm />
  } else {
    const email = status.account?.email ?? ''
    const initial = email.trim().slice(0, 1).toUpperCase() || '?'
    const librarySync = status.library ?? null
    const syncError = actionError ?? librarySync?.lastError ?? null
    content = (
      <div>
        <div className="flex flex-col items-center border-b border-border bg-panel-2/60 px-8 pb-6 pt-8 text-center">
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent">
            {initial}
            <CheckCircle className="absolute -bottom-0.5 -right-0.5 h-5 w-5 rounded-full bg-panel text-success" weight="fill" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-foreground">{t('account.signedInTitle')}</h2>
          <p className="mt-1 text-xs text-muted">{t('account.signedInDescription')}</p>
        </div>

        <div className="flex flex-col gap-4 px-8 py-6">
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="text-label font-medium uppercase tracking-wide text-muted">{t('account.email')}</div>
            <div className="mt-1 truncate text-sm font-medium text-foreground">{email}</div>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-start gap-3">
              <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${librarySync?.enabled ? 'bg-success/10 text-success' : 'bg-panel-2 text-muted'}`}>
                {librarySync?.enabled
                  ? <CloudCheck className="h-5 w-5" weight="duotone" />
                  : <CloudSlash className="h-5 w-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-foreground">{t('account.syncTitle')}</div>
                <p className="mt-1 text-label leading-relaxed text-muted">
                  {librarySync
                    ? t(librarySync.enabled ? 'account.syncEnabledDescription' : 'account.syncDisabledDescription')
                    : t('account.syncNoLibrary')}
                </p>
                {librarySync?.lastSyncedAt && (
                  <div className="mt-1 text-label text-muted">
                    {t('account.lastSynced', { value: new Date(librarySync.lastSyncedAt).toLocaleString() })}
                  </div>
                )}
              </div>
              {librarySync && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={librarySync.enabled}
                  aria-label={t('account.syncToggle')}
                  disabled={syncBusy}
                  onClick={() => void setSyncEnabled(!librarySync.enabled)}
                  className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${librarySync.enabled ? 'bg-accent' : 'bg-panel-2'}`}
                >
                  <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${librarySync.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              )}
            </div>
            {librarySync?.enabled && (
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                <div className="text-label text-muted">
                  {t('account.syncCounts', {
                    pending: librarySync.pendingCount,
                    conflicts: librarySync.conflictCount
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ArrowsClockwise className="h-3.5 w-3.5" />}
                  loading={syncBusy}
                  onClick={() => void runSync()}
                >
                  {t('account.syncNow')}
                </Button>
              </div>
            )}
          </div>

          {conflicts.length > 0 && (
            <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
              <div className="text-xs font-semibold text-foreground">{t('account.conflictsTitle')}</div>
              <p className="mt-1 text-label leading-relaxed text-muted">{t('account.conflictsDescription')}</p>
              <div className="mt-3 flex max-h-40 flex-col gap-2 overflow-y-auto">
                {conflicts.map((conflict) => (
                  <div key={conflict.id} className="rounded-lg border border-border bg-panel px-3 py-2">
                    <div className="truncate text-label font-medium text-foreground">
                      {t('account.conflictItem', { type: conflict.entityType, id: conflict.entityId })}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="secondary" disabled={syncBusy} onClick={() => void resolveConflict(conflict.id, 'use_remote')}>
                        {t('account.useRemote')}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={syncBusy} onClick={() => void resolveConflict(conflict.id, 'keep_local')}>
                        {t('account.keepLocal')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {syncError && (
            <div className="rounded-lg bg-error/10 px-3 py-2 text-label text-error" role="alert">
              {syncError}
            </div>
          )}

          <Button
            variant="link"
            className="mx-auto text-muted hover:text-error"
            icon={<SignOut className="h-3.5 w-3.5" />}
            loading={signingOut}
            onClick={() => void signOut()}
          >
            {t('account.signOut')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={null}
      width={460}
      paddings={{ desktop: 0 }}
      styles={{ body: { padding: 0 } }}
      footer={null}
      destroyOnHidden
    >
      <div className="overflow-hidden rounded-xl bg-panel">{content}</div>
    </Modal>
  )
}
