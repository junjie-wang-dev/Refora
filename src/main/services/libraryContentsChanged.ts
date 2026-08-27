import type { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc-channels'

export function sendLibraryContentsChanged(
  target: BrowserWindow | null,
  activeDbPath: string,
  changedDbPath: string
): boolean {
  if (
    !target
    || target.isDestroyed()
    || target.webContents.isDestroyed()
    || !activeDbPath
    || changedDbPath !== activeDbPath
  ) return false
  target.webContents.send(IpcChannel.EventLibraryContentsChanged)
  return true
}
