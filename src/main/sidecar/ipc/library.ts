import { IpcChannel } from '../../../shared/ipc-channels'
import type {
  AiProviderInput,
  AiProviderPatch,
  DocumentPatch,
  LibrarySwitchResult,
  ListFilter,
  ListModelsRequest,
  ListModelsResult,
  PdfAnnotation,
  Result
} from '../../../shared/ipc-types'
import { normalizeModelList } from '../../../shared/modelVariant'
import type { WebSearchConfigPatch } from '../../../shared/webSearch'
import type {
  ImportBibPayload,
  ServerClient
} from '../client'
import { readFile } from 'node:fs/promises'
import { resolvePdfFilePath } from '../../services/pdfPath'

export interface ServerLibraryHandlerDeps {
  serverClient: ServerClient
  switchLibraryFolder?: (path: string) => Promise<LibrarySwitchResult>
}

function toErrorResult(error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'internal_error'
  return { ok: false, error: { code, message } }
}

async function forward<T>(request: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await request() }
  } catch (error) {
    return toErrorResult(error)
  }
}

export function createServerLibraryHandlers({
  serverClient,
  switchLibraryFolder
}: ServerLibraryHandlerDeps) {
  const { http } = serverClient

  return {
    [IpcChannel.DocumentsList]: (filter: ListFilter) =>
      forward(() => http.documentsList({
        mode: filter.mode,
        ...(filter.mode === 'category' && filter.categoryId
          ? { categoryId: filter.categoryId }
          : {}),
        ...(filter.sort
          ? { sortField: filter.sort.field, sortDir: filter.sort.dir }
          : {})
      })),
    [IpcChannel.DocumentsCount]: () => forward(() => http.documentsCount()),
    [IpcChannel.DocumentsSearch]: (query: string) => forward(() => http.documentsSearch(query)),
    [IpcChannel.DocumentsGet]: (documentId: string) => forward(() => http.documentsGet(documentId)),
    [IpcChannel.DocumentsUpdate]: (documentId: string, patch: DocumentPatch) =>
      forward(() => http.documentsUpdate(documentId, patch)),
    [IpcChannel.DocumentsSetStarred]: (documentId: string, starred: boolean) =>
      forward(() => http.documentsSetStarred(documentId, starred)),
    [IpcChannel.DocumentsDelete]: (documentId: string) =>
      forward(() => http.documentsDelete(documentId)),
    [IpcChannel.DocumentsBulkDelete]: (documentIds: string[]) =>
      forward(() => http.documentsBulkDelete(documentIds)),
    [IpcChannel.DocumentsBulkCategorize]: (ids: string[], categoryId: string | null) =>
      forward(() => http.documentsBulkCategorize({ ids, categoryId })),
    [IpcChannel.DocumentsBulkRefreshMetadata]: (documentIds: string[]) =>
      forward(() => http.documentsBulkRefreshMetadata(documentIds)),
    [IpcChannel.DocumentsOpenPdf]: (documentId: string, external?: boolean) =>
      forward(() => external === false
        ? http.documentsOpenPdf(documentId, false)
        : http.documentsOpenPdf(documentId)),
    [IpcChannel.DocumentsReadPdf]: (documentId: string) =>
      forward(async () => {
        const document = await http.documentsGet(documentId)
        return new Uint8Array(await readFile(resolvePdfFilePath(document.filePath)))
      }),
    [IpcChannel.DocumentsPdfAnnotationsGet]: (documentId: string) =>
      forward(() => http.documentsPdfAnnotations(documentId)),
    [IpcChannel.DocumentsPdfAnnotationsSet]: (
      documentId: string,
      annotations: PdfAnnotation[]
    ) => forward(() => http.documentsSetPdfAnnotations(documentId, annotations)),
    [IpcChannel.DocumentsOpenInFinder]: (documentId: string) =>
      forward(() => http.documentsOpenInFinder(documentId)),
    [IpcChannel.DocumentsRefreshMetadata]: (documentId: string) =>
      forward(() => http.documentsRefreshMetadata(documentId)),
    [IpcChannel.DocumentsRelocateFile]: (documentId: string, path: string) =>
      forward(() => http.documentsRelocate(documentId, { path })),
    [IpcChannel.DocumentsRestoreFile]: (documentId: string) =>
      forward(() => http.documentsRestoreFile(documentId)),

    [IpcChannel.ImportAddFiles]: (paths: string[]) => forward(() => http.importFiles({ paths })),
    [IpcChannel.ImportAddFolder]: (path: string) => forward(() => http.importFolder({ path })),
    [IpcChannel.ImportFromJson]: (file: string) =>
      forward(async () => (await http.importJson(file)).imported),
    [IpcChannel.ImportFromZotero]: (payload: ImportBibPayload = { paths: [] }) =>
      forward(() => http.importZotero(payload)),
    [IpcChannel.ImportFromMendeley]: (payload: ImportBibPayload = { paths: [] }) =>
      forward(() => http.importMendeley(payload)),
    [IpcChannel.ImportFromIdentifier]: (identifier: string) =>
      forward(async () => {
        const result = await http.importIdentifier({ identifier })
        return { added: [result.documentId] }
      }),

    [IpcChannel.CategoriesList]: () => forward(() => http.categoriesList()),
    [IpcChannel.CategoriesCreate]: (name: string, color?: string) =>
      forward(() => http.categoriesCreate({ name, ...(color === undefined ? {} : { color }) })),
    [IpcChannel.CategoriesRename]: (categoryId: string, name: string) =>
      forward(() => http.categoriesUpdate(categoryId, { name })),
    [IpcChannel.CategoriesDelete]: (categoryId: string) =>
      forward(() => http.categoriesDelete(categoryId)),
    [IpcChannel.CategoriesAssign]: (documentId: string, categoryId: string) =>
      forward(() => http.categoriesAssign(categoryId, { documentIds: [documentId] })),
    [IpcChannel.CategoriesUnassign]: (documentId: string, categoryId: string) =>
      forward(() => http.categoriesUnassign(categoryId, { documentIds: [documentId] })),

    [IpcChannel.WatchList]: () => forward(() => http.watchList()),
    [IpcChannel.WatchAdd]: (path: string) => forward(() => http.watchAdd({ path })),
    [IpcChannel.WatchRemove]: (watchId: string) => forward(() => http.watchRemove(watchId)),
    [IpcChannel.WatchToggle]: (watchId: string, enabled: boolean) =>
      forward(() => http.watchToggle(watchId, { enabled })),

    [IpcChannel.LibrarySwitch]: (path: string) =>
      switchLibraryFolder ? forward<LibrarySwitchResult>(() => switchLibraryFolder(path)) : forward(() => http.librarySwitch({ path })),

    [IpcChannel.SettingsGet]: (key: string, defaultValue: unknown) =>
      forward(async () => {
        const settings = await http.settingsGet()
        return settings[key] ?? defaultValue
      }),
    [IpcChannel.SettingsSet]: (key: string, value: unknown) =>
      forward(() => http.settingsUpdate({ [key]: value })),

    [IpcChannel.WebSearchConfigGet]: () => forward(() => http.settingsWebSearchGet()),
    [IpcChannel.WebSearchConfigUpdate]: (patch: WebSearchConfigPatch) =>
      forward(() => http.settingsWebSearchUpdate(patch)),
    [IpcChannel.WebSearchTest]: (query = '') => forward(() => http.settingsWebSearchTest(query)),

    [IpcChannel.AiProvidersList]: () => forward(() => http.aiProvidersList()),
    [IpcChannel.AiProvidersCreate]: (input: AiProviderInput) =>
      forward(() => http.aiProvidersCreate(input)),
    [IpcChannel.AiProvidersUpdate]: (providerId: string, input: AiProviderPatch) =>
      forward(() => http.aiProvidersUpdate(providerId, input as AiProviderInput)),
    [IpcChannel.AiProvidersDelete]: (providerId: string) =>
      forward(() => http.aiProvidersDelete(providerId)),
    [IpcChannel.AiProvidersTest]: (providerId: string) =>
      forward(() => http.aiProvidersTest(providerId)),
    [IpcChannel.AiProvidersListModels]: (request: ListModelsRequest | string) =>
      forward<ListModelsResult>(async () => {
        const parsed = typeof request === 'string' ? { providerId: request } : request
        const result = await http.aiProvidersModels(parsed)
        if (result.ok === false) {
          return { ok: false, models: [], error: result.error ?? 'Failed to list provider models' }
        }
        return {
          ok: true,
          models: normalizeModelList(result.models, undefined, parsed.presetId ?? 'custom')
        }
      }),

    [IpcChannel.ExportToJson]: (payload: { documentIds?: string[]; workspaceId?: string } = {}) =>
      forward(async () => JSON.stringify(await http.exportJson(payload), null, 2)),
    [IpcChannel.ExportToBibtex]: (documentIds: string[]) =>
      forward(async () => {
        const result = await http.exportBibtex({ documentIds })
        return result.bibtex
      }),
    [IpcChannel.ExportBibtexString]: (documentIds: string[]) =>
      forward(async () => (await http.exportBibtexString(documentIds)).bibtex),

    [IpcChannel.ClipboardWriteText]: (text: string) =>
      forward(() => http.clipboardWriteText({ text })),
    [IpcChannel.ClipboardCopyMarkdown]: (title: string, content: string) =>
      forward(() => http.clipboardCopyMarkdown({ title, markdown: content })),
    [IpcChannel.ClipboardCopyWorkspaceAsset]: (assetId: string) =>
      forward(() => http.clipboardCopyWorkspaceAsset({ assetId }))
  }
}

export type ServerLibraryHandlerMap = ReturnType<typeof createServerLibraryHandlers>
