import { describe, expect, it, vi } from 'vitest'
import { createSyncAccountService } from '../../src/main/services/syncAccount'
import type { SupabaseSession } from '../../src/main/services/supabaseAuth'

const session: SupabaseSession = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 2_000_000_000,
  user: { id: 'user-1', email: 'reader@example.com' }
}

function setup(initialSession: SupabaseSession | null = null) {
  let stored = initialSession
  const auth = {
    signIn: vi.fn().mockResolvedValue(session),
    signUp: vi.fn().mockResolvedValue({ session: null, user: session.user }),
    resendConfirmation: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(session),
    signOut: vi.fn().mockResolvedValue(undefined)
  }
  const sessions = {
    load: vi.fn(() => stored),
    save: vi.fn((next: SupabaseSession) => {
      stored = next
    }),
    clear: vi.fn(() => {
      stored = null
    })
  }
  const service = createSyncAccountService({
    configured: true,
    auth,
    sessions
  })
  return { service, auth, sessions }
}

describe('sync account service', () => {
  it('starts signed out and keeps sync disabled after sign-in', async () => {
    const { service } = setup()
    await expect(service.status()).resolves.toMatchObject({ state: 'signedOut', enabled: false })

    await expect(service.signIn({
      email: ' reader@example.com ',
      password: 'password'
    })).resolves.toMatchObject({
      state: 'disabled',
      syncAvailable: false,
      signedIn: true,
      enabled: false,
      account: session.user
    })
  })

  it('does not report sign-in success when the encrypted session cannot be saved', async () => {
    const sessions = {
      load: vi.fn(() => null),
      save: vi.fn(),
      clear: vi.fn()
    }
    const service = createSyncAccountService({
      configured: true,
      auth: {
        signIn: vi.fn().mockResolvedValue(session),
        signUp: vi.fn(),
        resendConfirmation: vi.fn(),
        refresh: vi.fn(),
        signOut: vi.fn()
      },
      sessions: {
        ...sessions,
        save: vi.fn(() => {
          throw new Error('disk full')
        })
      }
    })

    await expect(service.signIn({
      email: 'reader@example.com',
      password: 'password'
    })).rejects.toThrow('disk full')
  })

  it('requires an account before enabling metadata sync', async () => {
    const { service } = setup()
    await expect(service.setEnabled(true)).rejects.toMatchObject({
      code: 'sync_sign_in_required'
    })
    await expect(service.status()).resolves.toMatchObject({ enabled: false })
  })

  it('cannot enable sync when the Supabase build configuration is unavailable', async () => {
    const service = createSyncAccountService({
      configured: false,
      auth: null,
      sessions: {
        load: () => session,
        save: vi.fn(),
        clear: vi.fn()
      }
    })

    await expect(service.setEnabled(true)).rejects.toMatchObject({ code: 'sync_unconfigured' })
  })

  it('does not claim synchronization is enabled before the data engine exists', async () => {
    const { service } = setup(session)
    await expect(service.setEnabled(true)).rejects.toMatchObject({
      code: 'sync_engine_unavailable'
    })
    await expect(service.status()).resolves.toMatchObject({
      enabled: false,
      syncAvailable: false
    })
  })

  it('refreshes an expiring session and saves rotated credentials', async () => {
    const expired = { ...session, expiresAt: 1 }
    const refreshed = {
      ...session,
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    }
    const { service, auth, sessions } = setup(expired)
    auth.refresh.mockResolvedValue(refreshed)

    await expect(service.status()).resolves.toMatchObject({ signedIn: true })

    expect(auth.refresh).toHaveBeenCalledWith('refresh')
    expect(sessions.save).toHaveBeenCalledWith(refreshed)
  })

  it('deduplicates concurrent session refreshes', async () => {
    let resolveRefresh!: (value: SupabaseSession) => void
    const refreshResult = new Promise<SupabaseSession>((resolve) => {
      resolveRefresh = resolve
    })
    const { service, auth } = setup({ ...session, expiresAt: 1 })
    auth.refresh.mockReturnValue(refreshResult)

    const first = service.status()
    const second = service.status()
    resolveRefresh({ ...session, expiresAt: Math.floor(Date.now() / 1000) + 3600 })

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(auth.refresh).toHaveBeenCalledTimes(1)
  })

  it('clears a session rejected by the refresh endpoint', async () => {
    const { service, auth, sessions } = setup({ ...session, expiresAt: 1 })
    auth.refresh.mockRejectedValue(Object.assign(new Error('Refresh token is invalid'), {
      code: 'sync_auth_failed'
    }))

    await expect(service.status()).resolves.toMatchObject({ signedIn: false })

    expect(sessions.clear).toHaveBeenCalled()
  })

  it('keeps an expired session when refresh fails because the network is offline', async () => {
    const { service, auth, sessions } = setup({ ...session, expiresAt: 1 })
    auth.refresh.mockRejectedValue(Object.assign(new Error('offline'), {
      code: 'sync_network_error'
    }))

    await expect(service.status()).rejects.toMatchObject({ code: 'sync_network_error' })

    expect(sessions.clear).not.toHaveBeenCalled()
  })

  it('resends signup confirmation through the configured auth client', async () => {
    const { service, auth } = setup()
    await expect(service.resendConfirmation({
      email: ' reader@example.com '
    })).resolves.toBeUndefined()
    expect(auth.resendConfirmation).toHaveBeenCalledWith('reader@example.com')
  })

  it('clears the session and disables sync when signing out', async () => {
    const { service, sessions, auth } = setup(session)
    await expect(service.signOut()).resolves.toMatchObject({
      state: 'signedOut',
      enabled: false
    })
    expect(sessions.clear).toHaveBeenCalled()
    expect(auth.signOut).toHaveBeenCalledWith('access')
  })
})
