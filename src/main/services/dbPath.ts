import { join } from 'node:path'
import { existsSync } from 'node:fs'

export const DB_FILE_NAME = 'refora.db'
export const DB_WAL_SUFFIX = '-wal'
export const DB_SHM_SUFFIX = '-shm'

export function dbPathForLibraryFolder(libraryFolder: string): string {
  return join(libraryFolder, DB_FILE_NAME)
}

export function dbExistsInLibraryFolder(libraryFolder: string): boolean {
  return existsSync(dbPathForLibraryFolder(libraryFolder))
}

export function dbRelatedFiles(dbPath: string): string[] {
  const files = [dbPath, dbPath + DB_WAL_SUFFIX, dbPath + DB_SHM_SUFFIX]
  return files.filter((p) => existsSync(p))
}
