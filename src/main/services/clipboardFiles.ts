import { clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveExistingPath } from './existingPath'
import { resultify } from '../sidecar/ipc/result'
import { IpcChannel } from '../../shared/ipc-channels'

function decodeFileList(buffer: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
      timeout: 3000,
      maxBuffer: 1024 * 1024
    }, (error, stdout) => {
      if (error) return reject(new Error('Could not read clipboard files'))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('Invalid clipboard file list'))
      }
    })
    child.stdin?.on('error', reject)
    child.stdin?.end(buffer)
  })
}

export async function readClipboardFiles(): Promise<string[]> {
  const buffer = clipboard.readBuffer('NSFilenamesPboardType')
  let values: unknown
  if (buffer.length > 0) {
    if (buffer.length > 1024 * 1024) throw new Error('Clipboard file list is too large')
    values = await decodeFileList(buffer)
  } else {
    const url = clipboard.read('public.file-url')
    values = url ? [fileURLToPath(url)] : []
  }
  if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) {
    throw new Error('Invalid clipboard file list')
  }
  return [...new Set(values.map((path) => resolveExistingPath(path, 'file')))]
}

export function createClipboardFileHandlers(authorizeFile: (path: string) => string) {
  return {
    [IpcChannel.ClipboardReadFiles]: () => resultify(async () => {
      const paths = await readClipboardFiles()
      return paths.map((path) => authorizeFile(path))
    })
  }
}
