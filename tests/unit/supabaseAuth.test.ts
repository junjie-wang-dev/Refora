import { describe, expect, it, vi } from 'vitest'
import { createSupabaseAuthClient } from '../../src/main/services/supabaseAuth'

const sessionPayload = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_at: 2_000_000_000,
  user: { id: 'user-1', email: 'reader@example.com' }
}

describe('Supabase auth client', () => {
  it('signs in with the publishable key and parses the session', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(sessionPayload)))
    const client = createSupabaseAuthClient({
      url: 'https://project.supabase.co/',
      publishableKey: 'sb_publishable_key',
      fetch
    })

    await expect(client.signIn('reader@example.com', 'password')).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 2_000_000_000,
      user: { id: 'user-1', email: 'reader@example.com' }
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://project.supabase.co/auth/v1/token?grant_type=password',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'sb_publishable_key' })
      })
    )
  })

  it('supports sign-up responses that require email confirmation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'user-1',
      email: 'reader@example.com',
      confirmation_sent_at: '2026-08-20T00:00:00Z'
    })))
    const client = createSupabaseAuthClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_key',
      fetch
    })

    await expect(client.signUp('reader@example.com', 'password')).resolves.toEqual({
      user: { id: 'user-1', email: 'reader@example.com' },
      session: null
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://project.supabase.co/auth/v1/signup?redirect_to=refora%3A%2F%2Fauth%2Fconfirmed',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('supports sign-up responses that immediately create a session', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(sessionPayload)))
    const client = createSupabaseAuthClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_key',
      fetch
    })

    await expect(client.signUp('reader@example.com', 'password')).resolves.toEqual({
      user: { id: 'user-1', email: 'reader@example.com' },
      session: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: 2_000_000_000,
        user: { id: 'user-1', email: 'reader@example.com' }
      }
    })
  })

  it('resends signup confirmation with the desktop callback', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'))
    const client = createSupabaseAuthClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_key',
      fetch
    })

    await expect(client.resendConfirmation('reader@example.com')).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      'https://project.supabase.co/auth/v1/resend?redirect_to=refora%3A%2F%2Fauth%2Fconfirmed',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 'signup', email: 'reader@example.com' })
      })
    )
  })

  it('rejects invalid session expiry values', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...sessionPayload,
      expires_at: -1
    })))
    const client = createSupabaseAuthClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_key',
      fetch
    })

    await expect(client.signIn('reader@example.com', 'password')).rejects.toMatchObject({
      code: 'sync_auth_invalid_response'
    })
  })

  it('aborts authentication requests that exceed the timeout', async () => {
    const fetch = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const client = createSupabaseAuthClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_key',
      fetch,
      requestTimeoutMs: 5
    })

    await expect(client.signIn('reader@example.com', 'password')).rejects.toMatchObject({
      code: 'sync_request_timeout'
    })
  })

  it('maps Supabase errors to a serializable auth error', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'Invalid login credentials' }),
      { status: 400 }
    ))
    const client = createSupabaseAuthClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_key',
      fetch
    })

    await expect(client.signIn('reader@example.com', 'wrong')).rejects.toMatchObject({
      code: 'sync_auth_failed',
      message: 'Invalid login credentials'
    })
  })
})
