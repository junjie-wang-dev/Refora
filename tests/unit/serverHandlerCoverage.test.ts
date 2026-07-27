import { describe, expect, it } from 'vitest'
import { createServerAiHandlers } from '../../src/main/sidecar/ipc/ai'
import { createServerAppHandlers } from '../../src/main/sidecar/ipc/app'
import { createServerLibraryHandlers } from '../../src/main/sidecar/ipc/library'
import { createServerWorkspaceHandlers } from '../../src/main/sidecar/ipc/workspaces'
import { IpcChannel } from '../../src/shared/ipc-channels'
import type { ServerClient } from '../../src/main/sidecar/client'

describe('server IPC handler coverage', () => {
  it('registers every request channel exposed by preload', () => {
    const serverClient = { http: {} } as ServerClient
    const handlers = {
      ...createServerAppHandlers(serverClient),
      ...createServerLibraryHandlers({ serverClient }),
      ...createServerWorkspaceHandlers(serverClient),
      ...createServerAiHandlers({ serverClient })
    }
    const requestChannels = Object.entries(IpcChannel)
      .filter(([name]) => !name.startsWith('Event'))
      .map(([, channel]) => channel)
      .sort()

    expect(Object.keys(handlers).sort()).toEqual(requestChannels)
  })
})
