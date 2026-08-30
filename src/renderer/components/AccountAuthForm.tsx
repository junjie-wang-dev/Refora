import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  CircleNotch,
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
import type { SyncOAuthProvider } from '../../shared/sync-types'

type AuthMode = 'signIn' | 'signUp'
type AuthAction = AuthMode | SyncOAuthProvider

function GoogleMark() {
  return (
    <svg aria-hidden="true" className="h-[18px] w-[18px]" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.715v2.258h2.909c1.702-1.567 2.684-3.874 2.684-6.614Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.468-.806 5.956-2.181l-2.91-2.258c-.805.54-1.835.859-3.046.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.963 10.706A5.41 5.41 0 0 1 3.681 9c0-.592.102-1.167.282-1.706V4.962H.956A9 9 0 0 0 0 9c0 1.45.347 2.824.956 4.038l3.007-2.332Z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.507.454 3.44 1.345l2.582-2.582C13.464.891 11.426 0 9 0A9 9 0 0 0 .956 4.962l3.007 2.332C4.672 5.165 6.656 3.58 9 3.58Z" />
    </svg>
  )
}

function AppleMark() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.79 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.1v-.01ZM12.03 7.25C11.88 5.02 13.69 3.18 15.77 3c.29 2.58-2.34 4.5-3.74 4.25Z" />
    </svg>
  )
}

export function AccountAuthForm() {
  const { t } = useTranslation()
  const setStatus = useSyncAccountStore((state) => state.setStatus)
  const [mode, setMode] = useState<AuthMode>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<AuthAction | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [oauthStarted, setOAuthStarted] = useState<SyncOAuthProvider | null>(null)
  const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  const [confirmationResent, setConfirmationResent] = useState(false)

  const selectMode = (nextMode: AuthMode) => {
    setMode(nextMode)
    setPassword('')
    setConfirmPassword('')
    setShowPassword(false)
    setFormError(null)
    setOAuthStarted(null)
    setPendingConfirmationEmail(null)
    setResending(false)
    setConfirmationResent(false)
  }

  const authenticateWithOAuth = async (provider: SyncOAuthProvider) => {
    setBusy(provider)
    setFormError(null)
    setOAuthStarted(null)
    try {
      await api.sync.signInWithOAuth({ provider })
      setOAuthStarted(provider)
    } catch (error) {
      setFormError(errorMessage(error, t('account.oauthFailed')))
    } finally {
      setBusy(null)
    }
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

        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            className="relative flex h-10 w-full items-center justify-center rounded-lg border border-[#dadce0] bg-white px-4 text-sm font-medium text-[#3c4043] transition-colors hover:bg-[#f8faff] active:bg-[#f1f3f4] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void authenticateWithOAuth('google')}
          >
            <span className="absolute left-4 flex items-center">
              {busy === 'google' ? <CircleNotch className="h-[18px] w-[18px] animate-spin" /> : <GoogleMark />}
            </span>
            {t('account.continueWithGoogle')}
          </button>
          <button
            type="button"
            className="relative flex h-10 w-full items-center justify-center rounded-lg border border-black bg-black px-4 text-sm font-medium text-white transition-colors hover:bg-[#1f1f1f] active:bg-[#333] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void authenticateWithOAuth('apple')}
          >
            <span className="absolute left-4 flex items-center">
              {busy === 'apple' ? <CircleNotch className="h-5 w-5 animate-spin" /> : <AppleMark />}
            </span>
            {t('account.continueWithApple')}
          </button>
        </div>

        {oauthStarted && (
          <p className="mt-3 text-center text-label leading-relaxed text-muted" role="status">
            {t('account.finishOAuthInBrowser')}
          </p>
        )}

        <div className="my-5 flex items-center gap-3" role="separator">
          <span className="h-px flex-1 bg-border" />
          <span className="text-label text-muted">{t('account.orContinueWithEmail')}</span>
          <span className="h-px flex-1 bg-border" />
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
