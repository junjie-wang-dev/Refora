import { createNativeContextMenuHandlers } from '../../src/main/services/nativeContextMenu'
import { describe, expect, it } from 'vitest'
import { createServerAiHandlers } from '../../src/main/sidecar/ipc/ai'
import { createServerAppHandlers } from '../../src/main/sidecar/ipc/app'
import { createServerLibraryHandlers } from '../../src/main/sidecar/ipc/library'
import { createServerWorkspaceHandlers } from '../../src/main/sidecar/ipc/workspaces'
import { createSyncHandlers } from '../../src/main/sidecar/ipc/sync'
import { createMarkdownExportHandlers } from '../../src/main/services/markdownExport'
import { createAppLifecycleIpcHandlers } from '../../src/main/services/appLifecycleIpc'
import { createClipboardFileHandlers } from '../../src/main/services/clipboardFiles'
import { IpcChannel, SERVER_IPC_CHANNELS } from '../../src/shared/ipc-channels'
import type { ServerClient } from '../../src/main/sidecar/client'
import type { SyncAccountService } from '../../src/main/services/syncAccount'

describe('server IPC handler coverage', () => {
  it('registers every request channel exposed by preload', () => {
    const serverClient = { http: {} } as ServerClient
    const syncAccountService = {} as SyncAccountService
    const serverHandlers = {
      ...createServerAppHandlers(serverClient, {
        setThemeSource: () => undefined,
        openDirectory: async () => null,
        authorizeFile: (path) => path,
        authorizeDirectory: (path) => path
      }),
      ...createServerLibraryHandlers({
        serverClient,
        switchLibraryFolder: async (path) => ({
          libraryFolderPath: path,
          dbExisted: false,
          scanned: 0,
          imported: 0,
          skipped: 0,
          errors: []
        }),
        consumeFile: (path) => path,
        consumeFiles: (paths) => [...paths],
        consumeDirectory: (path) => path,
        removeDocumentPreviewCache: async () => undefined,
        saveBibtex: async () => undefined
      }),
      ...createServerWorkspaceHandlers(serverClient, { consumeFiles: (paths) => [...paths] }),
      ...createServerAiHandlers({ serverClient })
    }
    expect(Object.keys(serverHandlers).sort()).toEqual([...SERVER_IPC_CHANNELS].sort())
    const handlers = {
      ...serverHandlers,
      ...createNativeContextMenuHandlers(() => null),
      ...createClipboardFileHandlers((path) => path),
      ...createSyncHandlers(syncAccountService),
      ...createAppLifecycleIpcHandlers({ completeRendererFlush: () => true }),
      ...createMarkdownExportHandlers({
        showSaveDialog: async () => ({ canceled: true, filePath: '' }),
        printToPDF: async () => new Uint8Array(),
        writeFile: async () => undefined
      })
    }
    const requestChannels = Object.entries(IpcChannel)
      .filter(([name]) => !name.startsWith('Event'))
      .map(([, channel]) => channel)
      .sort()

    expect(Object.keys(handlers).sort()).toEqual(requestChannels)
  })
})
