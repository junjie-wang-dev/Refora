import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
  available: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn()
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: storage.available,
    encryptString: storage.encrypt,
    decryptString: storage.decrypt
  }
}))

import { createSafeStorageProxy } from '../../src/main/services/safeStorageProxy'

describe('safe storage proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.available.mockReturnValue(true)
    storage.encrypt.mockReturnValue(Buffer.from('encrypted'))
    storage.decrypt.mockReturnValue('secret')
  })

  it('encrypts and decrypts through the OS keychain', () => {
    const proxy = createSafeStorageProxy()

    expect(proxy.isEncryptionAvailable()).toBe(true)
    expect(proxy.encrypt('secret')).toEqual(Buffer.from('encrypted'))
    expect(proxy.decrypt(Buffer.from('encrypted'))).toBe('secret')
    expect(storage.encrypt).toHaveBeenCalledWith('secret')
    expect(storage.decrypt).toHaveBeenCalled()
  })

  it('handles missing optional values without touching the keychain', () => {
    const proxy = createSafeStorageProxy()

    expect(proxy.encrypt(undefined)).toBeNull()
    expect(proxy.decrypt(null, true)).toBe('')
    expect(() => proxy.decrypt(null)).toThrow('Provider has no API key')
    expect(storage.encrypt).not.toHaveBeenCalled()
    expect(storage.decrypt).not.toHaveBeenCalled()
  })

  it('fails closed when OS encryption is unavailable', () => {
    storage.available.mockReturnValue(false)
    const proxy = createSafeStorageProxy()

    expect(() => proxy.encrypt('secret')).toThrow('safeStorage')
    expect(() => proxy.decrypt(Buffer.from('encrypted'))).toThrow('safeStorage')
  })
})
