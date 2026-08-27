export interface SyncAccount {
  id: string
  email: string
}

export interface SyncServiceStatus {
  configured: boolean
  signedIn: boolean
  account: SyncAccount | null
  library?: SyncLibraryStatus | null
}

export interface SyncLibraryStatus {
  libraryId: string
  enabled: boolean
  running: boolean
  lastSyncedAt: number | null
  lastError: string | null
  pendingCount: number
  conflictCount: number
  storageMode: 'local-working-cloud-snapshots'
}

export interface SyncEnabledRequest {
  enabled: boolean
}

export type SyncConflictResolution = 'keep_local' | 'use_remote'

export interface SyncConflict {
  id: string
  entityType: string
  entityId: string
  createdAt: number
}

export interface SyncConflictResolutionRequest {
  id: string
  resolution: SyncConflictResolution
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
