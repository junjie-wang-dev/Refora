import { existsSync, lstatSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { MainProcessError } from './errors'

export function resolvePdfFilePath(rawPath: string): string {
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new MainProcessError('invalid_path', 'PDF path must be absolute')
  }
  const resolved = resolvePath(rawPath)
  if (!resolved.toLowerCase().endsWith('.pdf')) {
    throw new MainProcessError('invalid_path', 'Selected file must be a PDF')
  }
  if (!existsSync(resolved)) {
    throw new MainProcessError('file_missing', `File not found: ${resolved}`)
  }
  try {
    if (lstatSync(resolved).isSymbolicLink() || !statSync(resolved).isFile()) {
      throw new MainProcessError('invalid_path', 'Selected path must be a regular PDF file')
    }
  } catch (error) {
    if (error instanceof MainProcessError) throw error
    throw new MainProcessError('invalid_path', `Unable to inspect PDF file: ${resolved}`)
  }
  return resolved
}
