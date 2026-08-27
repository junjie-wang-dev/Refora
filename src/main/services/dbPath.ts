import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const DB_FILE_NAME = 'working.db'
export const LEGACY_DB_FILE_NAME = 'refora.db'
export const SNAPSHOT_DIRECTORY_NAME = 'snapshots'
export const REFORA_CLOUD_DIRECTORY_NAME = '.refora'

export function libraryStorageKey(libraryFolder: string): string {
  return createHash('sha256').update(libraryFolder).digest('hex').slice(0, 32)
}

export function dbPathForLibraryFolder(userDataDir: string, libraryFolder: string): string {
  if (!libraryFolder) return join(userDataDir, DB_FILE_NAME)
  return join(userDataDir, 'libraries', libraryStorageKey(libraryFolder), DB_FILE_NAME)
}

export function legacyDbPathForLibraryFolder(
  userDataDir: string,
  libraryFolder: string
): string {
  return libraryFolder
    ? join(libraryFolder, LEGACY_DB_FILE_NAME)
    : join(userDataDir, LEGACY_DB_FILE_NAME)
}

export function snapshotDirectoryForLibraryFolder(libraryFolder: string): string {
  return join(libraryFolder, REFORA_CLOUD_DIRECTORY_NAME, SNAPSHOT_DIRECTORY_NAME)
}

function snapshotManifestExists(libraryFolder: string): boolean {
  if (!libraryFolder) return false
  try {
    return readdirSync(snapshotDirectoryForLibraryFolder(libraryFolder), {
      withFileTypes: true
    }).some((entry) => entry.isFile() && entry.name.endsWith('.json'))
  } catch {
    return false
  }
}

export function dbExistsInLibraryFolder(userDataDir: string, libraryFolder: string): boolean {
  return existsSync(dbPathForLibraryFolder(userDataDir, libraryFolder))
    || existsSync(legacyDbPathForLibraryFolder(userDataDir, libraryFolder))
    || snapshotManifestExists(libraryFolder)
}
