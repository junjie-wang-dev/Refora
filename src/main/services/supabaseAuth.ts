import { createHash, randomBytes } from 'node:crypto'
import { MainProcessError } from './errors'
import type { SyncOAuthProvider } from '../../shared/sync-types'
import type { AuthConfirmationIssue, AuthConfirmationRedirect } from './authDeepLink'

export interface SupabaseUser {
  id: string
  email: string
}

export interface SupabaseSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: SupabaseUser
}

export interface SupabaseSignUpResponse {
  session: SupabaseSession | null
  user: SupabaseUser
}

export interface SupabaseOAuthAuthorization {
  url: string
  rollback(): void
}

export interface SupabaseAuthClient {
  signIn(email: string, password: string): Promise<SupabaseSession>
  beginOAuth(provider: SyncOAuthProvider): SupabaseOAuthAuthorization
  exchangeOAuthCode(code: string, codeVerifier: string): Promise<SupabaseSession>
  signUp(email: string, password: string): Promise<SupabaseSignUpResponse>
  resendConfirmation(email: string): Promise<void>
  refresh(refreshToken: string): Promise<SupabaseSession>
  signOut(accessToken: string): Promise<void>
}

export interface SupabaseAuthClientDeps {
  url: string
  publishableKey: string
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  issueConfirmationRedirect: (options?: AuthConfirmationIssue) => AuthConfirmationRedirect
  requestTimeoutMs?: number
}

interface AuthPayload {
  access_token?: unknown
  refresh_token?: unknown
  expires_at?: unknown
  expires_in?: unknown
  user?: unknown
}

function errorText(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const value = body as Record<string, unknown>
  for (const key of ['msg', 'message', 'error_description', 'error']) {
    if (typeof value[key] === 'string' && value[key].length > 0) return value[key].slice(0, 500)
  }
  return fallback
}

function parseUser(value: unknown): SupabaseUser {
  if (!value || typeof value !== 'object') {
    throw new MainProcessError('sync_auth_invalid_response', 'Supabase returned an invalid user')
  }
  const user = value as Record<string, unknown>
  if (
    typeof user.id !== 'string'
    || user.id.length === 0
    || typeof user.email !== 'string'
    || user.email.length === 0
  ) {
    throw new MainProcessError('sync_auth_invalid_response', 'Supabase returned an invalid user')
  }
  return { id: user.id, email: user.email }
}

function parseSession(value: AuthPayload): SupabaseSession {
  if (typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string') {
    throw new MainProcessError('sync_auth_invalid_response', 'Supabase returned an invalid session')
  }
  const expiresAt = typeof value.expires_at === 'number'
    ? value.expires_at
    : Math.floor(Date.now() / 1000) + (typeof value.expires_in === 'number' ? value.expires_in : 3600)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new MainProcessError('sync_auth_invalid_response', 'Supabase returned an invalid session')
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt,
    user: parseUser(value.user)
  }
}

export function createSupabaseAuthClient({
  url,
  publishableKey,
  fetch,
  issueConfirmationRedirect,
  requestTimeoutMs = 15_000
}: SupabaseAuthClientDeps): SupabaseAuthClient {
  const baseUrl = url.replace(/\/+$/, '')

  async function request(path: string, body: unknown, accessToken?: string): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            apikey: publishableKey,
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } catch (error) {
        if (controller.signal.aborted) {
          throw new MainProcessError('sync_request_timeout', 'Supabase did not respond in time')
        }
        throw new MainProcessError(
          'sync_network_error',
          error instanceof Error ? error.message : 'Unable to reach Supabase'
        )
      }
      let raw: string
      try {
        raw = await response.text()
      } catch (error) {
        if (controller.signal.aborted) {
          throw new MainProcessError('sync_request_timeout', 'Supabase did not respond in time')
        }
        throw new MainProcessError(
          'sync_network_error',
          error instanceof Error ? error.message : 'Unable to read the Supabase response'
        )
      }
      let parsed: unknown = null
      if (raw) {
        try {
          parsed = JSON.parse(raw) as unknown
        } catch {
          parsed = null
        }
      }
      if (!response.ok) {
        throw new MainProcessError(
          'sync_auth_failed',
          errorText(parsed, `Supabase authentication failed with HTTP ${response.status}`)
        )
      }
      return parsed
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    async signIn(email, password) {
      const payload = await request('/auth/v1/token?grant_type=password', { email, password })
      return parseSession(payload as AuthPayload)
    },
    beginOAuth(provider) {
      const codeVerifier = randomBytes(32).toString('base64url')
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
      const redirect = issueConfirmationRedirect({
        flow: 'oauth',
        provider,
        codeVerifier
      })
      const authorizationUrl = new URL(`${baseUrl}/auth/v1/authorize`)
      authorizationUrl.searchParams.set('provider', provider)
      authorizationUrl.searchParams.set('redirect_to', redirect.url)
      authorizationUrl.searchParams.set('code_challenge', codeChallenge)
      authorizationUrl.searchParams.set('code_challenge_method', 's256')
      return {
        url: authorizationUrl.toString(),
        rollback: redirect.rollback
      }
    },
    async exchangeOAuthCode(code, codeVerifier) {
      const payload = await request('/auth/v1/token?grant_type=pkce', {
        auth_code: code,
        code_verifier: codeVerifier
      })
      return parseSession(payload as AuthPayload)
    },
    async signUp(email, password) {
      const redirect = issueConfirmationRedirect()
      try {
        const payload = await request(
          `/auth/v1/signup?redirect_to=${encodeURIComponent(redirect.url)}`,
          { email, password }
        ) as AuthPayload
        const user = parseUser(payload.user ?? payload)
        const session = typeof payload.access_token === 'string' ? parseSession(payload) : null
        if (session) redirect.clear()
        return { user, session }
      } catch (error) {
        redirect.rollback()
        throw error
      }
    },
    async resendConfirmation(email) {
      const redirect = issueConfirmationRedirect()
      try {
        await request(`/auth/v1/resend?redirect_to=${encodeURIComponent(redirect.url)}`, {
          type: 'signup',
          email
        })
      } catch (error) {
        redirect.rollback()
        throw error
      }
    },
    async refresh(refreshToken) {
      const payload = await request('/auth/v1/token?grant_type=refresh_token', {
        refresh_token: refreshToken
      })
      return parseSession(payload as AuthPayload)
    },
    async signOut(accessToken) {
      await request('/auth/v1/logout', {}, accessToken)
    }
  }
}
