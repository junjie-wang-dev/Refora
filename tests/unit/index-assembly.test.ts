import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  ipcHandle: vi.fn(),
  ipcRemoveHandler: vi.fn(),
  nativeInvoke: vi.fn(),
  nativeAddManagedRoot: vi.fn(),
  wsConnect: vi.fn(),
  wsDisconnect: vi.fn(),
  bridgeStart: vi.fn(),
  bridgeStop: vi.fn(),
  ready: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle, removeHandler: mocks.ipcRemoveHandler },
  nativeTheme: { themeSource: 'system' }
}))

vi.mock('../../src/shared/ipc-channels', () => ({
  SERVER_IPC_CHANNELS: ['app', 'library', 'workspace', 'ai']
}))

vi.mock('../../src/main/sidecar/nativeRpc', () => ({
  createNativeRpc: vi.fn(() => ({
    invoke: mocks.nativeInvoke,
    addManagedRoot: mocks.nativeAddManagedRoot
  }))
}))

vi.mock('../../src/main/sidecar/client', () => ({
  createServerClient: vi.fn(() => ({
    http: {
      systemReady: mocks.ready
    },
    ws: {
      connect: mocks.wsConnect,
      disconnect: mocks.wsDisconnect
    }
  }))
}))

vi.mock('../../src/main/sidecar/ipc/eventBridge', () => ({
  createServerEventBridge: vi.fn(() => ({
    start: mocks.bridgeStart,
    stop: mocks.bridgeStop
  }))
}))

vi.mock('../../src/main/sidecar/ipc/app', () => ({
  createServerAppHandlers: vi.fn(() => ({ app: vi.fn() }))
}))

vi.mock('../../src/main/sidecar/ipc/library', () => ({
  createServerLibraryHandlers: vi.fn(() => ({ library: vi.fn() }))
}))

vi.mock('../../src/main/sidecar/ipc/workspaces', () => ({
  createServerWorkspaceHandlers: vi.fn(() => ({ workspace: vi.fn() }))
}))

vi.mock('../../src/main/sidecar/ipc/ai', () => ({
  createServerAiHandlers: vi.fn(() => ({ ai: vi.fn() }))
}))

import { createServerAssembly } from '../../src/main/sidecar/assembly'
import { nativeTheme, type BrowserWindow } from 'electron'
import { createNativeRpc } from '../../src/main/sidecar/nativeRpc'
import { createServerClient } from '../../src/main/sidecar/client'
import { createServerEventBridge } from '../../src/main/sidecar/ipc/eventBridge'
import { createServerAppHandlers } from '../../src/main/sidecar/ipc/app'
import { createServerLibraryHandlers } from '../../src/main/sidecar/ipc/library'
import { createServerWorkspaceHandlers } from '../../src/main/sidecar/ipc/workspaces'
import { createServerAiHandlers } from '../../src/main/sidecar/ipc/ai'
import {
  SERVER_PROTOCOL_DIGEST,
  SERVER_PROTOCOL_VERSION
} from '../../src/shared/server-contract'

describe('main process server assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.calls.length = 0
    mocks.nativeAddManagedRoot.mockReturnValue(true)
    mocks.wsConnect.mockImplementation(async () => {
      mocks.calls.push('ws.connect')
    })
    mocks.wsDisconnect.mockImplementation(() => {
      mocks.calls.push('ws.disconnect')
    })
    mocks.bridgeStart.mockImplementation(() => {
      mocks.calls.push('bridge.start')
    })
    mocks.bridgeStop.mockImplementation(() => {
      mocks.calls.push('bridge.stop')
    })
    mocks.ipcHandle.mockImplementation(() => {
      mocks.calls.push('ipc.handle')
    })
    mocks.ipcRemoveHandler.mockImplementation(() => {
      mocks.calls.push('ipc.removeHandler')
    })
    mocks.ready.mockImplementation(async () => {
      mocks.calls.push('http.ready')
      return {
        status: 'ready',
        protocolVersion: SERVER_PROTOCOL_VERSION,
        protocolDigest: SERVER_PROTOCOL_DIGEST
      }
    })
  })

  it('starts services and registers all server handler maps in order', async () => {
    const lifecycle = {
      start: vi.fn(async () => {
        mocks.calls.push('lifecycle.start')
        return { baseUrl: 'http://127.0.0.1:8123', token: 'token', port: 8123 }
      }),
      getServerBaseUrl: vi.fn(),
      stop: vi.fn(async () => {
        mocks.calls.push('lifecycle.stop')
      })
    }
    const assembly = createServerAssembly({
      lifecycle,
      getWin: () => null
    })

    await assembly.start()

    expect(mocks.calls).toEqual([
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle',
      'lifecycle.start',
      'http.ready',
      'ws.connect',
      'bridge.start',
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle'
    ])
    expect(createNativeRpc).toHaveBeenCalledWith(expect.objectContaining({ getWin: expect.any(Function) }))
    expect(createServerClient).toHaveBeenCalledWith(lifecycle, expect.anything())
    expect(createServerEventBridge).toHaveBeenCalledTimes(1)
    expect(createServerAppHandlers).toHaveBeenCalledTimes(1)
    const appHandlerDeps = vi.mocked(createServerAppHandlers).mock.calls[0]?.[1]
    appHandlerDeps?.setThemeSource('dark')
    expect(nativeTheme.themeSource).toBe('dark')
    expect(createServerLibraryHandlers).toHaveBeenCalledTimes(1)
    expect(createServerWorkspaceHandlers).toHaveBeenCalledTimes(1)
    expect(createServerAiHandlers).toHaveBeenCalledTimes(1)
  })

  it('stops the event bridge, websocket, RPC server, then lifecycle', async () => {
    const lifecycle = {
      start: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8123', token: 'token', port: 8123 })),
      getServerBaseUrl: vi.fn(),
      stop: vi.fn(async () => {
        mocks.calls.push('lifecycle.stop')
      })
    }
    const assembly = createServerAssembly({
      lifecycle,
      getWin: () => null
    })
    await assembly.start()
    mocks.calls.length = 0

    await assembly.stop()

    expect(mocks.calls).toEqual([
      'bridge.stop',
      'ws.disconnect',
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle',
      'ipc.removeHandler',
      'ipc.handle',
      'lifecycle.stop'
    ])
  })

  it('keeps typed unavailable handlers installed while the assembly is stopped', async () => {
    const mainFrame = {}
    const webContents = {
      isDestroyed: () => false,
      mainFrame
    }
    const window = {
      isDestroyed: () => false,
      webContents
    } as unknown as BrowserWindow
    const lifecycle = {
      start: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8123', token: 'token', port: 8123 })),
      getServerBaseUrl: vi.fn(),
      stop: vi.fn()
    }
    const assembly = createServerAssembly({ lifecycle, getWin: () => window })
    await assembly.start()

    await assembly.stop()

    const fallback = mocks.ipcHandle.mock.calls.at(-1)?.[1] as (
      event: unknown
    ) => unknown
    expect(fallback({ sender: webContents, senderFrame: mainFrame })).toEqual({
      ok: false,
      error: {
        code: 'service_unavailable',
        message: 'Local library is temporarily unavailable'
      }
    })
    expect(fallback({ sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized_sender' }
    })
  })

  it('adds a library discovered after native RPC startup to the managed roots', async () => {
    const lifecycle = {
      start: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8123', token: 'token', port: 8123 })),
      getServerBaseUrl: vi.fn(),
      stop: vi.fn()
    }
    const assembly = createServerAssembly({ lifecycle, getWin: () => null })
    await assembly.start()

    expect(assembly.addNativeManagedRoot('/library/discovered')).toBe(true)
    expect(mocks.nativeAddManagedRoot).toHaveBeenCalledWith('/library/discovered')
  })

  it('rejects IPC from any sender other than the active main frame', async () => {
    const mainFrame = {}
    const webContents = {
      isDestroyed: () => false,
      mainFrame
    }
    const window = {
      isDestroyed: () => false,
      webContents
    } as unknown as BrowserWindow
    const lifecycle = {
      start: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8123', token: 'token', port: 8123 })),
      getServerBaseUrl: vi.fn(),
      stop: vi.fn()
    }
    const assembly = createServerAssembly({ lifecycle, getWin: () => window })
    await assembly.start()
    const invokeHandler = mocks.ipcHandle.mock.calls
      .filter(([channel]) => channel === 'app')
      .at(-1)?.[1] as (
      event: unknown,
      ...args: unknown[]
    ) => unknown

    expect(await invokeHandler({ sender: {}, senderFrame: {} })).toEqual({
      ok: false,
      error: {
        code: 'unauthorized_sender',
        message: 'IPC request did not originate from the main window'
      }
    })

    await invokeHandler({ sender: webContents, senderFrame: mainFrame })
    const appHandler = vi.mocked(createServerAppHandlers).mock.results[0].value.app
    expect(appHandler).toHaveBeenCalledOnce()
  })

  it('rejects a mismatched Python protocol and releases startup resources', async () => {
    mocks.ready.mockResolvedValueOnce({
      status: 'ready',
      protocolVersion: SERVER_PROTOCOL_VERSION + 1,
      protocolDigest: 'mismatch'
    })
    const lifecycle = {
      start: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:8123', token: 'token', port: 8123 })),
      getServerBaseUrl: vi.fn(),
      stop: vi.fn(async () => {
        mocks.calls.push('lifecycle.stop')
      })
    }
    const assembly = createServerAssembly({
      lifecycle,
      getWin: () => null
    })

    await expect(assembly.start()).rejects.toThrow('Python server protocol mismatch')
    expect(lifecycle.stop).toHaveBeenCalledOnce()
    expect(mocks.wsConnect).not.toHaveBeenCalled()
  })

  it('keeps typed sidecar fallbacks when lifecycle cold start fails', async () => {
    const mainFrame = {}
    const webContents = {
      isDestroyed: () => false,
      mainFrame
    }
    const window = {
      isDestroyed: () => false,
      webContents
    } as unknown as BrowserWindow
    const lifecycle = {
      start: vi.fn(async () => {
        throw new Error('spawn failed')
      }),
      getServerBaseUrl: vi.fn(),
      stop: vi.fn()
    }
    const assembly = createServerAssembly({ lifecycle, getWin: () => window })

    await expect(assembly.start()).rejects.toThrow('spawn failed')

    const fallback = mocks.ipcHandle.mock.calls
      .filter(([channel]) => channel === 'app')
      .at(-1)?.[1] as (event: unknown) => unknown
    expect(fallback({ sender: webContents, senderFrame: mainFrame })).toEqual({
      ok: false,
      error: {
        code: 'service_unavailable',
        message: 'Local library is temporarily unavailable'
      }
    })
    expect(lifecycle.stop).toHaveBeenCalledOnce()
  })
})
