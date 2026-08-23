import type { BrowserWindow, IpcMainInvokeEvent, WebPreferences } from 'electron'

export function contentSecurityPolicy(packaged: boolean): string {
  if (packaged) {
    return "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: refora-asset: refora-document:; media-src 'self' refora-asset:; connect-src 'self'"
  }
  return "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: refora-asset: refora-document:; media-src 'self' refora-asset:; connect-src 'self' ws://localhost:*"
}

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
}

export function isTrustedIpcSender(
  event: IpcMainInvokeEvent,
  getWin: () => BrowserWindow | null
): boolean {
  const window = getWin()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
}
