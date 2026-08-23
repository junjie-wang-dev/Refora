import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import { shell, dialog, clipboard, session as electronSession, type BrowserWindow } from 'electron'
import type { Result } from '../../shared/ipc-types'
import { createSafeStorageProxy, type SafeStorageProxy } from '../services/safeStorageProxy'
import { logger } from '../services/logger'
import { writeFileToClipboard } from '../services/clipboard'

export interface NativeRpcDeps {
  getWin?: () => BrowserWindow | null
  safeStorage?: SafeStorageProxy
  copyFileToClipboard?: (path: string) => void
  setProxy?: (proxyRules: string) => Promise<void>
  managedRoots?: string[]
  temporaryRoot?: string
  validatePath?: (path: string, kind: NativePathKind, capability: NativePathCapability) => string
}

export type NativePathKind = 'file' | 'item'
export type NativePathCapability =
  | 'managed-directory-or-pdf'
  | 'managed-or-pdf'
  | 'managed-or-temporary-clipboard'

export interface NativePathPolicy {
  managedRoots?: string[]
  temporaryRoot?: string
  capability?: NativePathCapability
}

export interface NativeRpc {
  invoke(route: string, body: unknown, signal?: AbortSignal): Promise<Result<unknown>>
  addManagedRoot(path: string): boolean
}

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

function fail(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeRoot(path: string): string | null {
  try {
    if (!isAbsolute(path)) return null
    const resolved = resolvePath(path)
    const real = realpathSync(resolved)
    return lstatSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function isWithinRoot(path: string, root: string): boolean {
  const value = relative(root, path)
  return value !== '' && !value.startsWith('..') && !isAbsolute(value)
}

export function validateNativePath(
  path: string,
  kind: NativePathKind,
  policy?: NativePathPolicy
): string {
  if (!isAbsolute(path)) throw new Error('path must be absolute')
  const resolvedPath = resolvePath(path)
  const requestedStats = lstatSync(resolvedPath)
  if (requestedStats.isSymbolicLink()) throw new Error('symbolic links are not allowed')
  const realPath = realpathSync(resolvedPath)
  const stats = lstatSync(realPath)
  if (kind === 'file' && !stats.isFile()) throw new Error('path must reference a file')
  if (kind === 'item' && !stats.isFile() && !stats.isDirectory()) {
    throw new Error('path must reference a file or directory')
  }
  if (!policy?.capability) return realPath
  const managedRoots = (policy.managedRoots ?? [])
    .map(normalizeRoot)
    .filter((root): root is string => root !== null)
  const isManaged = managedRoots.some((root) => isWithinRoot(realPath, root))
  if (
    isManaged &&
    (policy.capability !== 'managed-directory-or-pdf' || stats.isDirectory())
  ) {
    return realPath
  }
  if (
    (policy.capability === 'managed-or-pdf' ||
      policy.capability === 'managed-directory-or-pdf') &&
    stats.isFile() &&
    extname(realPath).toLowerCase() === '.pdf'
  ) {
    return realPath
  }
  if (policy.capability === 'managed-or-temporary-clipboard' && stats.isFile()) {
    const temporaryRoot = normalizeRoot(policy.temporaryRoot ?? tmpdir())
    const parent = dirname(realPath)
    if (
      temporaryRoot &&
      dirname(parent) === temporaryRoot &&
      basename(parent).startsWith('refora-clipboard-') &&
      extname(realPath).toLowerCase() === '.md'
    ) {
      return realPath
    }
  }
  throw new Error('path is outside the allowed native capability')
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
interface ClipboardWriteFileBody {
  path?: unknown
}
interface EncryptApiKeyBody {
  apiKey?: unknown
}
interface DecryptApiKeyBody {
  apiKeyEnc?: unknown
}
interface ApplyProxyBody {
  proxyRules?: unknown
}
interface DialogOpenDirectoryBody {
  title?: unknown
}
interface DialogOpenFileBody {
  title?: unknown
  extensions?: unknown
  multiple?: unknown
}
interface DialogChooseBody {
  title?: unknown
  message?: unknown
  buttons?: unknown
  defaultId?: unknown
  cancelId?: unknown
}

export function createNativeRpc(deps: NativeRpcDeps): NativeRpc {
  const safeStorage = deps.safeStorage ?? createSafeStorageProxy()
  const copyFileToClipboard = deps.copyFileToClipboard ?? writeFileToClipboard
  const managedRoots = new Set(
    (deps.managedRoots ?? [])
      .map(normalizeRoot)
      .filter((root): root is string => root !== null)
  )
  const temporaryRoot = deps.temporaryRoot ?? tmpdir()
  const validatePath =
    deps.validatePath ??
    ((path: string, kind: NativePathKind, capability: NativePathCapability) =>
      validateNativePath(path, kind, {
        managedRoots: [...managedRoots],
        temporaryRoot,
        capability
      }))
  const setProxy =
    deps.setProxy ??
    ((proxyRules: string) => electronSession.defaultSession.setProxy({ proxyRules }))
  async function handleTrashItem(body: TrashItemBody): Promise<Result<{ trashed: boolean }>> {
    const rawPath = asString(body.path)
    if (!rawPath) return fail('invalid_input', 'path is required')
    let path: string
    try {
      path = validatePath(rawPath, 'item', 'managed-directory-or-pdf')
    } catch (e) {
      return fail('invalid_path', e instanceof Error ? e.message : String(e))
    }
    try {
      await shell.trashItem(path)
      return ok({ trashed: true })
    } catch (e) {
      return fail('trash_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleOpenPath(body: OpenPathBody): Promise<Result<{ opened: boolean }>> {
    const rawPath = asString(body.path)
    if (!rawPath) return fail('invalid_input', 'path is required')
    let path: string
    try {
      path = validatePath(rawPath, 'item', 'managed-or-pdf')
    } catch (e) {
      return fail('invalid_path', e instanceof Error ? e.message : String(e))
    }
    try {
      const message = await shell.openPath(path)
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
    let path: string
    try {
      path = validatePath(rawPath, 'item', 'managed-or-pdf')
    } catch (e) {
      return fail('invalid_path', e instanceof Error ? e.message : String(e))
    }
    try {
      shell.showItemInFolder(path)
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
      const selected = normalizeRoot(result.filePaths[0])
      if (!selected) return fail('invalid_path', 'Selected directory is unavailable')
      managedRoots.add(selected)
      return ok({ canceled: false, path: selected })
    } catch (e) {
      return fail('dialog_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDialogOpenFile(
    body: DialogOpenFileBody
  ): Promise<Result<{ canceled: boolean; path: string | null; paths?: string[] }>> {
    const title = asString(body.title) ?? undefined
    const extensions = Array.isArray(body.extensions)
      ? body.extensions.filter((value): value is string => typeof value === 'string' && /^[a-z0-9]+$/i.test(value))
      : []
    const multiple = body.multiple === true
    try {
      const result = await dialog.showOpenDialog((deps.getWin?.() ?? undefined) as BrowserWindow, {
        ...(title ? { title } : {}),
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        ...(extensions.length > 0
          ? { filters: [{ name: extensions.map((value) => value.toUpperCase()).join('/'), extensions }] }
          : {})
      })
      if (result.canceled || result.filePaths.length === 0) {
        return ok(multiple
          ? { canceled: true, path: null, paths: [] }
          : { canceled: true, path: null })
      }
      return ok(multiple
        ? { canceled: false, path: result.filePaths[0], paths: result.filePaths }
        : { canceled: false, path: result.filePaths[0] })
    } catch (e) {
      return fail('dialog_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDialogChoose(
    body: DialogChooseBody
  ): Promise<Result<{ response: number }>> {
    const title = asString(body.title)
    const message = asString(body.message)
    const buttons = Array.isArray(body.buttons)
      ? body.buttons.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
    if (!title || !message || buttons.length === 0) {
      return fail('invalid_input', 'title, message, and buttons are required')
    }
    const defaultId = typeof body.defaultId === 'number' ? body.defaultId : 0
    const cancelId = typeof body.cancelId === 'number' ? body.cancelId : buttons.length - 1
    try {
      const result = await dialog.showMessageBox((deps.getWin?.() ?? undefined) as BrowserWindow, {
        type: 'question',
        title,
        message,
        buttons,
        defaultId,
        cancelId
      })
      return ok({ response: result.response })
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

  async function handleClipboardWriteFile(
    body: ClipboardWriteFileBody
  ): Promise<Result<{ written: boolean }>> {
    const rawPath = asString(body.path)
    if (!rawPath) return fail('invalid_input', 'path is required')
    let path: string
    try {
      path = validatePath(rawPath, 'file', 'managed-or-temporary-clipboard')
    } catch (e) {
      return fail('invalid_path', e instanceof Error ? e.message : String(e))
    }
    try {
      copyFileToClipboard(path)
      return ok({ written: true })
    } catch (e) {
      return fail('clipboard_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleEncryptApiKey(
    body: EncryptApiKeyBody
  ): Promise<Result<{ apiKeyEnc: string | null }>> {
    const apiKey = asString(body.apiKey)
    if (apiKey === null) return fail('invalid_input', 'apiKey is required')
    try {
      const encrypted = safeStorage.encrypt(apiKey)
      return ok({ apiKeyEnc: encrypted?.toString('base64') ?? null })
    } catch (e) {
      return fail('encryption_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleDecryptApiKey(
    body: DecryptApiKeyBody
  ): Promise<Result<{ apiKey: string }>> {
    const apiKeyEnc = asString(body.apiKeyEnc)
    if (!apiKeyEnc) return fail('invalid_input', 'apiKeyEnc is required')
    try {
      const encrypted = Buffer.from(apiKeyEnc, 'base64')
      if (encrypted.length === 0 || encrypted.toString('base64') !== apiKeyEnc) {
        return fail('invalid_input', 'apiKeyEnc must be valid base64')
      }
      return ok({ apiKey: safeStorage.decrypt(encrypted, false) })
    } catch (e) {
      return fail('decryption_failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function handleApplyProxy(body: ApplyProxyBody): Promise<Result<{ applied: boolean }>> {
    const proxyRules = asString(body.proxyRules)
    try {
      await setProxy(proxyRules ?? '')
      return ok({ applied: true })
    } catch (e) {
      logger.warn(`proxy:set failed: ${e instanceof Error ? e.message : String(e)}`)
      return fail('proxy_failed', e instanceof Error ? e.message : String(e))
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
      case '/native/dialog-open-file':
        return handleDialogOpenFile(body as DialogOpenFileBody)
      case '/native/dialog-choose':
        return handleDialogChoose(body as DialogChooseBody)
      case '/native/clipboard-write':
        return handleClipboardWrite(body as ClipboardWriteBody)
      case '/native/clipboard-write-file':
        return handleClipboardWriteFile(body as ClipboardWriteFileBody)
      case '/native/encrypt-api-key':
        return handleEncryptApiKey(body as EncryptApiKeyBody)
      case '/native/decrypt-api-key':
        return handleDecryptApiKey(body as DecryptApiKeyBody)
      case '/native/apply-proxy':
        return handleApplyProxy(body as ApplyProxyBody)
      default:
        return fail('not_found', `Unknown route: ${path}`)
    }
  }

  async function invoke(routePath: string, body: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted) {
      return fail('connector_cancelled', `Native RPC was cancelled: ${routePath}`)
    }
    const operation = route(routePath, body).catch((error) => {
      logger.warn(
        `nativeRpc:route-error ${routePath}: ${error instanceof Error ? error.message : String(error)}`
      )
      return fail('internal_error', 'Internal error')
    })
    if (!signal) return operation
    return new Promise((resolve) => {
      const onAbort = () => {
        resolve(fail('connector_cancelled', `Native RPC was cancelled: ${routePath}`))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void operation.then((result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      })
    })
  }

  function addManagedRoot(path: string): boolean {
    const root = normalizeRoot(path)
    if (!root) return false
    managedRoots.add(root)
    return true
  }

  return { invoke, addManagedRoot }
}

export type NativeRpcService = ReturnType<typeof createNativeRpc>
