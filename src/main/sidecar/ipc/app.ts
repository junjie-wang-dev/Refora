import { IpcChannel } from '../../../shared/ipc-channels'
import type { ThemeMode } from '../../../shared/ipc-types'
import type { ServerClient } from '../client'
import { resultify } from './result'

export interface ServerAppHandlerDeps {
  setThemeSource: (theme: ThemeMode) => void
  authorizeFile?: (path: string) => string
  authorizeDirectory?: (path: string) => string
}

export function createServerAppHandlers(
  serverClient: ServerClient,
  { setThemeSource, authorizeFile, authorizeDirectory }: ServerAppHandlerDeps
) {
  const { http } = serverClient

  return {
    [IpcChannel.Bootstrap]: () => resultify(() => http.appBootstrap()),
    [IpcChannel.GlobalSearch]: (query: string) => resultify(() => http.globalSearch(query)),
    [IpcChannel.DialogOpenDirectory]: () =>
      resultify(async () => {
        const result = await http.dialogOpenDirectory('Select Folder')
        if (result.canceled || !result.path) return null
        return authorizeDirectory ? authorizeDirectory(result.path) : result.path
      }),
    [IpcChannel.FileAuthorizeDropped]: (path: string) =>
      resultify(async () => authorizeFile ? authorizeFile(path) : path),
    [IpcChannel.AppearanceSetThemeSource]: (theme: ThemeMode) =>
      resultify(async () => {
        if (theme !== 'system' && theme !== 'dark' && theme !== 'light') {
          throw Object.assign(new Error('Invalid theme source'), { code: 'invalid_argument' })
        }
        setThemeSource(theme)
      })
  }
}

export type ServerAppHandlerMap = ReturnType<typeof createServerAppHandlers>
