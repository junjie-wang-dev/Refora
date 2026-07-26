import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../../src/shared/ipc-channels'
import { createServerWorkspaceHandlers } from '../../src/main/ipc/serverWorkspaceHandlers'
import type { ServerClient } from '../../src/main/services/serverClient'

const workspace = { id: 'workspace-1', name: 'Workspace', createdAt: 1, updatedAt: 2 }
const item = {
  id: 'item-1',
  workspaceId: workspace.id,
  kind: 'document' as const,
  docId: 'document-1',
  reportId: null,
  noteId: null,
  assetId: null,
  sortOrder: 0,
  width: 300,
  height: 200,
  x: 1,
  y: 2,
  zIndex: 3,
  addedAt: 4
}
const asset = {
  id: 'asset-1',
  workspaceId: workspace.id,
  fileName: 'file.txt',
  filePath: '/tmp/file.txt',
  sourcePath: '/tmp/file.txt',
  mimeType: 'text/plain',
  previewKind: 'text' as const,
  fileSize: 1,
  fileHash: 'hash',
  fileMissing: 0,
  createdAt: 1,
  updatedAt: 2
}
const connection = {
  id: 'connection-1',
  workspaceId: workspace.id,
  sourceItemId: item.id,
  targetItemId: 'item-2',
  sourceAnchor: 'top' as const,
  targetAnchor: 'bottom' as const,
  createdAt: 1
}
const note = {
  id: 'note-1',
  workspaceId: workspace.id,
  noteType: 'markdown' as const,
  title: 'Note',
  contentMd: 'content',
  createdAt: 1,
  updatedAt: 2
}
const status = {
  state: 'installed' as const,
  installRoot: '/tmp/mineru',
  installPath: '/tmp/mineru/current',
  version: '3.4.4',
  architecture: 'arm64',
  pythonPath: '/tmp/python',
  modelConfigPath: '/tmp/models',
  installedAt: 1,
  diskBytes: 1,
  error: null,
  progress: null
}
const job = {
  id: 'job-1',
  documentId: 'document-1',
  resultKey: 'result-1',
  sourceHash: 'hash',
  profile: 'balanced' as const,
  status: 'running' as const,
  stage: 'parsing' as const,
  progress: 0.5,
  errorCode: null,
  errorMessage: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  updatedAt: 2
}

function makeClient(): { client: ServerClient; http: Record<string, ReturnType<typeof vi.fn>> } {
  const http = {
    workspacesList: vi.fn().mockResolvedValue([workspace]),
    workspacesCreate: vi.fn().mockResolvedValue(workspace),
    workspacesUpdate: vi.fn().mockResolvedValue(workspace),
    workspacesDelete: vi.fn().mockResolvedValue({ ack: true }),
    workspacesOpenSandbox: vi.fn().mockResolvedValue({ ack: true }),
    workspaceItemsList: vi.fn().mockResolvedValue([item]),
    workspaceItemGet: vi.fn().mockResolvedValue(item),
    workspaceItemsCreate: vi.fn().mockResolvedValue(item),
    workspaceItemsDelete: vi.fn().mockResolvedValue({ ack: true }),
    workspaceItemsReorder: vi.fn().mockResolvedValue({ ack: true }),
    workspaceItemResize: vi.fn().mockResolvedValue(item),
    workspaceItemMove: vi.fn().mockResolvedValue(item),
    workspaceAssetsList: vi.fn().mockResolvedValue([asset]),
    workspaceAssetGet: vi.fn().mockResolvedValue(asset),
    workspaceAssetsAddFiles: vi.fn().mockResolvedValue({ imported: [asset], errors: [] }),
    workspaceAssetPreview: vi.fn().mockResolvedValue({ content: 'preview', truncated: false }),
    workspaceAssetOpen: vi.fn().mockResolvedValue({ ack: true }),
    workspaceAssetReveal: vi.fn().mockResolvedValue({ ack: true }),
    workspaceAssetDelete: vi.fn().mockResolvedValue({ ack: true }),
    workspaceCanvasGet: vi.fn().mockResolvedValue({ panX: 1, panY: 2, zoom: 1 }),
    workspaceCanvasUpdate: vi.fn().mockResolvedValue({ panX: 3, panY: 4, zoom: 2 }),
    workspaceConnectionsList: vi.fn().mockResolvedValue([connection]),
    workspaceConnectionGet: vi.fn().mockResolvedValue(connection),
    workspaceConnectionsCreate: vi.fn().mockResolvedValue(connection),
    workspaceConnectionsDelete: vi.fn().mockResolvedValue({ ack: true }),
    workspaceNotesList: vi.fn().mockResolvedValue([note]),
    workspaceNoteGet: vi.fn().mockResolvedValue(note),
    workspaceNotesCreate: vi.fn().mockResolvedValue(note),
    workspaceNotesUpdate: vi.fn().mockResolvedValue(note),
    workspaceNotesDelete: vi.fn().mockResolvedValue({ ack: true }),
    mineruStatus: vi.fn().mockResolvedValue(status),
    mineruChooseInstallRoot: vi.fn().mockResolvedValue(status),
    mineruInstall: vi.fn().mockResolvedValue({ ack: true }),
    mineruCancelInstall: vi.fn().mockResolvedValue({ ack: true }),
    mineruUninstall: vi.fn().mockResolvedValue({ ack: true }),
    ocrState: vi.fn().mockResolvedValue({ engine: status, activeJob: job, result: null }),
    ocrStart: vi.fn().mockResolvedValue({ jobId: job.id }),
    ocrCancel: vi.fn().mockResolvedValue(job),
    ocrMarkdown: vi.fn().mockResolvedValue({ markdown: '# OCR' })
  }
  return { client: { http } as unknown as ServerClient, http }
}

describe('server workspace IPC handlers', () => {
  let http: Record<string, ReturnType<typeof vi.fn>>
  let handlers: ReturnType<typeof createServerWorkspaceHandlers>

  beforeEach(() => {
    const serverClient = makeClient()
    http = serverClient.http
    handlers = createServerWorkspaceHandlers(serverClient.client)
  })

  it('forwards workspace operations through HTTP', async () => {
    await handlers[IpcChannel.WorkspacesList]()
    await handlers[IpcChannel.WorkspacesCreate]('New workspace')
    await handlers[IpcChannel.WorkspacesRename](workspace.id, 'Renamed')
    await handlers[IpcChannel.WorkspacesDelete](workspace.id)
    await handlers[IpcChannel.WorkspacesOpenSandbox](workspace.id)

    expect(http.workspacesList).toHaveBeenCalledOnce()
    expect(http.workspacesCreate).toHaveBeenCalledWith({ name: 'New workspace' })
    expect(http.workspacesUpdate).toHaveBeenCalledWith(workspace.id, { name: 'Renamed' })
    expect(http.workspacesDelete).toHaveBeenCalledWith(workspace.id)
    expect(http.workspacesOpenSandbox).toHaveBeenCalledWith(workspace.id)
  })

  it('converts item arguments and preserves legacy return values', async () => {
    await handlers[IpcChannel.WorkspaceItemsList](workspace.id)
    const added = await handlers[IpcChannel.WorkspaceItemsAdd](workspace.id, 'document', ['document-1', 'document-2'], { x: 5, y: 6 })
    await handlers[IpcChannel.WorkspaceItemsRemove](item.id)
    const reordered = await handlers[IpcChannel.WorkspaceItemsReorder](workspace.id, ['item-2', item.id])
    await handlers[IpcChannel.WorkspaceItemsResize](item.id, 400, 500)
    await handlers[IpcChannel.WorkspaceItemsMove](item.id, 7, 8, 9)

    expect(added).toEqual({ ok: true, data: [item, item] })
    expect(reordered).toEqual({ ok: true, data: [item] })
    expect(http.workspaceItemsCreate).toHaveBeenNthCalledWith(1, workspace.id, {
      kind: 'document',
      docId: 'document-1',
      placement: { x: 5, y: 6 }
    })
    expect(http.workspaceItemsCreate).toHaveBeenNthCalledWith(2, workspace.id, {
      kind: 'document',
      docId: 'document-2',
      placement: { x: 5, y: 6 }
    })
    expect(http.workspaceItemsDelete).toHaveBeenCalledWith(workspace.id, item.id)
    expect(http.workspaceItemsReorder).toHaveBeenCalledWith(workspace.id, { ids: ['item-2', item.id] })
    expect(http.workspaceItemResize).toHaveBeenCalledWith(workspace.id, item.id, { width: 400, height: 500 })
    expect(http.workspaceItemMove).toHaveBeenCalledWith(workspace.id, {
      itemId: item.id,
      x: 7,
      y: 8,
      zIndex: 9
    })
    expect(http.workspacesList).not.toHaveBeenCalled()
    expect(http.workspaceItemGet).toHaveBeenCalledTimes(3)
  })

  it('forwards asset operations through HTTP without native shell access', async () => {
    await handlers[IpcChannel.WorkspaceAssetsList](workspace.id)
    const imported = await handlers[IpcChannel.WorkspaceAssetsAddFiles](workspace.id, ['/tmp/file.txt'], { x: 2, y: 3 })
    await handlers[IpcChannel.WorkspaceAssetsTextPreview](asset.id)
    await handlers[IpcChannel.WorkspaceAssetsOpen](asset.id)
    await handlers[IpcChannel.WorkspaceAssetsReveal](asset.id)
    await handlers[IpcChannel.WorkspaceAssetsDelete](asset.id)

    expect(imported).toEqual({ ok: true, data: { imported: [asset], errors: [] } })
    expect(http.workspaceAssetsAddFiles).toHaveBeenCalledWith(workspace.id, {
      paths: ['/tmp/file.txt'],
      placement: { x: 2, y: 3 }
    })
    expect(http.workspaceAssetPreview).toHaveBeenCalledWith(workspace.id, asset.id)
    expect(http.workspaceAssetOpen).toHaveBeenCalledWith(workspace.id, asset.id)
    expect(http.workspaceAssetReveal).toHaveBeenCalledWith(workspace.id, asset.id)
    expect(http.workspaceAssetDelete).toHaveBeenCalledWith(workspace.id, asset.id)
    expect(http.workspaceAssetGet).toHaveBeenCalledTimes(4)
  })

  it('forwards canvas, connection, and note operations with converted arguments', async () => {
    await handlers[IpcChannel.WorkspaceCanvasGet](workspace.id)
    await handlers[IpcChannel.WorkspaceCanvasUpdate](workspace.id, { panX: 3, panY: 4, zoom: 2 })
    await handlers[IpcChannel.WorkspaceConnectionsList](workspace.id)
    await handlers[IpcChannel.WorkspaceConnectionsCreate](workspace.id, item.id, 'item-2', 'top', 'bottom')
    await handlers[IpcChannel.WorkspaceConnectionsDelete](connection.id)
    await handlers[IpcChannel.WorkspaceNotesList](workspace.id)
    await handlers[IpcChannel.WorkspaceNotesCreate](workspace.id, 'New', 'Body', 'plain', { x: 3, y: 4 })
    await handlers[IpcChannel.WorkspaceNotesUpdate](note.id, { title: 'Updated' })
    await handlers[IpcChannel.WorkspaceNotesDelete](note.id)

    expect(http.workspaceCanvasUpdate).toHaveBeenCalledWith(workspace.id, { panX: 3, panY: 4, zoom: 2 })
    expect(http.workspaceConnectionsCreate).toHaveBeenCalledWith(workspace.id, {
      sourceItemId: item.id,
      targetItemId: 'item-2',
      sourceAnchor: 'top',
      targetAnchor: 'bottom'
    })
    expect(http.workspaceConnectionsDelete).toHaveBeenCalledWith(workspace.id, connection.id)
    expect(http.workspaceNotesCreate).toHaveBeenCalledWith(workspace.id, {
      title: 'New',
      contentMd: 'Body',
      noteType: 'plain',
      placement: { x: 3, y: 4 }
    })
    expect(http.workspaceNotesUpdate).toHaveBeenCalledWith(workspace.id, note.id, {
      title: 'Updated',
      contentMd: note.contentMd,
      noteType: note.noteType
    })
    expect(http.workspaceNotesDelete).toHaveBeenCalledWith(workspace.id, note.id)
    expect(http.workspaceConnectionGet).toHaveBeenCalledOnce()
    expect(http.workspaceNoteGet).toHaveBeenCalledTimes(2)
  })

  it('forwards MinerU and OCR operations through HTTP with legacy result shapes', async () => {
    await handlers[IpcChannel.MineruStatus]()
    await handlers[IpcChannel.MineruChooseInstallRoot]()
    await handlers[IpcChannel.MineruInstall]()
    await handlers[IpcChannel.MineruCancelInstall]()
    await handlers[IpcChannel.MineruUninstall]()
    await handlers[IpcChannel.OcrGetState](job.documentId)
    const started = await handlers[IpcChannel.OcrStart](job.documentId, job.profile)
    const cancelled = await handlers[IpcChannel.OcrCancel](job.id)
    const markdown = await handlers[IpcChannel.OcrReadMarkdown](job.documentId, job.resultKey)

    expect(started).toEqual({ ok: true, data: job })
    expect(cancelled).toEqual({ ok: true, data: job })
    expect(markdown).toEqual({ ok: true, data: '# OCR' })
    expect(http.mineruChooseInstallRoot).toHaveBeenCalledOnce()
    expect(http.mineruInstall).toHaveBeenCalledOnce()
    expect(http.mineruCancelInstall).toHaveBeenCalledOnce()
    expect(http.mineruUninstall).toHaveBeenCalledOnce()
    expect(http.ocrStart).toHaveBeenCalledWith({ documentId: job.documentId, profile: job.profile })
    expect(http.ocrCancel).toHaveBeenCalledWith({ jobId: job.id })
    expect(http.ocrState).toHaveBeenCalledWith(job.documentId)
    expect(http.ocrMarkdown).toHaveBeenCalledWith(job.documentId, job.resultKey)
  })

  it('passes server errors through the shared Result envelope', async () => {
    http.workspacesList.mockRejectedValueOnce(Object.assign(new Error('Server unavailable'), { code: 'server_unavailable' }))

    await expect(handlers[IpcChannel.WorkspacesList]()).resolves.toEqual({
      ok: false,
      error: { code: 'server_unavailable', message: 'Server unavailable' }
    })
  })
})
