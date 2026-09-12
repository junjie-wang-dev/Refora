import { IpcChannel } from '../../../shared/ipc-channels'
import type { ThemeMode } from '../../../shared/ipc-types'
import type { ServerClient } from '../client'
import { resultify } from './result'

export interface ServerAppHandlerDeps {
  setThemeSource: (theme: ThemeMode) => void
  openDirectory: () => Promise<string | null>
  openExecutable: (executable: 'latexmk' | 'tectonic') => Promise<string | null>
  authorizeFile: (path: string) => string
  authorizeDirectory: (path: string) => string
}

export function createServerAppHandlers(
  serverClient: ServerClient,
  { setThemeSource, openDirectory, openExecutable, authorizeFile, authorizeDirectory }: ServerAppHandlerDeps
) {
  const { http } = serverClient

  return {
    [IpcChannel.Bootstrap]: () => resultify(() => http.appBootstrap()),
    [IpcChannel.GlobalSearch]: (query: string) => resultify(() => http.globalSearch(query)),
    [IpcChannel.DialogOpenDirectory]: () =>
      resultify(async () => {
        const path = await openDirectory()
        return path ? authorizeDirectory(path) : null
      }),
    [IpcChannel.DialogOpenExecutable]: (executable: 'latexmk' | 'tectonic') =>
      resultify(async () => {
        if (executable !== 'latexmk' && executable !== 'tectonic') {
          throw Object.assign(new Error('Unsupported LaTeX executable'), { code: 'invalid_argument' })
        }
        return openExecutable(executable)
      }),
    [IpcChannel.FileAuthorizeDropped]: (path: string) =>
      resultify(async () => authorizeFile(path)),
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
