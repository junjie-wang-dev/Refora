import { IpcChannel } from '../../../shared/ipc-channels'
import type { Result } from '../../../shared/ipc-types'
import type { SyncCredentials, SyncEmailRequest } from '../../../shared/sync-types'
import type { SyncAccountService } from '../../services/syncAccount'

function toErrorResult(error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object'
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'internal_error'
  return { ok: false, error: { code, message } }
}

async function forward<T>(request: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await request() }
  } catch (error) {
    return toErrorResult(error)
  }
}

export function createSyncHandlers(service: SyncAccountService) {
  return {
    [IpcChannel.SyncStatus]: () => forward(() => service.status()),
    [IpcChannel.SyncSignIn]: (credentials: SyncCredentials) =>
      forward(() => service.signIn(credentials)),
    [IpcChannel.SyncSignUp]: (credentials: SyncCredentials) =>
      forward(() => service.signUp(credentials)),
    [IpcChannel.SyncResendConfirmation]: (request: SyncEmailRequest) =>
      forward(() => service.resendConfirmation(request)),
    [IpcChannel.SyncSignOut]: () => forward(() => service.signOut()),
    [IpcChannel.SyncSetEnabled]: (enabled: boolean) =>
      forward(() => service.setEnabled(enabled))
  }
}
