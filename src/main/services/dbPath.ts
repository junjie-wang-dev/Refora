import { join } from 'node:path'
import { existsSync } from 'node:fs'

export const DB_FILE_NAME = 'refora.db'

export function dbPathForLibraryFolder(libraryFolder: string): string {
  return join(libraryFolder, DB_FILE_NAME)
}

export function dbExistsInLibraryFolder(libraryFolder: string): boolean {
  return existsSync(dbPathForLibraryFolder(libraryFolder))
}
