import type {
  SyncCredentials,
  SyncEmailRequest,
  SyncServiceStatus,
  SyncSignUpResult
} from '../../shared/sync-types'
import { MainProcessError } from './errors'
import { logger } from './logger'
import type { SupabaseAuthClient } from './supabaseAuth'
import type { SyncSessionStore } from './syncSessionStore'

export interface SyncAccountService {
  status(): Promise<SyncServiceStatus>
  signIn(credentials: SyncCredentials): Promise<SyncServiceStatus>
  signUp(credentials: SyncCredentials): Promise<SyncSignUpResult>
  resendConfirmation(request: SyncEmailRequest): Promise<void>
  signOut(): Promise<SyncServiceStatus>
  setEnabled(enabled: boolean): Promise<SyncServiceStatus>
}

export interface SyncAccountServiceDeps {
  configured: boolean
  auth: SupabaseAuthClient | null
  sessions: SyncSessionStore
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim() : ''
  if (!email || email.length > 320 || !email.includes('@')) {
    throw new MainProcessError('invalid_argument', 'Enter a valid email address')
  }
  return email
}

function normalizeCredentials(credentials: SyncCredentials): SyncCredentials {
  const email = normalizeEmail(credentials?.email)
  const password = typeof credentials?.password === 'string' ? credentials.password : ''
  if (!password || password.length > 4096) {
    throw new MainProcessError('invalid_argument', 'Enter a password')
  }
  return { email, password }
}

export function createSyncAccountService(deps: SyncAccountServiceDeps): SyncAccountService {
  let refreshInFlight: Promise<ReturnType<SyncSessionStore['load']>> | null = null
  let sessionGeneration = 0

  function requireAuth(): SupabaseAuthClient {
    if (!deps.configured || !deps.auth) {
      throw new MainProcessError(
        'sync_unconfigured',
        'Supabase sync is not configured in this build'
      )
    }
    return deps.auth
  }

  function currentStatus(session = deps.sessions.load()): SyncServiceStatus {
    if (!deps.configured) {
      return {
        configured: false,
        syncAvailable: false,
        signedIn: false,
        enabled: false,
        state: 'unconfigured',
        account: null
      }
    }
    if (!session) {
      return {
        configured: true,
        syncAvailable: false,
        signedIn: false,
        enabled: false,
        state: 'signedOut',
        account: null
      }
    }
    return {
      configured: true,
      syncAvailable: false,
      signedIn: true,
      enabled: false,
      state: 'disabled',
      account: session.user
    }
  }

  async function activeSession(): Promise<ReturnType<SyncSessionStore['load']>> {
    const session = deps.sessions.load()
    if (!session || !deps.configured || !deps.auth) return session
    if (session.expiresAt > Math.floor(Date.now() / 1000) + 60) return session
    if (refreshInFlight) return refreshInFlight
    const generation = sessionGeneration
    refreshInFlight = (async () => {
      try {
        const refreshed = await deps.auth!.refresh(session.refreshToken)
        const current = deps.sessions.load()
        if (
          generation !== sessionGeneration ||
          !current ||
          current.refreshToken !== session.refreshToken
        ) {
          return current
        }
        deps.sessions.save(refreshed)
        return refreshed
      } catch (error) {
        const current = deps.sessions.load()
        if (
          generation !== sessionGeneration ||
          !current ||
          current.refreshToken !== session.refreshToken
        ) {
          return current
        }
        if (
          error
          && typeof error === 'object'
          && (error as { code?: unknown }).code === 'sync_auth_failed'
        ) {
          deps.sessions.clear()
          return null
        }
        throw error
      } finally {
        refreshInFlight = null
      }
    })()
    return refreshInFlight
  }

  return {
    async status() {
      return currentStatus(await activeSession())
    },
    async signIn(input) {
      const credentials = normalizeCredentials(input)
      const auth = requireAuth()
      const generation = ++sessionGeneration
      const session = await auth.signIn(credentials.email, credentials.password)
      if (generation !== sessionGeneration) return currentStatus(deps.sessions.load())
      deps.sessions.save(session)
      return currentStatus(session)
    },
    async signUp(input) {
      const credentials = normalizeCredentials(input)
      const auth = requireAuth()
      const generation = ++sessionGeneration
      const response = await auth.signUp(credentials.email, credentials.password)
      if (generation !== sessionGeneration) {
        return {
          status: currentStatus(deps.sessions.load()),
          confirmationRequired: false
        }
      }
      if (response.session) {
        deps.sessions.save(response.session)
      } else {
        deps.sessions.clear()
      }
      return {
        status: currentStatus(response.session),
        confirmationRequired: response.session === null
      }
    },
    async resendConfirmation(input) {
      const email = normalizeEmail(input?.email)
      await requireAuth().resendConfirmation(email)
    },
    async signOut() {
      const generation = ++sessionGeneration
      const session = deps.sessions.load()
      deps.sessions.clear()
      if (session && deps.auth) {
        try {
          await deps.auth.signOut(session.accessToken)
        } catch (error) {
          logger.warn(
            `sync-account:remote sign-out failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      return currentStatus(generation === sessionGeneration ? null : deps.sessions.load())
    },
    async setEnabled(enabled) {
      if (typeof enabled !== 'boolean') {
        throw new MainProcessError('invalid_argument', 'Sync enabled must be a boolean')
      }
      if (!enabled) {
        return currentStatus(await activeSession())
      }
      requireAuth()
      const session = await activeSession()
      if (!session) {
        throw new MainProcessError('sync_sign_in_required', 'Sign in before enabling sync')
      }
      throw new MainProcessError(
        'sync_engine_unavailable',
        'Metadata sync is not available in this version of Refora'
      )
    }
  }
}
