import { describe, expect, it } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  contentSecurityPolicy,
  isTrustedIpcSender,
  secureWebPreferences
} from '../../src/main/services/webSecurity'

describe('main-process web security', () => {
  it('uses strict production and localhost-only development CSPs', () => {
    const production = contentSecurityPolicy(true)
    const development = contentSecurityPolicy(false)

    expect(production).toContain("script-src 'self'")
    expect(production).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(production).not.toContain('ws://')
    expect(development).toContain("script-src 'self' 'unsafe-inline'")
    expect(development).toContain('ws://localhost:*')
  })

  it('always returns isolated and sandboxed web preferences', () => {
    expect(secureWebPreferences('/app/preload.js')).toEqual({
      preload: '/app/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('accepts only the active main window main frame', () => {
    const mainFrame = {}
    const webContents = {
      isDestroyed: () => false,
      mainFrame
    } as unknown as WebContents
    const window = {
      isDestroyed: () => false,
      webContents
    } as unknown as BrowserWindow

    expect(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame } as IpcMainInvokeEvent, () => window)).toBe(true)
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: {} } as IpcMainInvokeEvent, () => window)).toBe(false)
    expect(isTrustedIpcSender({ sender: {} } as IpcMainInvokeEvent, () => window)).toBe(false)
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame } as IpcMainInvokeEvent, () => null)).toBe(false)
  })
})
