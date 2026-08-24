import { IpcChannel } from '../../../shared/ipc-channels'
import type { SyncCredentials, SyncEmailRequest } from '../../../shared/sync-types'
import type { SyncAccountService } from '../../services/syncAccount'
import { resultify as forward } from './result'

export function createSyncHandlers(service: SyncAccountService) {
  return {
    [IpcChannel.SyncStatus]: () => forward(() => service.status()),
    [IpcChannel.SyncSignIn]: (credentials: SyncCredentials) =>
      forward(() => service.signIn(credentials)),
    [IpcChannel.SyncSignUp]: (credentials: SyncCredentials) =>
      forward(() => service.signUp(credentials)),
    [IpcChannel.SyncResendConfirmation]: (request: SyncEmailRequest) =>
      forward(() => service.resendConfirmation(request)),
    [IpcChannel.SyncSignOut]: () => forward(() => service.signOut())
  }
}
