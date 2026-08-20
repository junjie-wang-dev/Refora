import { mkdtempSync, readFileSync, statSync } from 'node:fs'
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
})
