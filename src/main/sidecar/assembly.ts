import { ipcMain, nativeTheme, net, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
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
import { SERVER_IPC_CHANNELS } from '../../shared/ipc-channels'

export interface ServerAssemblyDeps {
  lifecycle: ServerLifecycle
  getWin: () => BrowserWindow | null
  nativeManagedRoots?: string[]
  switchLibraryFolder: (path: string) => Promise<LibrarySwitchResult>
  onSettingUpdated?: (key: string, value: unknown) => void
  rendererPathCapabilities: RendererPathCapabilities
  removeDocumentPreviewCache: (documentId: string) => Promise<void>
  openDirectory: () => Promise<string | null>
  saveBibtex: (bibtex: string) => Promise<void>
}

export interface ServerAssembly {
  start(): Promise<void>
  stop(): Promise<void>
  getClient(): ServerClient
  fetchResource(path: string, headers?: Headers): Promise<Response>
  addNativeManagedRoot(path: string): boolean
}

export function createServerAssembly(deps: ServerAssemblyDeps): ServerAssembly {
  let nativeRpc: NativeRpc | null = null
  let serverClient: ServerClient | null = null
  let eventBridge: ServerEventBridge | null = null
  const handlerChannels: readonly string[] = SERVER_IPC_CHANNELS

  function registerHandler(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ): void {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, handler)
  }

  function registerTrustedHandler(
    channel: string,
    handler: (...args: unknown[]) => unknown
  ): void {
    registerHandler(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event, deps.getWin)) {
        return {
          ok: false,
          error: { code: 'unauthorized_sender', message: 'IPC request did not originate from the main window' }
        }
      }
      return handler(...args)
    })
  }

  function registerUnavailableHandlers(channels: readonly string[]): void {
    for (const channel of channels) {
      registerTrustedHandler(channel, () => {
        return {
          ok: false,
          error: { code: 'service_unavailable', message: 'Local library is temporarily unavailable' }
        }
      })
    }
  }

  registerUnavailableHandlers(handlerChannels)

  async function start(): Promise<void> {
    try {
      await deps.lifecycle.start()
      nativeRpc = createNativeRpc({
        getWin: deps.getWin,
        managedRoots: deps.nativeManagedRoots
      })
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
          openDirectory: deps.openDirectory,
          authorizeFile: deps.rendererPathCapabilities.authorizeFile,
          authorizeDirectory: deps.rendererPathCapabilities.authorizeDirectory
        }),
        ...createServerLibraryHandlers({
          serverClient,
          switchLibraryFolder: deps.switchLibraryFolder,
          onSettingUpdated: deps.onSettingUpdated,
          consumeFile: deps.rendererPathCapabilities.consumeFile,
          consumeFiles: deps.rendererPathCapabilities.consumeFiles,
          consumeDirectory: deps.rendererPathCapabilities.consumeDirectory,
          removeDocumentPreviewCache: deps.removeDocumentPreviewCache,
          saveBibtex: deps.saveBibtex
        }),
        ...createServerWorkspaceHandlers(serverClient, {
          consumeFiles: deps.rendererPathCapabilities.consumeFiles
        }),
        ...createServerAiHandlers({ serverClient })
      }
      const registeredChannels = Object.keys(handlers)
      const expectedChannels = new Set(handlerChannels)
      if (
        registeredChannels.length !== expectedChannels.size ||
        registeredChannels.some((channel) => !expectedChannels.has(channel))
      ) {
        throw new Error('Server IPC channel registry does not match the handler maps')
      }
      for (const [channel, handler] of Object.entries(handlers)) {
        registerTrustedHandler(channel, handler as (...handlerArgs: unknown[]) => unknown)
      }
    } catch (error) {
      registerUnavailableHandlers(handlerChannels)
      eventBridge?.stop()
      serverClient?.ws.disconnect()
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
    registerUnavailableHandlers(handlerChannels)
    await deps.lifecycle.stop()
    deps.rendererPathCapabilities.clear()
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

  function addNativeManagedRoot(path: string): boolean {
    return nativeRpc?.addManagedRoot(path) ?? false
  }

  return { start, stop, getClient, fetchResource, addNativeManagedRoot }
}
