import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createSyncRuntime,
  validSupabasePublishableKey,
  validSupabaseUrl
} from '../../src/main/services/syncRuntime'

const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encrypt: vi.fn((value: string | undefined) => value ? Buffer.from(value) : null),
  decrypt: vi.fn((value: Buffer | null) => value?.toString() ?? '')
}

describe('sync runtime', () => {
  it('accepts only origin-level HTTPS URLs and local HTTP development URLs', () => {
    expect(validSupabaseUrl('https://project.supabase.co')).toBe(true)
    expect(validSupabaseUrl('http://localhost:54321')).toBe(true)
    expect(validSupabaseUrl('http://127.0.0.1:54321/')).toBe(true)
    expect(validSupabaseUrl('http://project.supabase.co')).toBe(false)
    expect(validSupabaseUrl('https://project.supabase.co/custom/path')).toBe(false)
    expect(validSupabaseUrl('https://user:secret@project.supabase.co')).toBe(false)
    expect(validSupabaseUrl('https://project.supabase.co?redirect=evil')).toBe(false)
  })

  it('rejects secret and service-role keys', () => {
    const anonPayload = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')
    const servicePayload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')
    expect(validSupabasePublishableKey('sb_publishable_public-value')).toBe(true)
    expect(validSupabasePublishableKey(`header.${anonPayload}.signature`)).toBe(true)
    expect(validSupabasePublishableKey('sb_secret_private-value')).toBe(false)
    expect(validSupabasePublishableKey(`header.${servicePayload}.signature`)).toBe(false)
    expect(validSupabasePublishableKey('arbitrary-key')).toBe(false)
  })

  it('configures account authentication without speculative sync-engine state', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'refora-sync-runtime-'))
    const service = createSyncRuntime({
      userDataDir,
      fetch: vi.fn(),
      env: {
        REFORA_SUPABASE_URL: 'https://project.supabase.co',
        REFORA_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_key'
      },
      safeStorage,
      issueConfirmationRedirect: () => ({
        url: 'refora://auth/confirmed?nonce=test',
        clear: vi.fn(),
        rollback: vi.fn()
      })
    })

    await expect(service.status()).resolves.toMatchObject({
      configured: true,
      signedIn: false
    })
  })
})
