import { join, dirname } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'

interface UserPrefs {
  libraryFolderPath?: string
}

function prefsPath(userDataDir: string): string {
  return join(userDataDir, 'refora-prefs.json')
}

function readPrefs(userDataDir: string): UserPrefs {
  try {
    const p = prefsPath(userDataDir)
    if (!existsSync(p)) return {}
    const raw = readFileSync(p, 'utf-8')
    return JSON.parse(raw) as UserPrefs
  } catch (e) {
    logger.warn(`prefs:read failed: ${e instanceof Error ? e.message : String(e)}`)
    return {}
  }
}

function updatePrefs(userDataDir: string, patch: Partial<UserPrefs>): void {
  try {
    const p = prefsPath(userDataDir)
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const temporary = `${p}.tmp-${randomUUID()}`
    writeFileSync(temporary, JSON.stringify({ ...readPrefs(userDataDir), ...patch }, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
    renameSync(temporary, p)
  } catch (e) {
    logger.warn(`prefs:write failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function readLibraryFolderPath(userDataDir: string): string {
  return readPrefs(userDataDir).libraryFolderPath ?? ''
}

export function writeLibraryFolderPath(userDataDir: string, folder: string): void {
  updatePrefs(userDataDir, { libraryFolderPath: folder })
}
