import { IpcChannel } from '../../shared/ipc-channels'
import type {
  Result,
  WorkspaceCanvasViewport,
  WorkspaceConnection,
  WorkspaceItemKind,
  WorkspaceItemPlacement,
  WorkspaceNote,
  WorkspaceNotePatch,
  WorkspaceNoteType
} from '../../shared/ipc-types'
import type { OcrJob, OcrProfile } from '../../shared/mineru-types'
import type { ServerClient } from '../services/serverClient'

function errorResult(error: unknown): Result<never> {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const { code, message } = error as { code: unknown; message: unknown }
    if (typeof code === 'string' && typeof message === 'string') {
      return { ok: false, error: { code, message } }
    }
  }
  return {
    ok: false,
    error: { code: 'internal_error', message: error instanceof Error ? error.message : String(error) }
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (error) {
    return errorResult(error)
  }
}

function itemInput(kind: WorkspaceItemKind, id: string, placement?: WorkspaceItemPlacement) {
  const input = { kind, placement }
  if (kind === 'document') return { ...input, docId: id }
  if (kind === 'report') return { ...input, reportId: id }
  if (kind === 'note') return { ...input, noteId: id }
  return { ...input, assetId: id }
}

export function createServerWorkspaceHandlers(serverClient: ServerClient) {
  const { http } = serverClient

  async function workspaceForItem(itemId: string): Promise<string> {
    for (const workspace of await http.workspacesList()) {
      if ((await http.workspaceItemsList(workspace.id)).some((item) => item.id === itemId)) {
        return workspace.id
      }
    }
    throw Object.assign(new Error(`Workspace item not found: ${itemId}`), { code: 'not_found' })
  }

  async function workspaceForAsset(assetId: string): Promise<string> {
    for (const workspace of await http.workspacesList()) {
      if ((await http.workspaceAssetsList(workspace.id)).some((asset) => asset.id === assetId)) {
        return workspace.id
      }
    }
    throw Object.assign(new Error(`Workspace asset not found: ${assetId}`), { code: 'not_found' })
  }

  async function workspaceForConnection(connectionId: string): Promise<string> {
    for (const workspace of await http.workspacesList()) {
      if ((await http.workspaceConnectionsList(workspace.id)).some((connection) => connection.id === connectionId)) {
        return workspace.id
      }
    }
    throw Object.assign(new Error(`Workspace connection not found: ${connectionId}`), { code: 'not_found' })
  }

  async function noteForId(noteId: string): Promise<{ workspaceId: string; note: WorkspaceNote }> {
    for (const workspace of await http.workspacesList()) {
      const note = (await http.workspaceNotesList(workspace.id)).find((candidate) => candidate.id === noteId)
      if (note) return { workspaceId: workspace.id, note }
    }
    throw Object.assign(new Error(`Workspace note not found: ${noteId}`), { code: 'not_found' })
  }

  async function activeOcrJob(): Promise<OcrJob> {
    const job = (await http.ocrState()).activeJob
    if (job) return job
    throw Object.assign(new Error('OCR job not found'), { code: 'not_found' })
  }

  const handlers = {
    [IpcChannel.WorkspacesList]: () => wrap(() => http.workspacesList()),
    [IpcChannel.WorkspacesCreate]: (name: string) => wrap(() => http.workspacesCreate({ name })),
    [IpcChannel.WorkspacesRename]: (id: string, name: string) =>
      wrap(async () => {
        await http.workspacesUpdate(id, { name })
      }),
    [IpcChannel.WorkspacesDelete]: (id: string) =>
      wrap(async () => {
        await http.workspacesDelete(id)
      }),
    [IpcChannel.WorkspacesOpenSandbox]: (id: string) =>
      wrap(async () => {
        await http.workspacesOpenSandbox(id)
      }),

    [IpcChannel.WorkspaceItemsList]: (workspaceId: string) => wrap(() => http.workspaceItemsList(workspaceId)),
    [IpcChannel.WorkspaceItemsAdd]: (
      workspaceId: string,
      kind: WorkspaceItemKind,
      ids: string[],
      placement?: WorkspaceItemPlacement
    ) => wrap(() => Promise.all(ids.map((id) => http.workspaceItemsCreate(workspaceId, itemInput(kind, id, placement))))),
    [IpcChannel.WorkspaceItemsRemove]: (itemId: string) =>
      wrap(async () => {
        await http.workspaceItemsDelete(await workspaceForItem(itemId), itemId)
      }),
    [IpcChannel.WorkspaceItemsReorder]: (workspaceId: string, orderedIds: string[]) =>
      wrap(async () => {
        await http.workspaceItemsReorder(workspaceId, { ids: orderedIds })
        return http.workspaceItemsList(workspaceId)
      }),
    [IpcChannel.WorkspaceItemsResize]: (itemId: string, width: number, height: number) =>
      wrap(async () => http.workspaceItemResize(await workspaceForItem(itemId), itemId, { width, height })),
    [IpcChannel.WorkspaceItemsMove]: (itemId: string, _x: number, _y: number, _zIndex: number) =>
      wrap(async () => {
        const workspaceId = await workspaceForItem(itemId)
        return http.workspaceItemMove(workspaceId, { itemId, targetWorkspaceId: workspaceId })
      }),

    [IpcChannel.WorkspaceAssetsList]: (workspaceId: string) => wrap(() => http.workspaceAssetsList(workspaceId)),
    [IpcChannel.WorkspaceAssetsAddFiles]: (
      workspaceId: string,
      paths: string[],
      _placement?: WorkspaceItemPlacement
    ) => wrap(async () => ({ imported: await http.workspaceAssetsAddFiles(workspaceId, { paths }), errors: [] })),
    [IpcChannel.WorkspaceAssetsTextPreview]: (assetId: string) =>
      wrap(async () => http.workspaceAssetPreview(await workspaceForAsset(assetId), assetId)),
    [IpcChannel.WorkspaceAssetsOpen]: (assetId: string) =>
      wrap(async () => {
        await http.workspaceAssetOpen(await workspaceForAsset(assetId), assetId)
      }),
    [IpcChannel.WorkspaceAssetsReveal]: (assetId: string) =>
      wrap(async () => {
        await http.workspaceAssetReveal(await workspaceForAsset(assetId), assetId)
      }),
    [IpcChannel.WorkspaceAssetsDelete]: (assetId: string) =>
      wrap(async () => {
        await http.workspaceAssetDelete(await workspaceForAsset(assetId), assetId)
      }),

    [IpcChannel.WorkspaceCanvasGet]: (workspaceId: string) =>
      wrap(async () => (await http.workspaceCanvasGet(workspaceId)) as WorkspaceCanvasViewport),
    [IpcChannel.WorkspaceCanvasUpdate]: (workspaceId: string, viewport: WorkspaceCanvasViewport) =>
      wrap(async () => (await http.workspaceCanvasUpdate(workspaceId, viewport)) as WorkspaceCanvasViewport),

    [IpcChannel.WorkspaceConnectionsList]: (workspaceId: string) => wrap(() => http.workspaceConnectionsList(workspaceId)),
    [IpcChannel.WorkspaceConnectionsCreate]: (
      workspaceId: string,
      sourceItemId: string,
      targetItemId: string,
      sourceAnchor: WorkspaceConnection['sourceAnchor'],
      targetAnchor: WorkspaceConnection['targetAnchor']
    ) => wrap(() => http.workspaceConnectionsCreate(workspaceId, {
      sourceItemId,
      targetItemId,
      sourceAnchor,
      targetAnchor
    })),
    [IpcChannel.WorkspaceConnectionsDelete]: (connectionId: string) =>
      wrap(async () => {
        await http.workspaceConnectionsDelete(await workspaceForConnection(connectionId), connectionId)
      }),

    [IpcChannel.WorkspaceNotesList]: (workspaceId: string) => wrap(() => http.workspaceNotesList(workspaceId)),
    [IpcChannel.WorkspaceNotesCreate]: (
      workspaceId: string,
      title: string,
      contentMd: string,
      noteType: WorkspaceNoteType,
      placement?: WorkspaceItemPlacement
    ) => wrap(() => http.workspaceNotesCreate(workspaceId, { title, contentMd, noteType, placement })),
    [IpcChannel.WorkspaceNotesUpdate]: (noteId: string, patch: WorkspaceNotePatch) =>
      wrap(async () => {
        const { workspaceId, note } = await noteForId(noteId)
        return http.workspaceNotesUpdate(workspaceId, noteId, {
          title: patch.title ?? note.title,
          contentMd: patch.contentMd ?? note.contentMd,
          noteType: note.noteType
        })
      }),
    [IpcChannel.WorkspaceNotesDelete]: (noteId: string) =>
      wrap(async () => {
        const { workspaceId } = await noteForId(noteId)
        await http.workspaceNotesDelete(workspaceId, noteId)
      }),

    [IpcChannel.MineruStatus]: () => wrap(() => http.mineruStatus()),
    [IpcChannel.MineruChooseInstallRoot]: () =>
      wrap(async () => {
        await http.mineruInstall()
        return http.mineruStatus()
      }),
    [IpcChannel.MineruInstall]: () =>
      wrap(async () => {
        await http.mineruInstall()
        return http.mineruStatus()
      }),
    [IpcChannel.MineruCancelInstall]: () =>
      wrap(async () => {
        await http.mineruCancelInstall()
        return http.mineruStatus()
      }),
    [IpcChannel.MineruUninstall]: () =>
      wrap(async () => {
        await http.mineruUninstall()
        return http.mineruStatus()
      }),

    [IpcChannel.OcrGetState]: (_documentId: string) => wrap(() => http.ocrState()),
    [IpcChannel.OcrStart]: (documentId: string, profile: OcrProfile) =>
      wrap(async () => {
        await http.ocrStart({ documentId, profile })
        return activeOcrJob()
      }),
    [IpcChannel.OcrCancel]: (jobId: string) =>
      wrap(async () => {
        await http.ocrCancel({ jobId })
        return activeOcrJob()
      }),
    [IpcChannel.OcrReadMarkdown]: (_documentId: string, resultKey: string) =>
      wrap(async () => (await http.ocrMarkdown(resultKey)).markdown)
  }

  return handlers
}

export type ServerWorkspaceHandlerMap = ReturnType<typeof createServerWorkspaceHandlers>
