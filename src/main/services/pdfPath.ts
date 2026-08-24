import { isAbsolute, resolve as resolvePath } from 'node:path'
import { MainProcessError } from './errors'
import { ExistingPathError, resolveExistingPath } from './existingPath'

export function resolvePdfFilePath(rawPath: string): string {
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new MainProcessError('invalid_path', 'PDF path must be absolute')
  }
  const resolved = resolvePath(rawPath)
  if (!resolved.toLowerCase().endsWith('.pdf')) {
    throw new MainProcessError('invalid_path', 'Selected file must be a PDF')
  }
  try {
    return resolveExistingPath(resolved, 'file')
  } catch (error) {
    if (error instanceof ExistingPathError && error.failure === 'missing') {
      throw new MainProcessError('file_missing', `File not found: ${resolved}`)
    }
    if (
      error instanceof ExistingPathError &&
      (error.failure === 'symbolic_link' || error.failure === 'wrong_kind')
    ) {
      throw new MainProcessError('invalid_path', 'Selected path must be a regular PDF file')
    }
    throw new MainProcessError('invalid_path', `Unable to inspect PDF file: ${resolved}`)
  }
}
