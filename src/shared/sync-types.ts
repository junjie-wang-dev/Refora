export interface SyncAccount {
  id: string
  email: string
}

export type SyncServiceState = 'unconfigured' | 'signedOut' | 'disabled' | 'ready'

export interface SyncServiceStatus {
  configured: boolean
  syncAvailable: boolean
  signedIn: boolean
  enabled: boolean
  state: SyncServiceState
  account: SyncAccount | null
}

export interface SyncCredentials {
  email: string
  password: string
}

export interface SyncEmailRequest {
  email: string
}

export interface SyncSignUpResult {
  status: SyncServiceStatus
  confirmationRequired: boolean
}

export interface SyncAuthConfirmation {
  status: 'confirmed' | 'error'
  message: string | null
}
