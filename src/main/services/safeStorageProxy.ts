import { safeStorage } from 'electron'
import { encryptKey, decryptKey } from './aiProviders'

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
      return encryptKey(apiKey)
    },
    decrypt(enc: Buffer | null, allowEmpty = false): string {
      return decryptKey(enc, allowEmpty)
    }
  }
}
