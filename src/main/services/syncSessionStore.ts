import { dirname, join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { SafeStorageProxy } from './safeStorageProxy'
import type { SupabaseSession } from './supabaseAuth'
import { logger } from './logger'

export interface SyncSessionStore {
  load(): SupabaseSession | null
  save(session: SupabaseSession): void
  clear(): void
}

function isSession(value: unknown): value is SupabaseSession {
  if (!value || typeof value !== 'object') return false
  const session = value as Record<string, unknown>
  const user = session.user
  return typeof session.accessToken === 'string'
    && session.accessToken.length > 0
    && typeof session.refreshToken === 'string'
    && session.refreshToken.length > 0
    && typeof session.expiresAt === 'number'
    && Number.isFinite(session.expiresAt)
    && session.expiresAt > 0
    && !!user
    && typeof user === 'object'
    && typeof (user as Record<string, unknown>).id === 'string'
    && ((user as Record<string, unknown>).id as string).length > 0
    && typeof (user as Record<string, unknown>).email === 'string'
    && ((user as Record<string, unknown>).email as string).length > 0
}

export function createSyncSessionStore(
  userDataDir: string,
  safeStorage: SafeStorageProxy
): SyncSessionStore {
  const path = join(userDataDir, 'refora-sync-session.enc')

  return {
    load() {
      if (!existsSync(path)) return null
      let encrypted: Buffer
      try {
        encrypted = readFileSync(path)
      } catch (error) {
        logger.warn(
          `sync-session:read failed: ${error instanceof Error ? error.message : String(error)}`
        )
        return null
      }
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn('sync-session:read deferred because encryption is unavailable')
        return null
      }
      let decrypted: string
      try {
        decrypted = safeStorage.decrypt(encrypted)
      } catch (error) {
        logger.warn(
          `sync-session:decrypt failed: ${error instanceof Error ? error.message : String(error)}`
        )
        const quarantinePath = `${path}.quarantine-${randomUUID()}`
        try {
          renameSync(path, quarantinePath)
        } catch (quarantineError) {
          logger.warn(
            `sync-session:quarantine failed: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`
          )
        }
        return null
      }
      try {
        const parsed = JSON.parse(decrypted) as unknown
        if (!isSession(parsed)) throw new Error('Invalid session payload')
        return parsed
      } catch (error) {
        logger.warn(
          `sync-session:payload invalid: ${error instanceof Error ? error.message : String(error)}`
        )
        try {
          unlinkSync(path)
        } catch (cleanupError) {
          logger.warn(
            `sync-session:corrupt cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          )
        }
        return null
      }
    },
    save(session) {
      if (!isSession(session)) throw new Error('Invalid sync session payload')
      const encrypted = safeStorage.encrypt(JSON.stringify(session))
      if (!encrypted) throw new Error('Unable to encrypt an empty sync session')
      const directory = dirname(path)
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
      const temporary = `${path}.tmp-${randomUUID()}`
      try {
        writeFileSync(temporary, encrypted, { mode: 0o600 })
        renameSync(temporary, path)
      } catch (error) {
        if (existsSync(temporary)) {
          try {
            unlinkSync(temporary)
          } catch {
            logger.warn('sync-session:temporary cleanup failed')
          }
        }
        throw error
      }
    },
    clear() {
      if (existsSync(path)) unlinkSync(path)
    }
  }
}
