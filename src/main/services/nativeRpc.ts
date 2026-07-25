import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { shell, dialog, clipboard, type BrowserWindow } from 'electron'
import type { Repositories } from '../db/repositories'
import type { Result } from '../../shared/ipc-types'
import { createSafeStorageProxy, type SafeStorageProxy } from './safeStorageProxy'
import { providerRequiresApiKey } from '../../shared/providerCatalog'
import { logger } from './logger'

const HOST = '127.0.0.1'
const TOKEN_HEADER = 'x-refora-token'

export interface NativeRpcInfo {
  port: number
  baseUrl: string
  token: string
}

export interface NativeRpcDeps {
  repos: Repositories
  token: string
  getWin?: () => BrowserWindow | null
  safeStorage?: SafeStorageProxy
  createHttpServer?: typeof createServer
}

export interface NativeRpc {
  start(): Promise<NativeRpcInfo>
  stop(): Promise<void>
}

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

function fail(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
      if (data.length > 1_000_000) {
        reject(new Error('Request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function parseJson<T>(raw: string): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

interface TrashItemBody {
  path?: unknown
}
interface OpenPathBody {
  path?: unknown
}
interface ShowInFolderBody {
  path?: unknown
}
interface ClipboardWriteBody {
  text?: unknown
}
interface GetApiKeyBody {
  providerId?: unknown
}
interface DialogOpenDirectoryBody {
  title?: unknown
}

export function createNativeRpc(deps: NativeRpcDeps): NativeRpc {
  const safeStorage = deps.safeStorage ?? createSafeStorageProxy()
  const createHttpServer = deps.createHttpServer ?? createServer
  let server: Server | null = null
  let info: NativeRpcInfo | null = null

  function verifyToken(req: IncomingMessage): boolean {
    const header = req.headers[TOKEN_HEADER]
    const provided = Array.isArray(header) ? header[0] : header
    if (typeof provided !== 'string' || !provided) return false
    return safeCompare(provided, deps.token)
  }

  async function handleTrashItem(body: TrashItemBody): Promise<Result<{ trashed: boolean }>> {
    const rawPath = asString(body.path)
    if (!rawPath) return fail('invalid_input', 'path is required')
    try {
      await shell.trashItem(rawPath)
      return ok({ trashed: true })
    } catch (e) {
      return fail('trash_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleOpenPath(body: OpenPathBody): Promise<Result<{ opened: boolean }>> {
    const rawPath = asString(body.path)
    if (!rawPath) return fail('invalid_input', 'path is required')
    try {
      const message = await shell.openPath(rawPath)
      if (message) return fail('open_failed', message)
      return ok({ opened: true })
    } catch (e) {
      return fail('open_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleShowInFolder(
    body: ShowInFolderBody
  ): Promise<Result<{ revealed: boolean }>> {
    const rawPath = asString(body.path)
    if (!rawPath) return fail('invalid_input', 'path is required')
    try {
      shell.showItemInFolder(rawPath)
      return ok({ revealed: true })
    } catch (e) {
      return fail('reveal_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDialogOpenDirectory(
    body: DialogOpenDirectoryBody
  ): Promise<Result<{ canceled: boolean; path: string | null }>> {
    const win = deps.getWin?.() ?? null
    const title = asString(body.title) ?? 'Select Directory'
    try {
      const result = await dialog.showOpenDialog(win as BrowserWindow, {
        title,
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return ok({ canceled: true, path: null })
      }
      return ok({ canceled: false, path: result.filePaths[0] })
    } catch (e) {
      return fail('dialog_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleClipboardWrite(
    body: ClipboardWriteBody
  ): Promise<Result<{ written: boolean }>> {
    const text = asString(body.text)
    if (text === null) return fail('invalid_input', 'text is required')
    try {
      clipboard.writeText(text)
      return ok({ written: true })
    } catch (e) {
      return fail('clipboard_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleGetApiKey(
    body: GetApiKeyBody
  ): Promise<Result<{ apiKey: string }>> {
    const providerId = asString(body.providerId)
    if (!providerId) return fail('invalid_input', 'providerId is required')
    try {
      const raw = deps.repos.aiProviders.getRaw(providerId)
      if (!raw) return fail('not_found', `provider not found: ${providerId}`)
      const allowEmpty = !providerRequiresApiKey(raw.presetId)
      const apiKey = safeStorage.decrypt(raw.apiKeyEnc, allowEmpty)
      return ok({ apiKey })
    } catch (e) {
      return fail('decryption_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function route(
    path: string,
    body: unknown
  ): Promise<Result<unknown>> {
    switch (path) {
      case '/native/trash-item':
        return handleTrashItem(body as TrashItemBody)
      case '/native/open-path':
        return handleOpenPath(body as OpenPathBody)
      case '/native/show-in-folder':
        return handleShowInFolder(body as ShowInFolderBody)
      case '/native/dialog-open-directory':
        return handleDialogOpenDirectory(body as DialogOpenDirectoryBody)
      case '/native/clipboard-write':
        return handleClipboardWrite(body as ClipboardWriteBody)
      case '/native/get-api-key':
        return handleGetApiKey(body as GetApiKeyBody)
      default:
        return fail('not_found', `Unknown route: ${path}`)
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      send(res, 405, fail('method_not_allowed', 'Only POST is supported'))
      return
    }
    if (!verifyToken(req)) {
      send(res, 401, fail('unauthorized', 'Invalid or missing token'))
      return
    }
    const url = new URL(req.url ?? '', `http://${HOST}`)
    const path = url.pathname
    let body: unknown
    try {
      const raw = await readBody(req)
      body = parseJson(raw)
      if (raw && body === null) {
        send(res, 400, fail('invalid_json', 'Request body must be valid JSON'))
        return
      }
    } catch (e) {
      send(res, 400, fail('invalid_body', e instanceof Error ? e.message : String(e)))
      return
    }
    try {
      const result = await route(path, body)
      send(res, result.ok ? 200 : 400, result)
    } catch (e) {
      logger.warn(
        `nativeRpc:route-error ${path}: ${e instanceof Error ? e.message : String(e)}`
      )
      send(res, 500, fail('internal_error', 'Internal error'))
    }
  }

  function start(): Promise<NativeRpcInfo> {
    if (info) return Promise.resolve(info)
    return new Promise<NativeRpcInfo>((resolve, reject) => {
      const httpServer = createHttpServer((req, res) => {
        void handleRequest(req, res)
      })
      httpServer.on('error', (error) => {
        logger.error(`nativeRpc:server-error ${error.message}`)
        reject(error)
      })
      httpServer.listen(0, HOST, () => {
        const address = httpServer.address()
        const port = typeof address === 'object' && address ? address.port : 0
        if (!port) {
          reject(new Error('Failed to bind native RPC server'))
          return
        }
        server = httpServer
        info = { port, baseUrl: `http://${HOST}:${port}`, token: deps.token }
        resolve(info)
      })
    })
  }

  function stop(): Promise<void> {
    const current = server
    server = null
    info = null
    if (!current) return Promise.resolve()
    return new Promise<void>((resolve) => {
      current.close(() => resolve())
    })
  }

  return { start, stop }
}

export type NativeRpcService = ReturnType<typeof createNativeRpc>
