import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@lobehub/ui'
import {
  CheckCircle,
  CloudSlash,
  SignOut,
  WarningCircle
} from '@phosphor-icons/react'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import { useSyncAccountStore } from '../store/syncAccountStore'
import { AccountAuthForm } from './AccountAuthForm'
import { Button } from './ui'

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

  useEffect(() => {
    if (!open) return
    setActionError(null)
    void loadAccount()
  }, [loadAccount, open])

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
    content = (
      <div className="flex flex-col items-center px-8 py-10 text-center">
        <span className={`mb-4 flex h-14 w-14 items-center justify-center rounded-full ${confirmed ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
          {confirmed
            ? <CheckCircle className="h-7 w-7" weight="fill" />
            : <WarningCircle className="h-7 w-7" />}
        </span>
        <h2 className="text-base font-semibold text-foreground">
          {confirmed ? t('account.emailConfirmedTitle') : t('account.confirmationFailedTitle')}
        </h2>
        <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">
          {confirmed
            ? t('account.emailConfirmedDescription')
            : confirmation.message ?? t('account.confirmationFailedDescription')}
        </p>
        <Button variant="primary" className="mt-6" onClick={clearConfirmation}>
          {confirmed ? t('account.continueToSignIn') : t('account.backToAccount')}
        </Button>
      </div>
    )
  } else if (!status.signedIn) {
    content = <AccountAuthForm />
  } else {
    const email = status.account?.email ?? ''
    const initial = email.trim().slice(0, 1).toUpperCase() || '?'
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

          {actionError && (
            <div className="rounded-lg bg-error/10 px-3 py-2 text-label text-error" role="alert">
              {actionError}
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
