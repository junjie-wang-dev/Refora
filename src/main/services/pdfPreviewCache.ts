import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { MainProcessError } from './errors'

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

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
  const content = new Uint8Array(await readFile(filePath))
  if (!PNG_SIGNATURE.every((byte, index) => content[index] === byte)) return null
  return content
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
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
