import { describe, expect, it, vi } from 'vitest'
import { createSyncHandlers } from '../../src/main/sidecar/ipc/sync'
import { IpcChannel } from '../../src/shared/ipc-channels'
import type { SyncAccountService } from '../../src/main/services/syncAccount'

describe('sync IPC handlers', () => {
  it('keeps account operations inside Result envelopes', async () => {
    const status = {
      configured: true,
      signedIn: false,
      account: null
    }
    const service = {
      status: vi.fn(() => status),
      signIn: vi.fn().mockResolvedValue(status),
      signUp: vi.fn(),
      resendConfirmation: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn()
    } as unknown as SyncAccountService
    const handlers = createSyncHandlers(service)

    await expect(handlers[IpcChannel.SyncStatus]()).resolves.toEqual({ ok: true, data: status })
    await expect(handlers[IpcChannel.SyncResendConfirmation]({
      email: 'reader@example.com'
    })).resolves.toEqual({ ok: true, data: undefined })
  })
})
