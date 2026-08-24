import { clipboard } from 'electron'
import { MainProcessError } from './errors'
import { ExistingPathError, resolveExistingPath } from './existingPath'

const CLIPBOARD_FILE_FORMAT = 'NSFilenamesPboardType'

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function requireRegularFile(rawPath: string): string {
  try {
    return resolveExistingPath(rawPath, 'file')
  } catch (error) {
    if (!(error instanceof ExistingPathError)) throw error
    if (error.failure === 'not_absolute') {
      throw new MainProcessError('invalid_path', 'Clipboard file path must be absolute')
    }
    if (error.failure === 'missing') {
      throw new MainProcessError('file_missing', `Clipboard file not found: ${error.resolvedPath}`)
    }
    if (error.failure === 'symbolic_link' || error.failure === 'wrong_kind') {
      throw new MainProcessError('invalid_path', 'Clipboard target must be a regular file')
    }
    throw new MainProcessError('invalid_path', `Unable to inspect clipboard file: ${error.resolvedPath}`)
  }
}

export function writeFileToClipboard(rawPath: string): void {
  const filePath = requireRegularFile(rawPath)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><string>${escapeXml(filePath)}</string></array></plist>`
  clipboard.writeBuffer(CLIPBOARD_FILE_FORMAT, Buffer.from(plist, 'utf8'))
}
