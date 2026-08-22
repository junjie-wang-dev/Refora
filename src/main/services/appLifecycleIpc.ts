import { IpcChannel } from '../../shared/ipc-channels'
import type { Result } from '../../shared/ipc-types'

interface AppLifecycleIpcDeps {
  completeRendererFlush: (requestId: string, error?: string) => boolean
}

export function createAppLifecycleIpcHandlers(deps: AppLifecycleIpcDeps) {
  return {
    [IpcChannel.RendererFlushComplete]: async (
      requestId: unknown,
      error?: unknown
    ): Promise<Result<void>> => {
      if (typeof requestId !== 'string' || (error !== undefined && typeof error !== 'string')) {
        return {
          ok: false,
          error: { code: 'invalid_request', message: 'Invalid renderer flush response' }
        }
      }
      if (!deps.completeRendererFlush(requestId, error)) {
        return {
          ok: false,
          error: {
            code: 'unknown_request',
            message: 'Renderer flush request is no longer active'
          }
        }
      }
      return { ok: true, data: undefined }
    }
  }
}
