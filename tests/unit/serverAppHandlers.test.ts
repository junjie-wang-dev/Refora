import { describe, expect, it, vi } from 'vitest'
import { createServerAppHandlers } from '../../src/main/sidecar/ipc/app'
import { IpcChannel } from '../../src/shared/ipc-channels'
import type { ServerClient } from '../../src/main/sidecar/client'

function clientWith(http: Record<string, ReturnType<typeof vi.fn>>): ServerClient {
  return { http, ws: {} } as unknown as ServerClient
}

describe('createServerAppHandlers', () => {
  it('forwards bootstrap and global search through the server client', async () => {
    const bootstrap = {
      language: 'en' as const,
      windowBounds: null,
      listColumnState: null,
      sidebarCollapsed: false,
      firstRun: true,
      libraryFolderPath: null
    }
    const search = {
      documents: [],
      workspaceFiles: [],
      workspaceContents: [],
      chats: []
    }
    const http = {
      appBootstrap: vi.fn().mockResolvedValue(bootstrap),
      globalSearch: vi.fn().mockResolvedValue(search),
      dialogOpenDirectory: vi.fn()
    }
    const handlers = createServerAppHandlers(clientWith(http))

    await expect(handlers[IpcChannel.Bootstrap]()).resolves.toEqual({
      ok: true,
      data: bootstrap
    })
    await expect(handlers[IpcChannel.GlobalSearch]('paper')).resolves.toEqual({
      ok: true,
      data: search
    })
    expect(http.globalSearch).toHaveBeenCalledWith('paper')
  })

  it('maps directory dialog cancellation and server errors into Result envelopes', async () => {
    const http = {
      appBootstrap: vi.fn(),
      globalSearch: vi.fn(),
      dialogOpenDirectory: vi
        .fn()
        .mockResolvedValueOnce({ canceled: true, path: null })
        .mockResolvedValueOnce({ canceled: false, path: '/tmp/library' })
        .mockRejectedValueOnce(Object.assign(new Error('Native unavailable'), {
          code: 'native_unavailable'
        }))
    }
    const handlers = createServerAppHandlers(clientWith(http))

    await expect(handlers[IpcChannel.DialogOpenDirectory]()).resolves.toEqual({
      ok: true,
      data: null
    })
    await expect(handlers[IpcChannel.DialogOpenDirectory]()).resolves.toEqual({
      ok: true,
      data: '/tmp/library'
    })
    await expect(handlers[IpcChannel.DialogOpenDirectory]()).resolves.toEqual({
      ok: false,
      error: { code: 'native_unavailable', message: 'Native unavailable' }
    })
  })
})
