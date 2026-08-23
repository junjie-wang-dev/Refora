import { lstatSync, realpathSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

export type RendererPathKind = 'file' | 'directory'

interface Capability {
  expiresAt: number
  kind: RendererPathKind
  timeout: ReturnType<typeof setTimeout>
}

export interface RendererPathCapabilities {
  authorizeFile(path: string): string
  authorizeDirectory(path: string): string
  consumeFile(path: string, extensions?: readonly string[]): string
  consumeFiles(paths: readonly string[], extensions?: readonly string[]): string[]
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

  function deleteCapability(path: string): void {
    const capability = capabilities.get(path)
    if (!capability) return
    clearTimeout(capability.timeout)
    capabilities.delete(path)
  }

  function authorize(path: string, kind: RendererPathKind): string {
    const resolved = resolveExisting(path, kind)
    deleteCapability(resolved)
    const capability: Capability = {
      kind,
      expiresAt: now() + ttlMs,
      timeout: setTimeout(() => {
        if (capabilities.get(resolved) === capability) capabilities.delete(resolved)
      }, Math.max(0, ttlMs))
    }
    capabilities.set(resolved, capability)
    return resolved
  }

  function validate(path: string, kind: RendererPathKind, extensions?: readonly string[]): string {
    const resolved = resolveExisting(path, kind)
    const capability = capabilities.get(resolved)
    if (!capability || capability.kind !== kind || capability.expiresAt < now()) {
      if (capability?.expiresAt !== undefined && capability.expiresAt < now()) {
        deleteCapability(resolved)
      }
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

  function consume(path: string, kind: RendererPathKind, extensions?: readonly string[]): string {
    const resolved = validate(path, kind, extensions)
    deleteCapability(resolved)
    return resolved
  }

  function consumeFiles(paths: readonly string[], extensions?: readonly string[]): string[] {
    const resolvedPaths = paths.map((path) => validate(path, 'file', extensions))
    if (new Set(resolvedPaths).size !== resolvedPaths.length) {
      throw pathError('path_not_authorized', 'A path authorization cannot be reused')
    }
    for (const resolved of resolvedPaths) deleteCapability(resolved)
    return resolvedPaths
  }

  return {
    authorizeFile: (path) => authorize(path, 'file'),
    authorizeDirectory: (path) => authorize(path, 'directory'),
    consumeFile: (path, extensions) => consume(path, 'file', extensions),
    consumeFiles,
    consumeDirectory: (path) => consume(path, 'directory'),
    clear: () => {
      for (const path of capabilities.keys()) deleteCapability(path)
    }
  }
}
