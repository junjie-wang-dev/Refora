import { describe, expect, it } from 'vitest'
import { createServerAiHandlers } from '../../src/main/sidecar/ipc/ai'
import { createServerAppHandlers } from '../../src/main/sidecar/ipc/app'
import { createServerLibraryHandlers } from '../../src/main/sidecar/ipc/library'
import { createServerWorkspaceHandlers } from '../../src/main/sidecar/ipc/workspaces'
import { createSyncHandlers } from '../../src/main/sidecar/ipc/sync'
import { IpcChannel } from '../../src/shared/ipc-channels'
import type { ServerClient } from '../../src/main/sidecar/client'
import type { SyncAccountService } from '../../src/main/services/syncAccount'

describe('server IPC handler coverage', () => {
  it('registers every request channel exposed by preload', () => {
    const serverClient = { http: {} } as ServerClient
    const syncAccountService = {} as SyncAccountService
    const handlers = {
      ...createServerAppHandlers(serverClient, { setThemeSource: () => undefined }),
      ...createServerLibraryHandlers({ serverClient }),
      ...createServerWorkspaceHandlers(serverClient),
      ...createServerAiHandlers({ serverClient }),
      ...createSyncHandlers(syncAccountService)
    }
    const requestChannels = Object.entries(IpcChannel)
      .filter(([name]) => !name.startsWith('Event'))
      .map(([, channel]) => channel)
      .sort()

    expect(Object.keys(handlers).sort()).toEqual(requestChannels)
  })
})
