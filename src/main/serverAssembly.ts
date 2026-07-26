import { ipcMain, net, type BrowserWindow } from 'electron'
import type { LibrarySwitchResult } from '../shared/ipc-types'
import { createServerAppHandlers } from './ipc/serverAppHandlers'
import { createServerAiHandlers } from './ipc/serverAiHandlers'
import { createServerEventBridge, type ServerEventBridge } from './ipc/serverEventBridge'
import { createServerLibraryHandlers } from './ipc/serverLibraryHandlers'
import { createServerWorkspaceHandlers } from './ipc/serverWorkspaceHandlers'
import { createNativeRpc, type NativeRpc } from './services/nativeRpc'
import { createServerClient, type ServerClient } from './services/serverClient'
import type { ServerLifecycle } from './services/serverLifecycle'

export interface ServerAssemblyDeps {
  lifecycle: ServerLifecycle
  getWin: () => BrowserWindow | null
  switchLibraryFolder?: (path: string) => Promise<LibrarySwitchResult>
}

export interface ServerAssembly {
  start(): Promise<void>
  stop(): Promise<void>
  getClient(): ServerClient
  fetchResource(path: string, headers?: Headers): Promise<Response>
}

export function createServerAssembly(deps: ServerAssemblyDeps): ServerAssembly {
  let nativeRpc: NativeRpc | null = null
  let serverClient: ServerClient | null = null
  let eventBridge: ServerEventBridge | null = null
  let handlerChannels: string[] = []

  async function start(): Promise<void> {
    const connection = await deps.lifecycle.start()
    nativeRpc = createNativeRpc({
      token: connection.token,
      getWin: deps.getWin
    })
    await nativeRpc.start()
    serverClient = createServerClient(deps.lifecycle, nativeRpc)
    await serverClient.ws.connect()
    eventBridge = createServerEventBridge({
      serverClient,
      getWin: deps.getWin
    })
    eventBridge.start()

    const handlers = {
      ...createServerAppHandlers(serverClient),
      ...createServerLibraryHandlers({
        serverClient,
        switchLibraryFolder: deps.switchLibraryFolder
      }),
      ...createServerWorkspaceHandlers(serverClient),
      ...createServerAiHandlers({ serverClient })
    }
    handlerChannels = Object.keys(handlers)
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.handle(channel, (_event, ...args) =>
        (handler as (...handlerArgs: unknown[]) => unknown)(...args)
      )
    }
  }

  async function stop(): Promise<void> {
    eventBridge?.stop()
    serverClient?.ws.disconnect()
    for (const channel of handlerChannels) ipcMain.removeHandler(channel)
    handlerChannels = []
    await nativeRpc?.stop()
    await deps.lifecycle.stop()
  }

  function getClient(): ServerClient {
    if (!serverClient) throw new Error('Server client is not ready')
    return serverClient
  }

  async function fetchResource(path: string, headers?: Headers): Promise<Response> {
    if (!path.startsWith('/')) throw new Error('Server resource path must be absolute')
    const connection = await deps.lifecycle.getServerBaseUrl()
    return net.fetch(`${connection.baseUrl}${path}`, {
      headers: {
        ...Object.fromEntries(new Headers(headers).entries()),
        'X-Refora-Token': connection.token
      }
    })
  }

  return { start, stop, getClient, fetchResource }
}
