import { describe, expect, it, vi } from 'vitest'
import { createServerLibraryHandlers } from '../../src/main/ipc/serverLibraryHandlers'
import { IpcChannel } from '../../src/shared/ipc-channels'
import type { ServerClient } from '../../src/main/services/serverClient'

function createClient() {
  const methods = new Map<string, ReturnType<typeof vi.fn>>()
  const http = new Proxy({}, {
    get(_target, property) {
      const name = String(property)
      let method = methods.get(name)
      if (!method) {
        method = vi.fn().mockResolvedValue({ method: name })
        methods.set(name, method)
      }
      return method
    }
  })
  const client = new Proxy({ http }, {
    get(target, property) {
      if (property === 'http') return target.http
      throw new Error(`Unexpected server client property: ${String(property)}`)
    }
  }) as ServerClient
  return { client, methods }
}

type Invocation = {
  channel: string
  args: unknown[]
  method: string
  forwarded: unknown[]
  data?: unknown
}

describe('createServerLibraryHandlers', () => {
  it('forwards every library IPC channel to the matching HTTP client method', async () => {
    const { client, methods } = createClient()
    const handlers = createServerLibraryHandlers({ serverClient: client }) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    void client.http.importJson
    void client.http.importZotero
    void client.http.importMendeley
    void client.http.importIdentifier
    void client.http.aiProvidersModels
    void client.http.exportJson
    void client.http.exportBibtex
    void client.http.exportBibtexString
    methods.get('importJson')?.mockResolvedValue({ imported: 3 })
    methods.get('importZotero')?.mockResolvedValue({ added: 2, skipped: 1, errors: [] })
    methods.get('importMendeley')?.mockResolvedValue({ added: 1, skipped: 0, errors: [] })
    methods.get('importIdentifier')?.mockResolvedValue({ documentId: 'doc-new' })
    methods.get('aiProvidersModels')?.mockResolvedValue({ ok: true, models: ['gpt-5'] })
    methods.get('exportJson')?.mockResolvedValue({ version: 1 })
    methods.get('exportBibtex')?.mockResolvedValue({ bibtex: '@article{one}' })
    methods.get('exportBibtexString')?.mockResolvedValue({ bibtex: '@article{two}' })
    const invocations: Invocation[] = [
      {
        channel: IpcChannel.DocumentsList,
        args: [{ mode: 'category', categoryId: 'cat-1', sort: { field: 'year', dir: 'asc' } }],
        method: 'documentsList',
        forwarded: [{ mode: 'category', categoryId: 'cat-1', sortField: 'year', sortDir: 'asc' }]
      },
      { channel: IpcChannel.DocumentsCount, args: [], method: 'documentsCount', forwarded: [] },
      { channel: IpcChannel.DocumentsSearch, args: ['paper'], method: 'documentsSearch', forwarded: ['paper'] },
      { channel: IpcChannel.DocumentsGet, args: ['doc-1'], method: 'documentsGet', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsUpdate, args: ['doc-1', { title: 'New' }], method: 'documentsUpdate', forwarded: ['doc-1', { title: 'New' }] },
      { channel: IpcChannel.DocumentsSetStarred, args: ['doc-1', true], method: 'documentsSetStarred', forwarded: ['doc-1', true] },
      { channel: IpcChannel.DocumentsDelete, args: ['doc-1'], method: 'documentsDelete', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsBulkDelete, args: [['doc-1']], method: 'documentsBulkDelete', forwarded: [['doc-1']] },
      { channel: IpcChannel.DocumentsBulkCategorize, args: [['doc-1'], 'cat-1'], method: 'documentsBulkCategorize', forwarded: [{ ids: ['doc-1'], categoryId: 'cat-1' }] },
      { channel: IpcChannel.DocumentsBulkRefreshMetadata, args: [['doc-1']], method: 'documentsBulkRefreshMetadata', forwarded: [['doc-1']] },
      { channel: IpcChannel.DocumentsOpenPdf, args: ['doc-1'], method: 'documentsOpenPdf', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsOpenInFinder, args: ['doc-1'], method: 'documentsOpenInFinder', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsRefreshMetadata, args: ['doc-1'], method: 'documentsRefreshMetadata', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsRelocateFile, args: ['doc-1', '/tmp/paper.pdf'], method: 'documentsRelocate', forwarded: ['doc-1', { path: '/tmp/paper.pdf' }] },
      { channel: IpcChannel.DocumentsRestoreFile, args: ['doc-1'], method: 'documentsRestoreFile', forwarded: ['doc-1'] },
      { channel: IpcChannel.ImportAddFiles, args: [['/tmp/paper.pdf']], method: 'importFiles', forwarded: [{ paths: ['/tmp/paper.pdf'] }] },
      { channel: IpcChannel.ImportAddFolder, args: ['/tmp'], method: 'importFolder', forwarded: [{ path: '/tmp' }] },
      { channel: IpcChannel.ImportFromJson, args: ['/tmp/data.json'], method: 'importJson', forwarded: ['/tmp/data.json'], data: 3 },
      { channel: IpcChannel.ImportFromZotero, args: [{ paths: ['/tmp/zotero.bib'] }], method: 'importZotero', forwarded: [{ paths: ['/tmp/zotero.bib'] }], data: { added: 2, skipped: 1, errors: [] } },
      { channel: IpcChannel.ImportFromMendeley, args: [{ paths: ['/tmp/mendeley.bib'] }], method: 'importMendeley', forwarded: [{ paths: ['/tmp/mendeley.bib'] }], data: { added: 1, skipped: 0, errors: [] } },
      { channel: IpcChannel.ImportFromIdentifier, args: ['10.1000/test'], method: 'importIdentifier', forwarded: [{ identifier: '10.1000/test' }], data: { added: ['doc-new'] } },
      { channel: IpcChannel.CategoriesList, args: [], method: 'categoriesList', forwarded: [] },
      { channel: IpcChannel.CategoriesCreate, args: ['Reading', '#ff0000'], method: 'categoriesCreate', forwarded: [{ name: 'Reading', color: '#ff0000' }] },
      { channel: IpcChannel.CategoriesRename, args: ['cat-1', 'Read'], method: 'categoriesUpdate', forwarded: ['cat-1', { name: 'Read' }] },
      { channel: IpcChannel.CategoriesDelete, args: ['cat-1'], method: 'categoriesDelete', forwarded: ['cat-1'] },
      { channel: IpcChannel.CategoriesAssign, args: ['doc-1', 'cat-1'], method: 'categoriesAssign', forwarded: ['cat-1', { documentIds: ['doc-1'] }] },
      { channel: IpcChannel.CategoriesUnassign, args: ['doc-1', 'cat-1'], method: 'categoriesUnassign', forwarded: ['cat-1', { documentIds: ['doc-1'] }] },
      { channel: IpcChannel.WatchList, args: [], method: 'watchList', forwarded: [] },
      { channel: IpcChannel.WatchAdd, args: ['/tmp/watch'], method: 'watchAdd', forwarded: [{ path: '/tmp/watch' }] },
      { channel: IpcChannel.WatchRemove, args: ['watch-1'], method: 'watchRemove', forwarded: ['watch-1'] },
      { channel: IpcChannel.WatchToggle, args: ['watch-1', true], method: 'watchToggle', forwarded: ['watch-1', { enabled: true }] },
      { channel: IpcChannel.LibrarySwitch, args: ['/tmp/library'], method: 'librarySwitch', forwarded: [{ path: '/tmp/library' }] },
      { channel: IpcChannel.SettingsGet, args: ['language', 'en'], method: 'settingsGet', forwarded: [] },
      { channel: IpcChannel.SettingsSet, args: ['language', 'zh'], method: 'settingsUpdate', forwarded: [{ language: 'zh' }] },
      { channel: IpcChannel.WebSearchConfigGet, args: [], method: 'settingsWebSearchGet', forwarded: [] },
      { channel: IpcChannel.WebSearchConfigUpdate, args: [{ provider: 'tavily' }], method: 'settingsWebSearchUpdate', forwarded: [{ provider: 'tavily' }] },
      { channel: IpcChannel.WebSearchTest, args: ['quantum'], method: 'settingsWebSearchTest', forwarded: ['quantum'] },
      { channel: IpcChannel.AiProvidersList, args: [], method: 'aiProvidersList', forwarded: [] },
      { channel: IpcChannel.AiProvidersCreate, args: [{ name: 'OpenAI' }], method: 'aiProvidersCreate', forwarded: [{ name: 'OpenAI' }] },
      { channel: IpcChannel.AiProvidersUpdate, args: ['provider-1', { name: 'Updated' }], method: 'aiProvidersUpdate', forwarded: ['provider-1', { name: 'Updated' }] },
      { channel: IpcChannel.AiProvidersDelete, args: ['provider-1'], method: 'aiProvidersDelete', forwarded: ['provider-1'] },
      { channel: IpcChannel.AiProvidersTest, args: ['provider-1'], method: 'aiProvidersTest', forwarded: ['provider-1'] },
      { channel: IpcChannel.AiProvidersListModels, args: [{ providerId: 'provider-1', presetId: 'openai' }], method: 'aiProvidersModels', forwarded: [{ providerId: 'provider-1', presetId: 'openai' }], data: { ok: true, models: [expect.objectContaining({ id: 'gpt-5' })] } },
      { channel: IpcChannel.ExportToJson, args: [{ documentIds: ['doc-1'] }], method: 'exportJson', forwarded: [{ documentIds: ['doc-1'] }], data: '{\n  "version": 1\n}' },
      { channel: IpcChannel.ExportToBibtex, args: [['doc-1']], method: 'exportBibtex', forwarded: [{ documentIds: ['doc-1'] }], data: '@article{one}' },
      { channel: IpcChannel.ExportBibtexString, args: [['doc-1']], method: 'exportBibtexString', forwarded: [['doc-1']], data: '@article{two}' },
      { channel: IpcChannel.ClipboardWriteText, args: ['text'], method: 'clipboardWriteText', forwarded: [{ text: 'text' }] },
      { channel: IpcChannel.ClipboardCopyMarkdown, args: ['title', 'markdown'], method: 'clipboardCopyMarkdown', forwarded: [{ title: 'title', markdown: 'markdown' }] },
      { channel: IpcChannel.ClipboardCopyWorkspaceAsset, args: ['asset-1'], method: 'clipboardCopyWorkspaceAsset', forwarded: [{ assetId: 'asset-1' }] }
    ]

    for (const { channel, args, method, forwarded, data } of invocations) {
      const result = await handlers[channel](...args)
      if (channel === IpcChannel.SettingsGet) {
        expect(result).toEqual({ ok: true, data: 'en' })
      } else if (data !== undefined) {
        expect(result).toEqual({ ok: true, data })
      } else {
        expect(result).toEqual({ ok: true, data: { method } })
      }
      expect(methods.get(method)).toHaveBeenLastCalledWith(...forwarded)
    }
  })

  it('uses server error codes and does not access legacy dependencies', async () => {
    const { client, methods } = createClient()
    const handlers = createServerLibraryHandlers({ serverClient: client }) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    void client.http.documentsGet
    const documentsGet = methods.get('documentsGet')
    documentsGet?.mockRejectedValueOnce(Object.assign(new Error('Missing document'), {
      code: 'not_found'
    }))

    await expect(handlers[IpcChannel.DocumentsGet]('missing')).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Missing document' }
    })
  })

  it('routes metadata refresh and arxiv verification to Python', async () => {
    const { client, methods } = createClient()
    const handlers = createServerLibraryHandlers({ serverClient: client }) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >

    await handlers[IpcChannel.DocumentsRefreshMetadata]('doc-1')
    await handlers[IpcChannel.DocumentsBulkRefreshMetadata](['doc-1', 'doc-2'])
    await handlers[IpcChannel.DocumentsUpdate]('doc-1', {
      arxivId: 'https://arxiv.org/abs/2401.12345',
      title: 'Verified'
    })

    expect(methods.get('documentsRefreshMetadata')).toHaveBeenCalledWith('doc-1')
    expect(methods.get('documentsBulkRefreshMetadata')).toHaveBeenCalledWith([
      'doc-1',
      'doc-2'
    ])
    expect(methods.get('documentsUpdate')).toHaveBeenCalledWith('doc-1', {
      arxivId: 'https://arxiv.org/abs/2401.12345',
      title: 'Verified'
    })
  })
})
