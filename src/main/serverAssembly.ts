import { ipcMain, type BrowserWindow } from 'electron'
import type { Repositories } from './db/repositories'
import { createServerAiHandlers } from './ipc/serverAiHandlers'
import { createServerEventBridge, type ServerEventBridge } from './ipc/serverEventBridge'
import { createServerLibraryHandlers } from './ipc/serverLibraryHandlers'
import { createServerWorkspaceHandlers } from './ipc/serverWorkspaceHandlers'
import { createNativeRpc, type NativeRpc } from './services/nativeRpc'
import { createServerClient, type ServerClient } from './services/serverClient'
import type { ServerLifecycle } from './services/serverLifecycle'

export interface ServerAssemblyDeps {
  lifecycle: ServerLifecycle
  repos: Repositories
  getWin: () => BrowserWindow | null
}

export interface ServerAssembly {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createServerAssembly(deps: ServerAssemblyDeps): ServerAssembly {
  let nativeRpc: NativeRpc | null = null
  let serverClient: ServerClient | null = null
  let eventBridge: ServerEventBridge | null = null

  async function start(): Promise<void> {
    const connection = await deps.lifecycle.start()
    nativeRpc = createNativeRpc({
      repos: deps.repos,
      token: connection.token,
      getWin: deps.getWin
    })
    await nativeRpc.start()
    serverClient = createServerClient(deps.lifecycle, nativeRpc)
    await serverClient.ws.connect()
    eventBridge = createServerEventBridge({ serverClient, getWin: deps.getWin })
    eventBridge.start()

    const handlers = {
      ...createServerLibraryHandlers({ serverClient }),
      ...createServerWorkspaceHandlers(serverClient),
      ...createServerAiHandlers({ serverClient })
    }
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.handle(channel, (_event, ...args) =>
        (handler as (...handlerArgs: unknown[]) => unknown)(...args)
      )
    }
  }

  async function stop(): Promise<void> {
    eventBridge?.stop()
    serverClient?.ws.disconnect()
    await nativeRpc?.stop()
    await deps.lifecycle.stop()
  }

  return { start, stop }
}
