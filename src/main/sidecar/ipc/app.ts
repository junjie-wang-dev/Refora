import { IpcChannel } from '../../../shared/ipc-channels'
import type { Result, ThemeMode } from '../../../shared/ipc-types'
import type { ServerClient } from '../client'

export interface ServerAppHandlerDeps {
  setThemeSource: (theme: ThemeMode) => void
}

function toErrorResult(error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'internal_error'
  return { ok: false, error: { code, message } }
}

async function forward<T>(request: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await request() }
  } catch (error) {
    return toErrorResult(error)
  }
}

export function createServerAppHandlers(
  serverClient: ServerClient,
  { setThemeSource }: ServerAppHandlerDeps
) {
  const { http } = serverClient

  return {
    [IpcChannel.Bootstrap]: () => forward(() => http.appBootstrap()),
    [IpcChannel.GlobalSearch]: (query: string) => forward(() => http.globalSearch(query)),
    [IpcChannel.DialogOpenDirectory]: () =>
      forward(async () => {
        const result = await http.dialogOpenDirectory('Select Folder')
        return result.canceled ? null : result.path
      }),
    [IpcChannel.AppearanceSetThemeSource]: (theme: ThemeMode) =>
      forward(async () => {
        if (theme !== 'system' && theme !== 'dark' && theme !== 'light') {
          throw Object.assign(new Error('Invalid theme source'), { code: 'invalid_argument' })
        }
        setThemeSource(theme)
      })
  }
}

export type ServerAppHandlerMap = ReturnType<typeof createServerAppHandlers>
