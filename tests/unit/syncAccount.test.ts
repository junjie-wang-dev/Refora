import { describe, expect, it, vi } from 'vitest'
import { createSyncAccountService } from '../../src/main/services/syncAccount'
import type { SupabaseSession } from '../../src/main/services/supabaseAuth'
import type { MetadataSyncEngine } from '../../src/main/services/metadataSyncEngine'

const session: SupabaseSession = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 2_000_000_000,
  user: { id: 'user-1', email: 'reader@example.com' }
}

function setup(
  initialSession: SupabaseSession | null = null,
  engine?: MetadataSyncEngine
) {
  let stored = initialSession
  const auth = {
    signIn: vi.fn().mockResolvedValue(session),
    beginOAuth: vi.fn(() => ({ url: 'https://project.supabase.co/auth/v1/authorize', rollback: vi.fn() })),
    exchangeOAuthCode: vi.fn().mockResolvedValue(session),
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
    sessions,
    engine
  })
  return { service, auth, sessions }
}

describe('sync account service', () => {
  it('starts signed out and reports the authenticated account after sign-in', async () => {
    const { service } = setup()
    await expect(service.status()).resolves.toMatchObject({ signedIn: false })

    await expect(service.signIn({
      email: ' reader@example.com ',
      password: 'password'
    })).resolves.toMatchObject({
      signedIn: true,
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
        beginOAuth: vi.fn(),
        exchangeOAuthCode: vi.fn(),
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

  it('does not restore a refreshed session after sign-out', async () => {
    let resolveRefresh: (value: SupabaseSession) => void = () => undefined
    const refreshResult = new Promise<SupabaseSession>((resolve) => {
      resolveRefresh = resolve
    })
    const { service, auth, sessions } = setup({ ...session, expiresAt: 1 })
    auth.refresh.mockReturnValue(refreshResult)
    const refreshing = service.status()
    await vi.waitFor(() => expect(auth.refresh).toHaveBeenCalledOnce())

    await service.signOut()
    resolveRefresh({
      ...session,
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh'
    })

    await expect(refreshing).resolves.toMatchObject({ signedIn: false })
    await expect(service.status()).resolves.toMatchObject({ signedIn: false })
    expect(sessions.save).not.toHaveBeenCalled()
  })

  it('does not let an old refresh overwrite a newer sign-in', async () => {
    let resolveRefresh: (value: SupabaseSession) => void = () => undefined
    const refreshResult = new Promise<SupabaseSession>((resolve) => {
      resolveRefresh = resolve
    })
    const { service, auth, sessions } = setup({ ...session, expiresAt: 1 })
    auth.refresh.mockReturnValue(refreshResult)
    const refreshing = service.status()
    await vi.waitFor(() => expect(auth.refresh).toHaveBeenCalledOnce())

    await service.signIn({ email: session.user.email, password: 'password' })
    const stale = {
      ...session,
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh'
    }
    resolveRefresh(stale)

    await expect(refreshing).resolves.toMatchObject({ signedIn: true })
    expect(sessions.save).toHaveBeenCalledWith(session)
    expect(sessions.save).not.toHaveBeenCalledWith(stale)
  })

  it('does not complete a pending sign-in after a later sign-out', async () => {
    let resolveSignIn: (value: SupabaseSession) => void = () => undefined
    const signInResult = new Promise<SupabaseSession>((resolve) => {
      resolveSignIn = resolve
    })
    const { service, auth, sessions } = setup()
    auth.signIn.mockReturnValue(signInResult)
    const signingIn = service.signIn({ email: session.user.email, password: 'password' })
    await vi.waitFor(() => expect(auth.signIn).toHaveBeenCalledOnce())

    await service.signOut()
    resolveSignIn(session)

    await expect(signingIn).resolves.toMatchObject({ signedIn: false })
    expect(sessions.save).not.toHaveBeenCalled()
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

  it('opens OAuth in the system browser and saves the exchanged session', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const { auth, sessions } = setup()
    const oauthService = createSyncAccountService({
      configured: true,
      auth,
      sessions,
      openExternal
    })

    await expect(oauthService.signInWithOAuth({ provider: 'google' })).resolves.toBeUndefined()
    expect(auth.beginOAuth).toHaveBeenCalledWith('google')
    expect(openExternal).toHaveBeenCalledWith('https://project.supabase.co/auth/v1/authorize')

    await expect(oauthService.completeOAuth({
      provider: 'google',
      code: 'auth-code',
      codeVerifier: 'code-verifier'
    })).resolves.toMatchObject({ signedIn: true, account: session.user })
    expect(auth.exchangeOAuthCode).toHaveBeenCalledWith('auth-code', 'code-verifier')
    expect(sessions.save).toHaveBeenCalledWith(session)
  })

  it('rolls back the pending OAuth callback when the browser cannot open', async () => {
    const rollback = vi.fn()
    const { service: _service, auth, sessions } = setup()
    auth.beginOAuth.mockReturnValue({ url: 'https://project.supabase.co/auth/v1/authorize', rollback })
    const service = createSyncAccountService({
      configured: true,
      auth,
      sessions,
      openExternal: vi.fn().mockRejectedValue(new Error('browser unavailable'))
    })

    await expect(service.signInWithOAuth({ provider: 'apple' })).rejects.toMatchObject({
      code: 'sync_oauth_launch_failed'
    })
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('clears the session when signing out', async () => {
    const { service, sessions, auth } = setup(session)
    await expect(service.signOut()).resolves.toMatchObject({
      signedIn: false
    })
    expect(sessions.clear).toHaveBeenCalled()
    expect(auth.signOut).toHaveBeenCalledWith('access')
  })

  it('waits for an active metadata sync before completing sign-out', async () => {
    let releaseSync: () => void = () => undefined
    const activeSync = new Promise<void>((resolve) => {
      releaseSync = resolve
    })
    const waitForIdle = vi.fn(async () => activeSync)
    const { service, sessions, auth } = setup(session, {
      waitForIdle
    } as unknown as MetadataSyncEngine)

    const signingOut = service.signOut()
    await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledOnce())
    expect(sessions.clear).toHaveBeenCalled()
    expect(auth.signOut).not.toHaveBeenCalled()

    releaseSync()
    await signingOut

    expect(auth.signOut).toHaveBeenCalledWith('access')
  })
})
