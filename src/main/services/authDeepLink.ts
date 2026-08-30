import { randomUUID } from 'node:crypto'
import type { SyncAuthConfirmation, SyncOAuthProvider } from '../../shared/sync-types'

export const AUTH_CONFIRMATION_REDIRECT_URL = 'refora://auth/confirmed'
export const AUTH_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000

export interface PendingAuthConfirmation {
  nonce: string
  createdAt: number
  flow?: 'email_confirmation' | 'oauth'
  provider?: SyncOAuthProvider
  codeVerifier?: string
}

export interface AuthConfirmationRedirect {
  url: string
  clear(): void
  rollback(): void
}

export interface AuthConfirmationIssue {
  flow: 'oauth'
  provider: SyncOAuthProvider
  codeVerifier: string
}

export interface SyncOAuthCallback {
  provider: SyncOAuthProvider
  code: string
  codeVerifier: string
}

export interface AuthDeepLinkResult {
  confirmation: SyncAuthConfirmation
  oauth: SyncOAuthCallback | null
}

interface AuthConfirmationGuardDeps {
  readPending: () => PendingAuthConfirmation | null
  writePending: (pending: PendingAuthConfirmation | null) => void
  now?: () => number
  createNonce?: () => string
  ttlMs?: number
}

function callbackParams(url: URL): URLSearchParams {
  const params = new URLSearchParams(url.search)
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  for (const [key, value] of fragment) {
    if (!params.has(key)) params.set(key, value)
  }
  return params
}

export function parseAuthConfirmationDeepLink(
  value: string,
  expectedNonce: string
): SyncAuthConfirmation | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== 'refora:'
    || url.hostname !== 'auth'
    || url.pathname !== '/confirmed'
    || url.username
    || url.password
  ) {
    return null
  }

  const params = callbackParams(url)
  if (!expectedNonce || params.get('nonce') !== expectedNonce) return null
  const error = params.get('error_description') ?? params.get('error')
  if (error) {
    return {
      status: 'error',
      message: error.slice(0, 500)
    }
  }
  return { status: 'confirmed', message: null }
}

export function createAuthConfirmationGuard(deps: AuthConfirmationGuardDeps) {
  const now = deps.now ?? Date.now
  const createNonce = deps.createNonce ?? randomUUID
  const ttlMs = deps.ttlMs ?? AUTH_CONFIRMATION_TTL_MS

  function clearIfCurrent(nonce: string, replacement: PendingAuthConfirmation | null): void {
    if (deps.readPending()?.nonce === nonce) deps.writePending(replacement)
  }

  function issue(options?: AuthConfirmationIssue): AuthConfirmationRedirect {
    const previous = deps.readPending()
    const pending: PendingAuthConfirmation = {
      nonce: createNonce(),
      createdAt: now(),
      ...(options ?? {})
    }
    deps.writePending(pending)
    const url = new URL(AUTH_CONFIRMATION_REDIRECT_URL)
    url.searchParams.set('nonce', pending.nonce)
    return {
      url: url.toString(),
      clear: () => clearIfCurrent(pending.nonce, null),
      rollback: () => clearIfCurrent(pending.nonce, previous)
    }
  }

  function consume(value: string): AuthDeepLinkResult | null {
    const pending = deps.readPending()
    if (!pending) return null
    const age = now() - pending.createdAt
    if (age < 0 || age > ttlMs) {
      deps.writePending(null)
      return null
    }
    const confirmation = parseAuthConfirmationDeepLink(value, pending.nonce)
    if (!confirmation) return null
    deps.writePending(null)
    if (pending.flow !== 'oauth') return { confirmation, oauth: null }
    const oauthConfirmation: SyncAuthConfirmation = {
      ...confirmation,
      flow: 'oauth',
      provider: pending.provider
    }
    if (confirmation.status === 'error') {
      return { confirmation: oauthConfirmation, oauth: null }
    }
    const params = callbackParams(new URL(value))
    const code = params.get('code') ?? ''
    if (
      (pending.provider !== 'google' && pending.provider !== 'apple')
      || !pending.codeVerifier
      || pending.codeVerifier.length > 128
      || !code
      || code.length > 2048
    ) {
      return {
        confirmation: {
          status: 'error',
          message: 'Supabase returned an invalid OAuth callback',
          flow: 'oauth',
          provider: pending.provider
        },
        oauth: null
      }
    }
    return {
      confirmation: oauthConfirmation,
      oauth: {
        provider: pending.provider,
        code,
        codeVerifier: pending.codeVerifier
      }
    }
  }

  return { issue, consume }
}

export type AuthConfirmationGuard = ReturnType<typeof createAuthConfirmationGuard>
