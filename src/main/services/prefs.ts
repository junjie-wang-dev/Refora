import { join, dirname } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { logger } from './logger'

interface UserPrefs {
  [key: string]: unknown
  libraryFolderPath?: string
  pendingAuthConfirmation?: {
    nonce: string
    createdAt: number
    flow?: 'email_confirmation' | 'oauth'
    provider?: 'google' | 'apple'
    codeVerifier?: string
  } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePrefs(value: unknown): UserPrefs {
  if (!isRecord(value)) return {}
  const prefs: UserPrefs = { ...value }
  if (typeof prefs.libraryFolderPath !== 'string') delete prefs.libraryFolderPath
  const pending = prefs.pendingAuthConfirmation
  if (pending !== null && pending !== undefined) {
    if (
      !isRecord(pending)
      || typeof pending.nonce !== 'string'
      || !pending.nonce
      || typeof pending.createdAt !== 'number'
      || !Number.isFinite(pending.createdAt)
      || (pending.flow !== undefined && pending.flow !== 'email_confirmation' && pending.flow !== 'oauth')
      || (pending.provider !== undefined && pending.provider !== 'google' && pending.provider !== 'apple')
      || (pending.codeVerifier !== undefined && typeof pending.codeVerifier !== 'string')
    ) {
      delete prefs.pendingAuthConfirmation
    }
  }
  return prefs
}

function prefsPath(userDataDir: string): string {
  return join(userDataDir, 'refora-prefs.json')
}

function readPrefs(userDataDir: string): UserPrefs {
  try {
    const p = prefsPath(userDataDir)
    if (!existsSync(p)) return {}
    const raw = readFileSync(p, 'utf-8')
    return normalizePrefs(JSON.parse(raw))
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
    throw e
  }
}

export function readLibraryFolderPath(userDataDir: string): string {
  return readPrefs(userDataDir).libraryFolderPath ?? ''
}

export function writeLibraryFolderPath(userDataDir: string, folder: string): void {
  updatePrefs(userDataDir, { libraryFolderPath: folder })
}

export function readPendingAuthConfirmation(userDataDir: string): {
  nonce: string
  createdAt: number
  flow?: 'email_confirmation' | 'oauth'
  provider?: 'google' | 'apple'
  codeVerifier?: string
} | null {
  const pending = readPrefs(userDataDir).pendingAuthConfirmation
  if (
    !pending
    || typeof pending.nonce !== 'string'
    || !pending.nonce
    || typeof pending.createdAt !== 'number'
    || !Number.isFinite(pending.createdAt)
    || (pending.flow !== undefined && pending.flow !== 'email_confirmation' && pending.flow !== 'oauth')
    || (pending.provider !== undefined && pending.provider !== 'google' && pending.provider !== 'apple')
    || (pending.codeVerifier !== undefined && typeof pending.codeVerifier !== 'string')
  ) return null
  return pending
}

export function writePendingAuthConfirmation(
  userDataDir: string,
  pending: {
    nonce: string
    createdAt: number
    flow?: 'email_confirmation' | 'oauth'
    provider?: 'google' | 'apple'
    codeVerifier?: string
  } | null
): void {
  updatePrefs(userDataDir, { pendingAuthConfirmation: pending })
}
