import { EventEmitter } from 'node:events'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createNativeRpc } from '../../src/main/sidecar/nativeRpc'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'

const electronMocks = vi.hoisted(() => ({
  trashItem: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  writeText: vi.fn()
}))

vi.mock('electron', () => ({
  shell: {
    trashItem: electronMocks.trashItem,
    openPath: electronMocks.openPath,
    showItemInFolder: electronMocks.showItemInFolder
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showMessageBox: electronMocks.showMessageBox
  },
  clipboard: {
    writeText: electronMocks.writeText
  }
}))

vi.mock('../../src/main/services/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  }
}))

const TOKEN = 'shared-secret-token'

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

function createFakeHttpServer() {
  let currentHandler: RequestHandler | null = null
  const server = new EventEmitter() as Server & {
    listen: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    address: () => { port: number }
    _dispatch: (req: IncomingMessage, res: ServerResponse) => void
  }
  server.listen = vi.fn((port: number, host: string, cb?: () => void) => {
    cb?.()
  })
  server.address = () => ({ port: 54321 })
  server.close = vi.fn((cb?: () => void) => {
    cb?.()
  })
  ;(server as unknown as { _dispatch: RequestHandler })._dispatch = (req, res) => {
    currentHandler?.(req, res)
  }
  const factory = vi.fn((handler: RequestHandler) => {
    currentHandler = handler
    return server
  })
  return { factory, server }
}

function mockRequest(
  method: string,
  path: string,
  body: unknown,
  token?: string
): { req: IncomingMessage; res: ServerResponse; responsePromise: Promise<{ status: number; body: unknown }> } {
  const req = new EventEmitter() as IncomingMessage
  ;(req as unknown as { method: string }).method = method
  ;(req as unknown as { url: string }).url = path
  ;(req as unknown as { headers: Record<string, string | string[]> }).headers = {}
  if (token !== undefined) {
    ;(req as unknown as { headers: Record<string, string> }).headers['x-refora-token'] = token
  }
  const res = new EventEmitter() as unknown as ServerResponse & {
    statusCode: number
    headers: Record<string, string>
    written: string
    writeHead: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
  res.statusCode = 200
  res.headers = {}
  res.written = ''
  res.writeHead = vi.fn((status: number, headers?: Record<string, string>) => {
    res.statusCode = status
    if (headers) Object.assign(res.headers, headers)
  })
  res.end = vi.fn((payload?: string) => {
    if (payload) res.written = payload
    res.emit('finish')
  })
  const responsePromise = new Promise<{ status: number; body: unknown }>((resolve) => {
    res.once('finish', () => {
      resolve({ status: res.statusCode, body: res.written ? JSON.parse(res.written) : null })
    })
  })
  queueMicrotask(() => {
    if (body === null) return
    const bodyStr = body === undefined ? '' : JSON.stringify(body)
    req.emit('data', Buffer.from(bodyStr))
    req.emit('end')
  })
  return { req, res, responsePromise }
}

function makeRepos(overrides: Partial<{ getRaw: ReturnType<typeof vi.fn> }> = {}) {
  return {
    aiProviders: {
      getRaw: overrides.getRaw ?? vi.fn(() => null)
    }
  } as unknown as Parameters<typeof createNativeRpc>[0]['repos']
}

function makeSafeStorage(overrides: Partial<{ decrypt: ReturnType<typeof vi.fn> }> = {}) {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encrypt: vi.fn(() => Buffer.from('enc')),
    decrypt: overrides.decrypt ?? vi.fn(() => 'decrypted-key')
  }
}

describe('nativeRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function setup(overrides: {
    repos?: Parameters<typeof createNativeRpc>[0]['repos']
    safeStorage?: ReturnType<typeof makeSafeStorage>
    token?: string
    copyFileToClipboard?: (path: string) => void
    setProxy?: (proxyRules: string) => Promise<void>
  } = {}) {
    const { factory, server } = createFakeHttpServer()
    const rpc = createNativeRpc({
      repos: overrides.repos ?? makeRepos(),
      token: overrides.token ?? TOKEN,
      safeStorage: overrides.safeStorage ?? makeSafeStorage(),
      copyFileToClipboard: overrides.copyFileToClipboard,
      setProxy: overrides.setProxy,
      createHttpServer: factory
    })
    const info = await rpc.start()
    return { rpc, server, info }
  }

  async function dispatch(
    server: Server & { _dispatch: (req: IncomingMessage, res: ServerResponse) => void },
    method: string,
    path: string,
    body: unknown,
    token?: string
  ): Promise<{ status: number; body: unknown }> {
    const { req, res, responsePromise } = mockRequest(method, path, body, token)
    ;(server as unknown as { _dispatch: (req: IncomingMessage, res: ServerResponse) => void })._dispatch(req, res)
    return responsePromise
  }

  it('binds to a random 127.0.0.1 port and exposes the token', async () => {
    const { info } = await setup()
    expect(info.baseUrl).toBe('http://127.0.0.1:54321')
    expect(info.token).toBe(TOKEN)
  })

  it('returns cached info on subsequent start calls', async () => {
    const { rpc, info } = await setup()
    const second = await rpc.start()
    expect(second).toEqual(info)
  })

  it('rejects requests without a token with 401', async () => {
    const { server } = await setup()
    const { status, body } = await dispatch(server, 'POST', '/native/trash-item', { path: '/x' })
    expect(status).toBe(401)
    expect(body).toEqual({ ok: false, error: { code: 'unauthorized', message: expect.any(String) } })
  })

  it('rejects requests with the wrong token with 401', async () => {
    const { server } = await setup()
    const { status } = await dispatch(
      server,
      'POST',
      '/native/trash-item',
      { path: '/x' },
      'wrong-token'
    )
    expect(status).toBe(401)
  })

  it('rejects non-POST methods with 405', async () => {
    const { server } = await setup()
    const { status, body } = await dispatch(server, 'GET', '/native/trash-item', {}, TOKEN)
    expect(status).toBe(405)
    expect(body).toMatchObject({ ok: false, error: { code: 'method_not_allowed' } })
  })

  it('trashes an item via shell.trashItem', async () => {
    electronMocks.trashItem.mockResolvedValue(undefined)
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/trash-item',
      { path: '/Users/x/paper.pdf' },
      TOKEN
    )
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, data: { trashed: true } })
    expect(electronMocks.trashItem).toHaveBeenCalledWith('/Users/x/paper.pdf')
  })

  it('returns a failure envelope when trashItem throws', async () => {
    electronMocks.trashItem.mockRejectedValue(new Error('nope'))
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/trash-item',
      { path: '/bad' },
      TOKEN
    )
    expect(status).toBe(400)
    expect(body).toEqual({ ok: false, error: { code: 'trash_failed', message: 'nope' } })
  })

  it('opens a path via shell.openPath', async () => {
    electronMocks.openPath.mockResolvedValue('')
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/open-path',
      { path: '/Users/x/notes.md' },
      TOKEN
    )
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, data: { opened: true } })
    expect(electronMocks.openPath).toHaveBeenCalledWith('/Users/x/notes.md')
  })

  it('returns open_failed when shell.openPath reports an error message', async () => {
    electronMocks.openPath.mockResolvedValue('app not found')
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/open-path',
      { path: '/x' },
      TOKEN
    )
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false, error: { code: 'open_failed' } })
  })

  it('reveals an item in folder via shell.showItemInFolder', async () => {
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/show-in-folder',
      { path: '/Users/x/paper.pdf' },
      TOKEN
    )
    expect(status).toBe(200)
    expect(electronMocks.showItemInFolder).toHaveBeenCalledWith('/Users/x/paper.pdf')
    expect(body).toEqual({ ok: true, data: { revealed: true } })
  })

  it('opens a directory dialog and returns the selected path', async () => {
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/x/papers']
    })
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/dialog-open-directory',
      { title: 'Pick folder' },
      TOKEN
    )
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, data: { canceled: false, path: '/Users/x/papers' } })
  })

  it('returns canceled when the dialog is dismissed', async () => {
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/dialog-open-directory',
      {},
      TOKEN
    )
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, data: { canceled: true, path: null } })
  })

  it('opens a filtered file dialog', async () => {
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/x/library.json']
    })
    const { server } = await setup()
    const { body } = await dispatch(
      server,
      'POST',
      '/native/dialog-open-file',
      { title: 'Import JSON', extensions: ['json'] },
      TOKEN
    )
    expect(body).toEqual({
      ok: true,
      data: { canceled: false, path: '/Users/x/library.json' }
    })
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
    )
  })

  it('opens a multi-file dialog and returns every selected path', async () => {
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/x/one.pdf', '/Users/x/two.pdf']
    })
    const { server } = await setup()
    const { body } = await dispatch(
      server,
      'POST',
      '/native/dialog-open-file',
      { title: 'Add PDF Files', extensions: ['pdf'], multiple: true },
      TOKEN
    )

    expect(body).toEqual({
      ok: true,
      data: {
        canceled: false,
        path: '/Users/x/one.pdf',
        paths: ['/Users/x/one.pdf', '/Users/x/two.pdf']
      }
    })
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        properties: ['openFile', 'multiSelections']
      })
    )
  })

  it('returns a native dialog choice', async () => {
    electronMocks.showMessageBox.mockResolvedValue({ response: 1 })
    const { server } = await setup()
    const { body } = await dispatch(
      server,
      'POST',
      '/native/dialog-choose',
      {
        title: 'Import Mode',
        message: 'Choose a mode',
        buttons: ['Merge', 'Replace', 'Cancel'],
        defaultId: 0,
        cancelId: 2
      },
      TOKEN
    )
    expect(body).toEqual({ ok: true, data: { response: 1 } })
  })

  it('writes text to the clipboard', async () => {
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/clipboard-write',
      { text: 'hello world' },
      TOKEN
    )
    expect(status).toBe(200)
    expect(electronMocks.writeText).toHaveBeenCalledWith('hello world')
    expect(body).toEqual({ ok: true, data: { written: true } })
  })

  it('writes a validated file to the clipboard adapter', async () => {
    const copyFileToClipboard = vi.fn()
    const { server } = await setup({ copyFileToClipboard })
    const { body } = await dispatch(
      server,
      'POST',
      '/native/clipboard-write-file',
      { path: '/Users/x/paper.pdf' },
      TOKEN
    )
    expect(copyFileToClipboard).toHaveBeenCalledWith('/Users/x/paper.pdf')
    expect(body).toEqual({ ok: true, data: { written: true } })
  })

  it('encrypts an API key and returns base64 ciphertext', async () => {
    const safeStorage = makeSafeStorage()
    safeStorage.encrypt.mockReturnValue(Buffer.from('encrypted-key'))
    const { server } = await setup({ safeStorage })
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/encrypt-api-key',
      { apiKey: 'sk-secret' },
      TOKEN
    )
    expect(status).toBe(200)
    expect(safeStorage.encrypt).toHaveBeenCalledWith('sk-secret')
    expect(body).toEqual({
      ok: true,
      data: { apiKeyEnc: Buffer.from('encrypted-key').toString('base64') }
    })
  })

  it('decrypts an API key from base64 ciphertext', async () => {
    const encrypted = Buffer.from('encrypted-search-key')
    const safeStorage = makeSafeStorage({ decrypt: vi.fn(() => 'search-secret') })
    const { server } = await setup({ safeStorage })
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/decrypt-api-key',
      { apiKeyEnc: encrypted.toString('base64') },
      TOKEN
    )
    expect(status).toBe(200)
    expect(safeStorage.decrypt).toHaveBeenCalledWith(encrypted, false)
    expect(body).toEqual({ ok: true, data: { apiKey: 'search-secret' } })
  })

  it('rejects invalid base64 ciphertext', async () => {
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/decrypt-api-key',
      { apiKeyEnc: 'not base64!' },
      TOKEN
    )
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('validates required path argument on trash-item', async () => {
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/trash-item',
      {},
      TOKEN
    )
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('returns 400 for invalid JSON body', async () => {
    const { server } = await setup()
    const { req, res, responsePromise } = mockRequest(
      'POST',
      '/native/trash-item',
      null,
      TOKEN
    )
    ;(server as unknown as { _dispatch: (req: IncomingMessage, res: ServerResponse) => void })._dispatch(req, res)
    queueMicrotask(() => {
      req.emit('data', Buffer.from('not-json{'))
      req.emit('end')
    })
    const { status, body } = await responsePromise
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false, error: { code: 'invalid_json' } })
  })

  it('returns 404 for unknown routes', async () => {
    const { server } = await setup()
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/unknown',
      {},
      TOKEN
    )
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('applies proxy rules via the injected setProxy callback', async () => {
    const setProxy = vi.fn().mockResolvedValue(undefined)
    const { server } = await setup({ setProxy })
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/apply-proxy',
      { proxyRules: 'http://proxy.example:8080' },
      TOKEN
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, data: { applied: true } })
    expect(setProxy).toHaveBeenCalledWith('http://proxy.example:8080')
  })

  it('returns proxy_failed when setProxy throws', async () => {
    const setProxy = vi.fn().mockRejectedValue(new Error('boom'))
    const { server } = await setup({ setProxy })
    const { status, body } = await dispatch(
      server,
      'POST',
      '/native/apply-proxy',
      { proxyRules: 'http://proxy.example:8080' },
      TOKEN
    )
    expect(status).toBe(400)
    expect(body).toMatchObject({ ok: false, error: { code: 'proxy_failed' } })
  })

  it('stops the http server', async () => {
    const { rpc, server } = await setup()
    await rpc.stop()
    expect(server.close).toHaveBeenCalled()
  })
})
