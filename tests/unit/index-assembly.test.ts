import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  ipcHandle: vi.fn(),
  ipcRemoveHandler: vi.fn(),
  nativeStart: vi.fn(),
  nativeStop: vi.fn(),
  wsConnect: vi.fn(),
  wsDisconnect: vi.fn(),
  bridgeStart: vi.fn(),
  bridgeStop: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle, removeHandler: mocks.ipcRemoveHandler }
}))

vi.mock('../../src/main/services/nativeRpc', () => ({
  createNativeRpc: vi.fn(() => ({
    start: mocks.nativeStart,
    stop: mocks.nativeStop
  }))
}))

vi.mock('../../src/main/services/serverClient', () => ({
  createServerClient: vi.fn(() => ({
    ws: {
      connect: mocks.wsConnect,
      disconnect: mocks.wsDisconnect
    }
  }))
}))

vi.mock('../../src/main/ipc/serverEventBridge', () => ({
  createServerEventBridge: vi.fn(() => ({
    start: mocks.bridgeStart,
    stop: mocks.bridgeStop
  }))
}))

vi.mock('../../src/main/ipc/serverLibraryHandlers', () => ({
  createServerLibraryHandlers: vi.fn(() => ({ library: vi.fn() }))
}))

vi.mock('../../src/main/ipc/serverWorkspaceHandlers', () => ({
  createServerWorkspaceHandlers: vi.fn(() => ({ workspace: vi.fn() }))
}))

vi.mock('../../src/main/ipc/serverAiHandlers', () => ({
  createServerAiHandlers: vi.fn(() => ({ ai: vi.fn() }))
}))

import { createServerAssembly } from '../../src/main/serverAssembly'
import { createNativeRpc } from '../../src/main/services/nativeRpc'
import { createServerClient } from '../../src/main/services/serverClient'
import { createServerEventBridge } from '../../src/main/ipc/serverEventBridge'
import { createServerLibraryHandlers } from '../../src/main/ipc/serverLibraryHandlers'
import { createServerWorkspaceHandlers } from '../../src/main/ipc/serverWorkspaceHandlers'
import { createServerAiHandlers } from '../../src/main/ipc/serverAiHandlers'

describe('main process server assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.calls.length = 0
    mocks.nativeStart.mockImplementation(async () => {
      mocks.calls.push('native.start')
    })
    mocks.nativeStop.mockImplementation(async () => {
      mocks.calls.push('native.stop')
    })
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
      repos: {} as never,
      getWin: () => null
    })

    await assembly.start()

    expect(mocks.calls).toEqual([
      'lifecycle.start',
      'native.start',
      'ws.connect',
      'bridge.start',
      'ipc.handle',
      'ipc.handle',
      'ipc.handle'
    ])
    expect(createNativeRpc).toHaveBeenCalledWith(expect.objectContaining({ token: 'token' }))
    expect(createServerClient).toHaveBeenCalledWith(lifecycle, expect.anything())
    expect(createServerEventBridge).toHaveBeenCalledTimes(1)
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
      repos: {} as never,
      getWin: () => null
    })
    await assembly.start()
    mocks.calls.length = 0

    await assembly.stop()

    expect(mocks.calls).toEqual([
      'bridge.stop',
      'ws.disconnect',
      'ipc.removeHandler',
      'ipc.removeHandler',
      'ipc.removeHandler',
      'native.stop',
      'lifecycle.stop'
    ])
  })
})
