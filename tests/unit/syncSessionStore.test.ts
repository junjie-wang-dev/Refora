import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSyncSessionStore } from '../../src/main/services/syncSessionStore'

describe('sync session store', () => {
  it('persists only encrypted session bytes in a private file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'refora-sync-session-'))
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encrypt: vi.fn((value: string | undefined) => value
        ? Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
        : null),
      decrypt: vi.fn((value: Buffer | null) => {
        if (!value) throw new Error('Missing encrypted value')
        return Buffer.from(value.toString().slice('encrypted:'.length), 'base64').toString()
      })
    }
    const store = createSyncSessionStore(directory, safeStorage)
    store.save({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: 2_000_000_000,
      user: { id: 'user-1', email: 'reader@example.com' }
    })

    const path = join(directory, 'refora-sync-session.enc')
    const raw = readFileSync(path)
    expect(raw.toString()).not.toContain('access-secret')
    expect(raw.toString()).not.toContain('refresh-secret')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.load()).toMatchObject({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret'
    })
  })

  it('rejects malformed sessions before writing encrypted state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'refora-sync-session-'))
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encrypt: vi.fn(() => Buffer.from('encrypted')),
      decrypt: vi.fn(() => '')
    }
    const store = createSyncSessionStore(directory, safeStorage)

    expect(() => store.save({
      accessToken: '',
      refreshToken: 'refresh-secret',
      expiresAt: 2_000_000_000,
      user: { id: 'user-1', email: 'reader@example.com' }
    })).toThrow('Invalid sync session payload')
    expect(safeStorage.encrypt).not.toHaveBeenCalled()
  })

  it('preserves an encrypted session when encryption is temporarily unavailable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'refora-sync-session-'))
    const path = join(directory, 'refora-sync-session.enc')
    writeFileSync(path, 'encrypted-session', { mode: 0o600 })
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => false),
      encrypt: vi.fn(() => Buffer.from('encrypted')),
      decrypt: vi.fn(() => { throw new Error('encryption_unavailable') })
    }
    const store = createSyncSessionStore(directory, safeStorage)

    expect(store.load()).toBeNull()
    expect(existsSync(path)).toBe(true)
    expect(safeStorage.decrypt).not.toHaveBeenCalled()
    expect(readdirSync(directory)).toEqual(['refora-sync-session.enc'])
    rmSync(directory, { recursive: true, force: true })
  })

  it('quarantines a session when the keychain cannot decrypt it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'refora-sync-session-'))
    const path = join(directory, 'refora-sync-session.enc')
    writeFileSync(path, 'encrypted-session', { mode: 0o600 })
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encrypt: vi.fn(() => Buffer.from('encrypted')),
      decrypt: vi.fn(() => { throw new Error('Keychain request failed') })
    }
    const store = createSyncSessionStore(directory, safeStorage)

    expect(store.load()).toBeNull()
    expect(existsSync(path)).toBe(false)
    const quarantined = readdirSync(directory).filter((name) =>
      name.startsWith('refora-sync-session.enc.quarantine-')
    )
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(directory, quarantined[0]), 'utf8')).toBe('encrypted-session')
    expect(store.load()).toBeNull()
    expect(safeStorage.decrypt).toHaveBeenCalledOnce()
    rmSync(directory, { recursive: true, force: true })
  })

  it('deletes a session whose decrypted payload is invalid', () => {
    const directory = mkdtempSync(join(tmpdir(), 'refora-sync-session-'))
    const path = join(directory, 'refora-sync-session.enc')
    writeFileSync(path, 'encrypted-session', { mode: 0o600 })
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encrypt: vi.fn(() => Buffer.from('encrypted')),
      decrypt: vi.fn(() => '{')
    }
    const store = createSyncSessionStore(directory, safeStorage)

    expect(store.load()).toBeNull()
    expect(existsSync(path)).toBe(false)
    expect(safeStorage.decrypt).toHaveBeenCalledOnce()
    rmSync(directory, { recursive: true, force: true })
  })
})
