import { safeStorage } from 'electron'
import { RepoError } from '../db/repositories/errors'

export interface SafeStorageProxy {
  isEncryptionAvailable(): boolean
  encrypt(apiKey: string | undefined): Buffer | null
  decrypt(enc: Buffer | null, allowEmpty?: boolean): string
}

export function createSafeStorageProxy(): SafeStorageProxy {
  return {
    isEncryptionAvailable(): boolean {
      return safeStorage.isEncryptionAvailable()
    },
    encrypt(apiKey: string | undefined): Buffer | null {
      if (!apiKey) return null
      if (!safeStorage.isEncryptionAvailable()) {
        throw new RepoError(
          'encryption_unavailable',
          'OS keychain (safeStorage) is not available. API keys cannot be securely stored.'
        )
      }
      return safeStorage.encryptString(apiKey)
    },
    decrypt(enc: Buffer | null, allowEmpty = false): string {
      if (!enc) {
        if (allowEmpty) return ''
        throw new RepoError('no_api_key', 'Provider has no API key')
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new RepoError(
          'encryption_unavailable',
          'OS keychain (safeStorage) is not available. Cannot decrypt API key.'
        )
      }
      return safeStorage.decryptString(enc)
    }
  }
}
