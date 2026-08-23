import { ipcMain, nativeTheme, net, type BrowserWindow } from 'electron'
import type { LibrarySwitchResult } from '../../shared/ipc-types'
import { createServerAppHandlers } from './ipc/app'
import { createServerAiHandlers } from './ipc/ai'
import { createServerEventBridge, type ServerEventBridge } from './ipc/eventBridge'
import { createServerLibraryHandlers } from './ipc/library'
import { createServerWorkspaceHandlers } from './ipc/workspaces'
import { createNativeRpc, type NativeRpc } from './nativeRpc'
import { createServerClient, type ServerClient } from './client'
import type { ServerLifecycle } from './lifecycle'
import type { RendererPathCapabilities } from '../services/fileCapabilities'
import { isTrustedIpcSender } from '../services/webSecurity'
import {
  SERVER_PROTOCOL_DIGEST,
  SERVER_PROTOCOL_VERSION
} from '../../shared/server-contract'

export interface ServerAssemblyDeps {
  lifecycle: ServerLifecycle
  getWin: () => BrowserWindow | null
  nativeManagedRoots?: string[]
  switchLibraryFolder?: (path: string) => Promise<LibrarySwitchResult>
  onSettingUpdated?: (key: string, value: unknown) => void
  rendererPathCapabilities?: RendererPathCapabilities
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
    try {
      nativeRpc = createNativeRpc({
        token: connection.token,
        getWin: deps.getWin,
        managedRoots: deps.nativeManagedRoots
      })
      await nativeRpc.start()
      serverClient = createServerClient(deps.lifecycle, nativeRpc)
      const ready = await serverClient.http.systemReady()
      if (
        ready.protocolVersion !== SERVER_PROTOCOL_VERSION ||
        ready.protocolDigest !== SERVER_PROTOCOL_DIGEST
      ) {
        throw new Error(
          `Python server protocol mismatch: expected ${SERVER_PROTOCOL_VERSION}/${SERVER_PROTOCOL_DIGEST}, received ${ready.protocolVersion}/${ready.protocolDigest}`
        )
      }
      await serverClient.ws.connect()
      eventBridge = createServerEventBridge({
        serverClient,
        getWin: deps.getWin
      })
      eventBridge.start()

      const handlers = {
        ...createServerAppHandlers(serverClient, {
          setThemeSource: (theme) => {
            nativeTheme.themeSource = theme
          },
          authorizeFile: deps.rendererPathCapabilities?.authorizeFile,
          authorizeDirectory: deps.rendererPathCapabilities?.authorizeDirectory
        }),
        ...createServerLibraryHandlers({
          serverClient,
          switchLibraryFolder: deps.switchLibraryFolder,
          onSettingUpdated: deps.onSettingUpdated,
          consumeFile: deps.rendererPathCapabilities?.consumeFile,
          consumeFiles: deps.rendererPathCapabilities?.consumeFiles,
          consumeDirectory: deps.rendererPathCapabilities?.consumeDirectory
        }),
        ...createServerWorkspaceHandlers(serverClient, {
          consumeFile: deps.rendererPathCapabilities?.consumeFile,
          consumeFiles: deps.rendererPathCapabilities?.consumeFiles
        }),
        ...createServerAiHandlers({ serverClient })
      }
      handlerChannels = Object.keys(handlers)
      for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, (event, ...args) => {
          if (!isTrustedIpcSender(event, deps.getWin)) {
            return {
              ok: false,
              error: { code: 'unauthorized_sender', message: 'IPC request did not originate from the main window' }
            }
          }
          return (handler as (...handlerArgs: unknown[]) => unknown)(...args)
        })
      }
    } catch (error) {
      eventBridge?.stop()
      serverClient?.ws.disconnect()
      await nativeRpc?.stop()
      await deps.lifecycle.stop()
      eventBridge = null
      serverClient = null
      nativeRpc = null
      throw error
    }
  }

  async function stop(): Promise<void> {
    eventBridge?.stop()
    serverClient?.ws.disconnect()
    for (const channel of handlerChannels) ipcMain.removeHandler(channel)
    handlerChannels = []
    await nativeRpc?.stop()
    await deps.lifecycle.stop()
    deps.rendererPathCapabilities?.clear()
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
