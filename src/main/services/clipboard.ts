import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
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

function markdownFileName(title: string): string {
  const normalizedTitle = Array.from(title, (character) => (
    character.charCodeAt(0) < 32 ? '-' : character
  )).join('')
  const safeTitle = normalizedTitle
    .replace(/\.md$/i, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
  return `${safeTitle || 'card'}.md`
}

export function writeFileToClipboard(rawPath: string): void {
  const filePath = requireRegularFile(rawPath)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><string>${escapeXml(filePath)}</string></array></plist>`
  clipboard.writeBuffer(CLIPBOARD_FILE_FORMAT, Buffer.from(plist, 'utf8'))
}

export function writeMarkdownFileToClipboard(title: string, content: string): string {
  if (typeof title !== 'string' || typeof content !== 'string') {
    throw new MainProcessError('invalid_clipboard_content', 'Markdown clipboard content must be text')
  }
  const directory = join(tmpdir(), 'refora-clipboard', randomUUID())
  mkdirSync(directory, { recursive: true })
  const filePath = join(directory, markdownFileName(title))
  writeFileSync(filePath, content, 'utf8')
  writeFileToClipboard(filePath)
  return filePath
}

export function writeTextToClipboard(text: string): void {
  if (typeof text !== 'string') {
    throw new MainProcessError('invalid_clipboard_content', 'Clipboard content must be text')
  }
  clipboard.writeText(text)
}
