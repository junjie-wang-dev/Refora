import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ServerAssembly } from '../../src/main/sidecar/assembly'

const electronMocks = vi.hoisted(() => ({
  quit: vi.fn(),
  ipcHandle: vi.fn(),
  registerSchemesAsPrivileged: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    requestSingleInstanceLock: vi.fn(() => false),
    quit: electronMocks.quit,
    getPath: vi.fn(() => '/tmp/refora-user-data'),
    getLocale: vi.fn(() => 'en'),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    setAsDefaultProtocolClient: vi.fn()
  },
  BrowserWindow: vi.fn(),
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn()
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn()
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
      setProxy: vi.fn()
    }
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
    showErrorBox: vi.fn()
  },
  ipcMain: {
    handle: electronMocks.ipcHandle,
    removeHandler: vi.fn()
  },
  nativeImage: { createFromPath: vi.fn() },
  nativeTheme: { themeSource: 'system' },
  net: { fetch: vi.fn() },
  protocol: {
    registerSchemesAsPrivileged: electronMocks.registerSchemesAsPrivileged,
    handle: vi.fn()
  },
  utilityProcess: { fork: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  },
  clipboard: {
    writeText: vi.fn(),
    writeBuffer: vi.fn()
  }
}))

import { persistWindowBounds } from '../../src/main/index'

describe('main window state persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the current window bounds through the active assembly', async () => {
    const settingsUpdate = vi.fn().mockResolvedValue({})
    const assembly = {
      getClient: () => ({ http: { settingsUpdate } })
    } as unknown as ServerAssembly
    const target = {
      isDestroyed: () => false,
      isMaximized: () => false,
      getBounds: () => ({ x: 10, y: 20, width: 1200, height: 800 }),
      getNormalBounds: vi.fn()
    } as unknown as BrowserWindow

    await persistWindowBounds(assembly, target)

    expect(settingsUpdate).toHaveBeenCalledWith({
      windowBounds: { x: 10, y: 20, width: 1200, height: 800, isMaximized: false }
    })
  })

  it('rejects a settings write failure so the shutdown guard can react', async () => {
    const settingsUpdate = vi.fn().mockRejectedValue(new Error('disk full'))
    const assembly = {
      getClient: () => ({ http: { settingsUpdate } })
    } as unknown as ServerAssembly
    const target = {
      isDestroyed: () => false,
      isMaximized: () => true,
      getBounds: vi.fn(),
      getNormalBounds: () => ({ x: 30, y: 40, width: 1400, height: 900 })
    } as unknown as BrowserWindow

    await expect(persistWindowBounds(assembly, target)).rejects.toThrow('disk full')
  })
})
