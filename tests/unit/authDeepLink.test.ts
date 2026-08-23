import { describe, expect, it } from 'vitest'
import {
  AUTH_CONFIRMATION_REDIRECT_URL,
  AUTH_CONFIRMATION_TTL_MS,
  createAuthConfirmationGuard,
  parseAuthConfirmationDeepLink
} from '../../src/main/services/authDeepLink'

describe('auth confirmation deep link', () => {
  it('accepts only the exact Refora confirmation destination with the expected nonce', () => {
    expect(AUTH_CONFIRMATION_REDIRECT_URL).toBe('refora://auth/confirmed')
    expect(parseAuthConfirmationDeepLink(
      'refora://auth/confirmed?nonce=expected#access_token=secret&type=signup',
      'expected'
    )).toEqual({ status: 'confirmed', message: null })
    expect(parseAuthConfirmationDeepLink(
      'refora://auth/confirmed?nonce=forged',
      'expected'
    )).toBeNull()
  })

  it('returns a bounded Supabase callback error', () => {
    expect(parseAuthConfirmationDeepLink(
      'refora://auth/confirmed?nonce=expected#error=access_denied&error_description=Confirmation%20expired',
      'expected'
    )).toEqual({ status: 'error', message: 'Confirmation expired' })
  })

  it('rejects unrelated and lookalike URLs', () => {
    expect(parseAuthConfirmationDeepLink('https://example.com/auth/confirmed', 'nonce')).toBeNull()
    expect(parseAuthConfirmationDeepLink('refora://other/confirmed', 'nonce')).toBeNull()
    expect(parseAuthConfirmationDeepLink('refora://auth/other', 'nonce')).toBeNull()
    expect(parseAuthConfirmationDeepLink('not a url', 'nonce')).toBeNull()
  })

  it('binds callbacks to a pending single-use signup nonce', () => {
    let pending: { nonce: string; createdAt: number } | null = null
    const guard = createAuthConfirmationGuard({
      readPending: () => pending,
      writePending: (value) => { pending = value },
      now: () => 10_000,
      createNonce: () => 'signup-nonce'
    })
    const redirect = guard.issue()

    expect(redirect.url).toBe('refora://auth/confirmed?nonce=signup-nonce')
    expect(guard.consume(redirect.url)).toEqual({ status: 'confirmed', message: null })
    expect(pending).toBeNull()
    expect(guard.consume(redirect.url)).toBeNull()
  })

  it('rejects and clears an expired pending confirmation', () => {
    let pending: { nonce: string; createdAt: number } | null = {
      nonce: 'expired',
      createdAt: 1
    }
    const guard = createAuthConfirmationGuard({
      readPending: () => pending,
      writePending: (value) => { pending = value },
      now: () => AUTH_CONFIRMATION_TTL_MS + 2
    })

    expect(guard.consume('refora://auth/confirmed?nonce=expired')).toBeNull()
    expect(pending).toBeNull()
  })
})
