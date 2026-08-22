import { lstatSync, realpathSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

export type RendererPathKind = 'file' | 'directory'

interface Capability {
  expiresAt: number
  kind: RendererPathKind
}

export interface RendererPathCapabilities {
  authorizeFile(path: string): string
  authorizeDirectory(path: string): string
  consumeFile(path: string, extensions?: readonly string[]): string
  consumeDirectory(path: string): string
  clear(): void
}

function pathError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function resolveExisting(path: string, kind: RendererPathKind): string {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw pathError('invalid_path', 'Path must be absolute')
  }
  const requested = lstatSync(path)
  if (requested.isSymbolicLink()) {
    throw pathError('invalid_path', 'Symbolic links are not allowed')
  }
  const resolved = realpathSync(path)
  const stats = lstatSync(resolved)
  if (kind === 'file' && !stats.isFile()) {
    throw pathError('invalid_path', 'Path must reference a regular file')
  }
  if (kind === 'directory' && !stats.isDirectory()) {
    throw pathError('invalid_path', 'Path must reference a directory')
  }
  return resolved
}

export function createRendererPathCapabilities(
  ttlMs = 5 * 60_000,
  now: () => number = Date.now
): RendererPathCapabilities {
  const capabilities = new Map<string, Capability>()

  function authorize(path: string, kind: RendererPathKind): string {
    const resolved = resolveExisting(path, kind)
    capabilities.set(resolved, { kind, expiresAt: now() + ttlMs })
    return resolved
  }

  function consume(path: string, kind: RendererPathKind, extensions?: readonly string[]): string {
    const resolved = resolveExisting(path, kind)
    const capability = capabilities.get(resolved)
    capabilities.delete(resolved)
    if (!capability || capability.kind !== kind || capability.expiresAt < now()) {
      throw pathError('path_not_authorized', 'Path was not selected by the user')
    }
    if (
      kind === 'file' &&
      extensions &&
      !extensions.map((value) => value.toLowerCase()).includes(extname(resolved).toLowerCase())
    ) {
      throw pathError('invalid_path', `File must use one of these extensions: ${extensions.join(', ')}`)
    }
    return resolved
  }

  return {
    authorizeFile: (path) => authorize(path, 'file'),
    authorizeDirectory: (path) => authorize(path, 'directory'),
    consumeFile: (path, extensions) => consume(path, 'file', extensions),
    consumeDirectory: (path) => consume(path, 'directory'),
    clear: () => capabilities.clear()
  }
}
