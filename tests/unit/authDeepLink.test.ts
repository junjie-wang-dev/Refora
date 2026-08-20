import { describe, expect, it } from 'vitest'
import {
  AUTH_CONFIRMATION_REDIRECT_URL,
  parseAuthConfirmationDeepLink
} from '../../src/main/services/authDeepLink'

describe('auth confirmation deep link', () => {
  it('accepts the exact Refora confirmation destination without exposing tokens', () => {
    expect(AUTH_CONFIRMATION_REDIRECT_URL).toBe('refora://auth/confirmed')
    expect(parseAuthConfirmationDeepLink(
      'refora://auth/confirmed#access_token=secret&type=signup'
    )).toEqual({ status: 'confirmed', message: null })
  })

  it('returns a bounded Supabase callback error', () => {
    expect(parseAuthConfirmationDeepLink(
      'refora://auth/confirmed#error=access_denied&error_description=Confirmation%20expired'
    )).toEqual({ status: 'error', message: 'Confirmation expired' })
  })

  it('rejects unrelated and lookalike URLs', () => {
    expect(parseAuthConfirmationDeepLink('https://example.com/auth/confirmed')).toBeNull()
    expect(parseAuthConfirmationDeepLink('refora://other/confirmed')).toBeNull()
    expect(parseAuthConfirmationDeepLink('refora://auth/other')).toBeNull()
    expect(parseAuthConfirmationDeepLink('not a url')).toBeNull()
  })
})
