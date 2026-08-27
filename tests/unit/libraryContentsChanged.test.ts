import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IpcChannel } from '../../src/shared/ipc-channels'
import { sendLibraryContentsChanged } from '../../src/main/services/libraryContentsChanged'

function windowWithState(windowDestroyed = false, webContentsDestroyed = false) {
  const send = vi.fn()
  const target = {
    isDestroyed: () => windowDestroyed,
    webContents: {
      isDestroyed: () => webContentsDestroyed,
      send
    }
  } as unknown as BrowserWindow
  return { target, send }
}

describe('sendLibraryContentsChanged', () => {
  it('uses a non-switching event when sync updates the active database', () => {
    const { target, send } = windowWithState()

    expect(sendLibraryContentsChanged(target, '/library/working.db', '/library/working.db'))
      .toBe(true)
    expect(send).toHaveBeenCalledWith(IpcChannel.EventLibraryContentsChanged)
    expect(send).not.toHaveBeenCalledWith(IpcChannel.EventLibrarySwitched, expect.anything())
  })

  it('ignores stale updates and destroyed renderer targets', () => {
    const live = windowWithState()
    const destroyed = windowWithState(false, true)

    expect(sendLibraryContentsChanged(live.target, '/active.db', '/stale.db')).toBe(false)
    expect(sendLibraryContentsChanged(destroyed.target, '/active.db', '/active.db')).toBe(false)
    expect(live.send).not.toHaveBeenCalled()
    expect(destroyed.send).not.toHaveBeenCalled()
  })
})
