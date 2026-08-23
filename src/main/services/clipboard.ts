import { existsSync, lstatSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { clipboard } from 'electron'
import { MainProcessError } from './errors'

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
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new MainProcessError('invalid_path', 'Clipboard file path must be absolute')
  }
  const filePath = resolvePath(rawPath)
  if (!existsSync(filePath)) throw new MainProcessError('file_missing', `Clipboard file not found: ${filePath}`)
  try {
    if (lstatSync(filePath).isSymbolicLink() || !statSync(filePath).isFile()) {
      throw new MainProcessError('invalid_path', 'Clipboard target must be a regular file')
    }
  } catch (error) {
    if (error instanceof MainProcessError) throw error
    throw new MainProcessError('invalid_path', `Unable to inspect clipboard file: ${filePath}`)
  }
  return filePath
}

export function writeFileToClipboard(rawPath: string): void {
  const filePath = requireRegularFile(rawPath)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><string>${escapeXml(filePath)}</string></array></plist>`
  clipboard.writeBuffer(CLIPBOARD_FILE_FORMAT, Buffer.from(plist, 'utf8'))
}
