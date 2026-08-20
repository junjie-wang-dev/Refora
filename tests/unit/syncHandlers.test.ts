import { describe, expect, it, vi } from 'vitest'
import { createSyncHandlers } from '../../src/main/sidecar/ipc/sync'
import { IpcChannel } from '../../src/shared/ipc-channels'
import type { SyncAccountService } from '../../src/main/services/syncAccount'

describe('sync IPC handlers', () => {
  it('keeps account operations inside Result envelopes', async () => {
    const status = {
      configured: true,
      syncAvailable: false,
      signedIn: false,
      enabled: false,
      state: 'signedOut' as const,
      account: null
    }
    const service = {
      status: vi.fn(() => status),
      signIn: vi.fn().mockResolvedValue(status),
      signUp: vi.fn(),
      resendConfirmation: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn(),
      setEnabled: vi.fn().mockRejectedValue(Object.assign(
        new Error('Sign in before enabling sync'),
        { code: 'sync_sign_in_required' }
      ))
    } as unknown as SyncAccountService
    const handlers = createSyncHandlers(service)

    await expect(handlers[IpcChannel.SyncStatus]()).resolves.toEqual({ ok: true, data: status })
    await expect(handlers[IpcChannel.SyncResendConfirmation]({
      email: 'reader@example.com'
    })).resolves.toEqual({ ok: true, data: undefined })
    await expect(handlers[IpcChannel.SyncSetEnabled](true)).resolves.toEqual({
      ok: false,
      error: {
        code: 'sync_sign_in_required',
        message: 'Sign in before enabling sync'
      }
    })
  })
})
