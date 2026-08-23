import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync, lstatSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { MainProcessError } from './errors'

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const CACHE_FILE_PATTERN = /^[a-f0-9]{64}\.png$/
export const MAX_PDF_PREVIEW_CACHE_BYTES = 8 * 1024 * 1024

function hashSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requireManagedDirectory(libraryFolder: string, documentId: string): string {
  if (!libraryFolder || !isAbsolute(libraryFolder)) {
    throw new MainProcessError('invalid_library', 'Library folder must be an absolute path')
  }
  let current = resolve(libraryFolder)
  for (const segment of ['.refora', 'derived', 'pdf-previews', hashSegment(documentId)]) {
    current = join(current, segment)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new MainProcessError('invalid_path', 'PDF preview cache directories cannot be symbolic links')
    }
  }
  return current
}

export function pdfPreviewCachePath(
  libraryFolder: string,
  documentId: string,
  sourceIdentity: string
): string {
  return join(
    requireManagedDirectory(libraryFolder, documentId),
    `${hashSegment(sourceIdentity)}.png`
  )
}

export async function readPdfPreviewCache(filePath: string): Promise<Uint8Array | null> {
  if (!existsSync(filePath)) return null
  const entry = lstatSync(filePath)
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new MainProcessError('invalid_path', 'PDF preview cache must be a regular file')
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new MainProcessError('invalid_path', 'PDF preview cache must be a regular file')
    }
    if (stats.size > MAX_PDF_PREVIEW_CACHE_BYTES) return null
    const content = new Uint8Array(stats.size)
    let offset = 0
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const value = offset === content.length ? content : content.slice(0, offset)
    if (!PNG_SIGNATURE.every((byte, index) => value[index] === byte)) return null
    return value
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function prunePdfPreviewCacheVersions(filePath: string): Promise<void> {
  const directory = dirname(filePath)
  const retainedName = basename(filePath)
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  await Promise.allSettled(entries
    .filter((entry) => (
      entry.isFile() &&
      entry.name !== retainedName &&
      CACHE_FILE_PATTERN.test(entry.name)
    ))
    .map((entry) => rm(join(directory, entry.name), { force: true })))
}

export async function removePdfPreviewCacheForDocument(
  libraryFolder: string,
  documentId: string
): Promise<void> {
  await rm(requireManagedDirectory(libraryFolder, documentId), { recursive: true, force: true })
}

export async function writePdfPreviewCache(
  filePath: string,
  content: Uint8Array
): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, filePath)
    await prunePdfPreviewCacheVersions(filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
