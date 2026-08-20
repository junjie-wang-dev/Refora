import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  EnvelopeSimple,
  Eye,
  EyeSlash,
  UserCircle,
  WarningCircle
} from '@phosphor-icons/react'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import { useSyncAccountStore } from '../store/syncAccountStore'
import { Button, Input } from './ui'

type AuthMode = 'signIn' | 'signUp'

export function AccountAuthForm() {
  const { t } = useTranslation()
  const setStatus = useSyncAccountStore((state) => state.setStatus)
  const [mode, setMode] = useState<AuthMode>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<AuthMode | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  const [confirmationResent, setConfirmationResent] = useState(false)

  const selectMode = (nextMode: AuthMode) => {
    setMode(nextMode)
    setPassword('')
    setConfirmPassword('')
    setShowPassword(false)
    setFormError(null)
    setPendingConfirmationEmail(null)
    setResending(false)
    setConfirmationResent(false)
  }

  const resendConfirmation = async () => {
    if (!pendingConfirmationEmail) return
    setResending(true)
    setConfirmationResent(false)
    setFormError(null)
    try {
      await api.sync.resendConfirmation({ email: pendingConfirmationEmail })
      setConfirmationResent(true)
    } catch (error) {
      setFormError(errorMessage(error, t('account.resendFailed')))
    } finally {
      setResending(false)
    }
  }

  const authenticate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedEmail = email.trim()
    if (mode === 'signUp' && password !== confirmPassword) {
      setFormError(t('account.passwordMismatch'))
      return
    }

    setBusy(mode)
    setFormError(null)
    try {
      if (mode === 'signIn') {
        setStatus(await api.sync.signIn({ email: normalizedEmail, password }))
      } else {
        const result = await api.sync.signUp({ email: normalizedEmail, password })
        setStatus(result.status)
        if (result.confirmationRequired) setPendingConfirmationEmail(normalizedEmail)
      }
      setPassword('')
      setConfirmPassword('')
      setShowPassword(false)
    } catch (error) {
      setFormError(errorMessage(error, t('account.authFailed')))
    } finally {
      setBusy(null)
    }
  }

  if (pendingConfirmationEmail) {
    return (
      <div className="flex flex-col items-center px-8 py-9 text-center">
        <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
          <EnvelopeSimple className="h-7 w-7" />
        </span>
        <h2 className="text-base font-semibold text-foreground">{t('account.confirmationTitle')}</h2>
        <p className="mt-2 max-w-sm text-xs leading-relaxed text-muted">
          {t('account.confirmationDescription', { email: pendingConfirmationEmail })}
        </p>
        {confirmationResent && (
          <p className="mt-3 text-label text-success" role="status">
            {t('account.confirmationResent')}
          </p>
        )}
        {formError && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-error/10 px-3 py-2 text-label text-error" role="alert">
            <WarningCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{formError}</span>
          </div>
        )}
        <Button
          variant="primary"
          className="mt-6"
          loading={resending}
          disabled={resending || confirmationResent}
          onClick={() => void resendConfirmation()}
        >
          {confirmationResent ? t('account.confirmationResent') : t('account.resendConfirmation')}
        </Button>
        <Button
          variant="secondary"
          className="mt-2"
          icon={<ArrowLeft className="h-3.5 w-3.5" />}
          onClick={() => selectMode('signIn')}
        >
          {t('account.backToSignIn')}
        </Button>
      </div>
    )
  }

  const submitting = busy === mode

  return (
    <div>
      <div className="flex flex-col items-center border-b border-border bg-panel-2/60 px-8 pb-6 pt-8 text-center">
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
          <UserCircle className="h-7 w-7" weight="duotone" />
        </span>
        <h2 className="text-base font-semibold text-foreground">
          {mode === 'signIn' ? t('account.welcomeBack') : t('account.createTitle')}
        </h2>
        <p className="mt-1.5 text-xs text-muted">
          {mode === 'signIn' ? t('account.signInDescription') : t('account.createDescription')}
        </p>
      </div>

      <div className="px-8 py-6">
        <div
          className="mb-5 grid grid-cols-2 rounded-lg bg-panel-2 p-1"
          role="tablist"
          aria-label={t('account.authMode')}
        >
          {(['signIn', 'signUp'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={`rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                mode === item
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted hover:text-foreground'
              }`}
              onClick={() => selectMode(item)}
            >
              {item === 'signIn' ? t('account.signIn') : t('account.createAccount')}
            </button>
          ))}
        </div>

        <form className="flex flex-col gap-3.5" onSubmit={(event) => void authenticate(event)}>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor="account-email">
              {t('account.email')}
            </label>
            <Input
              id="account-email"
              type="email"
              inputSize="md"
              autoComplete="email"
              placeholder={t('account.emailPlaceholder')}
              value={email}
              required
              autoFocus
              disabled={busy !== null}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground" htmlFor="account-password">
              {t('account.password')}
            </label>
            <div className="relative">
              <Input
                id="account-password"
                type={showPassword ? 'text' : 'password'}
                inputSize="md"
                autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                className="pr-9"
                value={password}
                required
                disabled={busy !== null}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={showPassword ? t('account.hidePassword') : t('account.showPassword')}
                disabled={busy !== null}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {mode === 'signUp' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor="account-confirm-password">
                {t('account.confirmPassword')}
              </label>
              <Input
                id="account-confirm-password"
                type={showPassword ? 'text' : 'password'}
                inputSize="md"
                autoComplete="new-password"
                value={confirmPassword}
                required
                disabled={busy !== null}
                error={Boolean(formError && password !== confirmPassword)}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
          )}

          {formError && (
            <div className="flex items-start gap-2 rounded-lg bg-error/10 px-3 py-2 text-label text-error" role="alert">
              <WarningCircle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="mt-1 w-full"
            loading={submitting}
            disabled={busy !== null || !email.trim() || !password || (mode === 'signUp' && !confirmPassword)}
          >
            {mode === 'signIn' ? t('account.signIn') : t('account.createAccount')}
          </Button>
        </form>

        <p className="mt-5 text-center text-label leading-relaxed text-muted">
          {t('account.localFirstHint')}
        </p>
      </div>
    </div>
  )
}
