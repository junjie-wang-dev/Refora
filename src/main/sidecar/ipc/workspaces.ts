import { IpcChannel } from '../../../shared/ipc-channels'
import type {
  WorkspaceCanvasViewport,
  WorkspaceConnection,
  WorkspaceItemKind,
  WorkspaceItemPlacement,
  WorkspaceNote,
  WorkspaceNotePatch,
  WorkspaceNoteType
} from '../../../shared/ipc-types'
import type { OcrJob, OcrProfile } from '../../../shared/mineru-types'
import type { ServerClient } from '../client'
import { resultify as wrap } from './result'

export interface ServerWorkspaceHandlerDeps {
  consumeFile?: (path: string, extensions?: readonly string[]) => string
  consumeFiles?: (paths: readonly string[], extensions?: readonly string[]) => string[]
}

export function createServerWorkspaceHandlers(
  serverClient: ServerClient,
  { consumeFile, consumeFiles }: ServerWorkspaceHandlerDeps = {}
) {
  const { http } = serverClient

  async function workspaceForItem(itemId: string): Promise<string> {
    return (await http.workspaceItemGet(itemId)).workspaceId
  }

  async function workspaceForAsset(assetId: string): Promise<string> {
    return (await http.workspaceAssetGet(assetId)).workspaceId
  }

  async function workspaceForConnection(connectionId: string): Promise<string> {
    return (await http.workspaceConnectionGet(connectionId)).workspaceId
  }

  async function noteForId(noteId: string): Promise<{ workspaceId: string; note: WorkspaceNote }> {
    const note = await http.workspaceNoteGet(noteId)
    return { workspaceId: note.workspaceId, note }
  }

  async function activeOcrJob(documentId: string, jobId: string): Promise<OcrJob> {
    const job = (await http.ocrState(documentId)).activeJob
    if (job?.id === jobId) return job
    throw Object.assign(new Error(`OCR job not found: ${jobId}`), { code: 'not_found' })
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
    ) => wrap(() => http.workspaceItemsCreateBatch(workspaceId, { kind, ids, placement })),
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
    [IpcChannel.WorkspaceItemsMove]: (itemId: string, x: number, y: number, zIndex: number) =>
      wrap(async () => {
        const workspaceId = await workspaceForItem(itemId)
        return http.workspaceItemMove(workspaceId, { itemId, x, y, zIndex })
      }),

    [IpcChannel.WorkspaceAssetsList]: (workspaceId: string) => wrap(() => http.workspaceAssetsList(workspaceId)),
    [IpcChannel.WorkspaceAssetsAddFiles]: (
      workspaceId: string,
      paths: string[],
      placement?: WorkspaceItemPlacement
    ) => wrap(() => http.workspaceAssetsAddFiles(workspaceId, {
      paths: consumeFiles
        ? consumeFiles(paths)
        : consumeFile
          ? paths.map((path) => consumeFile(path))
          : paths,
      placement
    })),
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

    [IpcChannel.WorkspaceFilesAdd]: (
      workspaceId: string,
      paths: string[],
      placement?: WorkspaceItemPlacement
    ) => wrap(() => http.workspaceFilesAdd(workspaceId, {
      paths: consumeFiles
        ? consumeFiles(paths)
        : consumeFile
          ? paths.map((path) => consumeFile(path))
          : paths,
      placement
    })),

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
        const { workspaceId } = await noteForId(noteId)
        return http.workspaceNotesUpdate(workspaceId, noteId, patch)
      }),
    [IpcChannel.WorkspaceNotesDelete]: (noteId: string) =>
      wrap(async () => {
        const { workspaceId } = await noteForId(noteId)
        await http.workspaceNotesDelete(workspaceId, noteId)
      }),

    [IpcChannel.MineruStatus]: () => wrap(() => http.mineruStatus()),
    [IpcChannel.MineruChooseInstallRoot]: () => wrap(() => http.mineruChooseInstallRoot()),
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

    [IpcChannel.OcrGetState]: (documentId: string) => wrap(() => http.ocrState(documentId)),
    [IpcChannel.OcrStart]: (documentId: string, profile: OcrProfile) =>
      wrap(async () => {
        const { jobId } = await http.ocrStart({ documentId, profile })
        return activeOcrJob(documentId, jobId)
      }),
    [IpcChannel.OcrCancel]: (jobId: string) => wrap(() => http.ocrCancel({ jobId })),
    [IpcChannel.OcrReadMarkdown]: (documentId: string, resultKey: string) =>
      wrap(async () => (await http.ocrMarkdown(documentId, resultKey)).markdown)
  }

  return handlers
}

export type ServerWorkspaceHandlerMap = ReturnType<typeof createServerWorkspaceHandlers>
