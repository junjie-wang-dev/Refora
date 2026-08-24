import { describe, expect, it, vi } from 'vitest'
import { createServerLibraryHandlers } from '../../src/main/sidecar/ipc/library'
import { IpcChannel } from '../../src/shared/ipc-channels'
import type { ServerClient } from '../../src/main/sidecar/client'
import type { AiProviderPatch } from '../../src/shared/ipc-types'

vi.mock('../../src/main/services/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  }
}))

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
  it('notifies the main process after a setting is persisted', async () => {
    const { client } = createClient()
    const onSettingUpdated = vi.fn()
    const handlers = createServerLibraryHandlers({
      serverClient: client,
      onSettingUpdated
    }) as Record<string, (...args: unknown[]) => Promise<unknown>>

    await handlers[IpcChannel.SettingsSet]('language', 'zh')

    expect(onSettingUpdated).toHaveBeenCalledWith('language', 'zh')
  })

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
        args: [{
          mode: 'category',
          categoryId: 'cat-1',
          sort: { field: 'year', dir: 'asc' },
          limit: 100,
          offset: 200
        }],
        method: 'documentsList',
        forwarded: [{
          mode: 'category',
          categoryId: 'cat-1',
          sortField: 'year',
          sortDir: 'asc',
          limit: 100,
          offset: 200
        }]
      },
      { channel: IpcChannel.DocumentsCount, args: [], method: 'documentsCount', forwarded: [] },
      {
        channel: IpcChannel.DocumentsSearch,
        args: ['paper', { limit: 100, offset: 200 }],
        method: 'documentsSearch',
        forwarded: ['paper', { limit: 100, offset: 200 }]
      },
      { channel: IpcChannel.DocumentsGet, args: ['doc-1'], method: 'documentsGet', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsUpdate, args: ['doc-1', { title: 'New' }], method: 'documentsUpdate', forwarded: ['doc-1', { title: 'New' }] },
      { channel: IpcChannel.DocumentsSetStarred, args: ['doc-1', true], method: 'documentsSetStarred', forwarded: ['doc-1', true] },
      { channel: IpcChannel.DocumentsDelete, args: ['doc-1'], method: 'documentsDelete', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsBulkDelete, args: [['doc-1']], method: 'documentsBulkDelete', forwarded: [['doc-1']] },
      { channel: IpcChannel.DocumentsBulkCategorize, args: [['doc-1'], 'cat-1'], method: 'documentsBulkCategorize', forwarded: [{ ids: ['doc-1'], categoryId: 'cat-1' }] },
      { channel: IpcChannel.DocumentsBulkRefreshMetadata, args: [['doc-1']], method: 'documentsBulkRefreshMetadata', forwarded: [['doc-1']] },
      { channel: IpcChannel.DocumentsOpenPdf, args: ['doc-1'], method: 'documentsOpenPdf', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsPdfAnnotationsGet, args: ['doc-1'], method: 'documentsPdfAnnotations', forwarded: ['doc-1'] },
      { channel: IpcChannel.DocumentsPdfAnnotationsSet, args: ['doc-1', []], method: 'documentsSetPdfAnnotations', forwarded: ['doc-1', []] },
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
      { channel: IpcChannel.AgentProfilesScanRuntimes, args: [], method: 'agentProfilesScanRuntimes', forwarded: [] },
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

  it('cleans preview caches only after document deletion succeeds', async () => {
    const { client, methods } = createClient()
    void client.http.documentsDelete
    void client.http.documentsBulkDelete
    const removeDocumentPreviewCache = vi.fn().mockResolvedValue(undefined)
    const handlers = createServerLibraryHandlers({
      serverClient: client,
      removeDocumentPreviewCache
    })

    await handlers[IpcChannel.DocumentsDelete]('doc-1')
    await handlers[IpcChannel.DocumentsBulkDelete](['doc-2', 'doc-3'])

    expect(removeDocumentPreviewCache.mock.calls).toEqual([
      ['doc-1'],
      ['doc-2'],
      ['doc-3']
    ])
    methods.get('documentsDelete')?.mockRejectedValueOnce(new Error('delete failed'))
    await expect(handlers[IpcChannel.DocumentsDelete]('doc-4')).resolves.toMatchObject({
      ok: false
    })
    expect(removeDocumentPreviewCache).not.toHaveBeenCalledWith('doc-4')
  })

  it('requires authorized renderer paths before forwarding file operations', async () => {
    const { client, methods } = createClient()
    const consumeFile = vi.fn((path: string) => `/approved${path}`)
    const consumeFiles = vi.fn((paths: readonly string[]) => paths.map((path) => `/approved${path}`))
    const consumeDirectory = vi.fn((path: string) => `/approved${path}`)
    const handlers = createServerLibraryHandlers({
      serverClient: client,
      consumeFile,
      consumeFiles,
      consumeDirectory
    })

    await handlers[IpcChannel.ImportAddFiles](['/tmp/paper.pdf'])
    await handlers[IpcChannel.ImportFromJson]('/tmp/data.json')
    await handlers[IpcChannel.LibrarySwitch]('/tmp/library')

    expect(consumeFiles).toHaveBeenCalledWith(['/tmp/paper.pdf'], ['.pdf'])
    expect(consumeFile).toHaveBeenCalledWith('/tmp/data.json', ['.json'])
    expect(consumeDirectory).toHaveBeenCalledWith('/tmp/library')
    expect(methods.get('importFiles')).toHaveBeenCalledWith({
      paths: ['/approved/tmp/paper.pdf']
    })
    expect(methods.get('importJson')).toHaveBeenCalledWith('/approved/tmp/data.json')
    expect(methods.get('librarySwitch')).toHaveBeenCalledWith({
      path: '/approved/tmp/library'
    })
  })

  it('forwards the built-in PDF reader flag to the server', async () => {
    const { client, methods } = createClient()
    const handlers = createServerLibraryHandlers({ serverClient: client }) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >

    await handlers[IpcChannel.DocumentsOpenPdf]('doc-1', false)

    expect(methods.get('documentsOpenPdf')).toHaveBeenCalledWith('doc-1', false)
  })

  it('resolves PDF ranges through the current document id', async () => {
    const { client, methods } = createClient()
    void client.http.documentsGet
    methods.get('documentsGet')?.mockResolvedValue({ filePath: '/library/paper.pdf' })
    const readPdfRange = vi.fn().mockResolvedValue({
      begin: 1024,
      fileSize: 4096,
      data: new Uint8Array([1, 2])
    })
    const handlers = createServerLibraryHandlers({
      serverClient: client,
      readPdfRange
    }) as Record<string, (...args: unknown[]) => Promise<unknown>>

    await expect(
      handlers[IpcChannel.DocumentsReadPdfRange]('doc-1', 1024, 2048)
    ).resolves.toEqual({
      ok: true,
      data: {
        begin: 1024,
        fileSize: 4096,
        data: new Uint8Array([1, 2])
      }
    })
    expect(methods.get('documentsGet')).toHaveBeenCalledWith('doc-1')
    expect(readPdfRange).toHaveBeenCalledWith('/library/paper.pdf', 1024, 2048)
  })

  it('validates provider updates and strips unknown fields before forwarding', async () => {
    const { client, methods } = createClient()
    const handlers = createServerLibraryHandlers({ serverClient: client }) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    void client.http.aiProvidersUpdate

    await handlers[IpcChannel.AiProvidersUpdate]('provider-1', {
      name: 'Updated',
      rogueField: 'x'
    } as AiProviderPatch)

    expect(methods.get('aiProvidersUpdate')).toHaveBeenCalledWith('provider-1', { name: 'Updated' })

    await expect(
      handlers[IpcChannel.AiProvidersUpdate]('provider-1', { name: 42 } as unknown as AiProviderPatch)
    ).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request_payload', message: 'AI provider update field name is invalid' }
    })
  })

  it('uses the saved provider preset when normalizing dynamically listed models', async () => {
    const { client, methods } = createClient()
    const handlers = createServerLibraryHandlers({ serverClient: client }) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    void client.http.aiProvidersModels
    void client.http.aiProvidersList
    methods.get('aiProvidersModels')?.mockResolvedValue({ ok: true, models: ['gpt-5'] })
    methods.get('aiProvidersList')?.mockResolvedValue([
      { id: 'provider-1', presetId: 'openai' }
    ])

    const result = await handlers[IpcChannel.AiProvidersListModels]({
      providerId: 'provider-1'
    })

    expect(result).toEqual({
      ok: true,
      data: {
        ok: true,
        models: [
          expect.objectContaining({
            id: 'gpt-5',
            supportsReasoning: true,
            reasoningEfforts: expect.arrayContaining(['medium', 'high'])
          })
        ]
      }
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
