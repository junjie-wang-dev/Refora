import type {
  SyncCredentials,
  SyncConflict,
  SyncConflictResolutionRequest,
  SyncEmailRequest,
  SyncEnabledRequest,
  SyncOAuthRequest,
  SyncServiceStatus,
  SyncSignUpResult
} from '../../shared/sync-types'
import { MainProcessError } from './errors'
import { logger } from './logger'
import type { SupabaseAuthClient } from './supabaseAuth'
import type { SyncOAuthCallback } from './authDeepLink'
import type { SyncSessionStore } from './syncSessionStore'
import type { MetadataSyncEngine } from './metadataSyncEngine'

export interface SyncAccountService {
  status(): Promise<SyncServiceStatus>
  signIn(credentials: SyncCredentials): Promise<SyncServiceStatus>
  signInWithOAuth(request: SyncOAuthRequest): Promise<void>
  completeOAuth(callback: SyncOAuthCallback): Promise<SyncServiceStatus>
  signUp(credentials: SyncCredentials): Promise<SyncSignUpResult>
  resendConfirmation(request: SyncEmailRequest): Promise<void>
  signOut(): Promise<SyncServiceStatus>
  setEnabled(request: SyncEnabledRequest): Promise<SyncServiceStatus>
  runNow(): Promise<SyncServiceStatus>
  waitForIdle(): Promise<void>
  conflicts(): Promise<SyncConflict[]>
  resolveConflict(request: SyncConflictResolutionRequest): Promise<SyncServiceStatus>
}

export interface SyncAccountServiceDeps {
  configured: boolean
  auth: SupabaseAuthClient | null
  sessions: SyncSessionStore
  engine?: MetadataSyncEngine | null
  openExternal?: (url: string) => Promise<void>
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

  function libraryStatus() {
    try {
      return deps.engine?.status() ?? null
    } catch {
      return null
    }
  }

  function currentStatus(session = deps.sessions.load()): SyncServiceStatus {
    if (!deps.configured) {
      return {
        configured: false,
        signedIn: false,
        account: null,
        library: libraryStatus()
      }
    }
    if (!session) {
      return {
        configured: true,
        signedIn: false,
        account: null,
        library: libraryStatus()
      }
    }
    return {
      configured: true,
      signedIn: true,
      account: session.user,
      library: libraryStatus()
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
    async signInWithOAuth(input) {
      if (!input || (input.provider !== 'google' && input.provider !== 'apple')) {
        throw new MainProcessError('invalid_argument', 'Select a supported sign-in provider')
      }
      if (!deps.openExternal) {
        throw new MainProcessError('sync_oauth_unavailable', 'External sign-in is unavailable')
      }
      const authorization = requireAuth().beginOAuth(input.provider)
      try {
        await deps.openExternal(authorization.url)
      } catch (error) {
        authorization.rollback()
        throw new MainProcessError(
          'sync_oauth_launch_failed',
          error instanceof Error ? error.message : 'Unable to open the sign-in page'
        )
      }
    },
    async completeOAuth(callback) {
      if (
        !callback
        || (callback.provider !== 'google' && callback.provider !== 'apple')
        || !callback.code
        || !callback.codeVerifier
      ) {
        throw new MainProcessError('invalid_argument', 'Supabase returned an invalid OAuth callback')
      }
      const generation = ++sessionGeneration
      const session = await requireAuth().exchangeOAuthCode(
        callback.code,
        callback.codeVerifier
      )
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
      try {
        await deps.engine?.waitForIdle()
      } catch (error) {
        logger.warn(
          `sync-account:pending sync failed during sign-out: ${error instanceof Error ? error.message : String(error)}`
        )
      }
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
    async setEnabled(request) {
      if (!request || typeof request.enabled !== 'boolean') {
        throw new MainProcessError('invalid_argument', 'Sync enabled state must be a boolean')
      }
      if (!deps.engine) throw new MainProcessError('sync_unavailable', 'Metadata sync is unavailable')
      if (!request.enabled) {
        deps.engine.setEnabled(false)
        return currentStatus(await activeSession())
      }
      const session = await activeSession()
      if (!session) throw new MainProcessError('sync_auth_required', 'Sign in before enabling sync')
      deps.engine.setEnabled(true)
      await deps.engine.run(session.accessToken)
      return currentStatus(await activeSession())
    },
    async runNow() {
      if (!deps.engine) throw new MainProcessError('sync_unavailable', 'Metadata sync is unavailable')
      const session = await activeSession()
      if (!session) throw new MainProcessError('sync_auth_required', 'Sign in before syncing')
      await deps.engine.run(session.accessToken)
      return currentStatus(await activeSession())
    },
    async waitForIdle() {
      await deps.engine?.waitForIdle()
    },
    async conflicts() {
      return deps.engine?.conflicts() ?? []
    },
    async resolveConflict(request) {
      if (!deps.engine) throw new MainProcessError('sync_unavailable', 'Metadata sync is unavailable')
      if (
        !request
        || typeof request.id !== 'string'
        || !request.id
        || (request.resolution !== 'keep_local' && request.resolution !== 'use_remote')
      ) throw new MainProcessError('invalid_argument', 'Sync conflict resolution is invalid')
      await deps.engine.resolveConflict(request.id, request.resolution)
      if (request.resolution === 'keep_local') {
        const session = await activeSession()
        if (!session) throw new MainProcessError('sync_auth_required', 'Sign in before syncing')
        await deps.engine.run(session.accessToken)
      }
      return currentStatus(await activeSession())
    }
  }
}
