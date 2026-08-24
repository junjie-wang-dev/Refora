import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

export type ExistingPathKind = 'file' | 'directory' | 'item'
export type ExistingPathFailure =
  | 'not_absolute'
  | 'missing'
  | 'symbolic_link'
  | 'wrong_kind'
  | 'inspect_failed'

export class ExistingPathError extends Error {
  constructor(
    readonly failure: ExistingPathFailure,
    readonly resolvedPath: string
  ) {
    super(failure)
  }
}

export function resolveExistingPath(rawPath: string, kind: ExistingPathKind): string {
  if (typeof rawPath !== 'string' || !rawPath || !isAbsolute(rawPath)) {
    throw new ExistingPathError('not_absolute', rawPath)
  }
  const resolvedPath = resolvePath(rawPath)
  try {
    if (lstatSync(resolvedPath).isSymbolicLink()) {
      throw new ExistingPathError('symbolic_link', resolvedPath)
    }
    const realPath = realpathSync(resolvedPath)
    const stats = lstatSync(realPath)
    const matches = kind === 'file'
      ? stats.isFile()
      : kind === 'directory'
        ? stats.isDirectory()
        : stats.isFile() || stats.isDirectory()
    if (!matches) throw new ExistingPathError('wrong_kind', realPath)
    return realPath
  } catch (error) {
    if (error instanceof ExistingPathError) throw error
    const code = error && typeof error === 'object'
      ? (error as NodeJS.ErrnoException).code
      : undefined
    throw new ExistingPathError(
      code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inspect_failed',
      resolvedPath
    )
  }
}
