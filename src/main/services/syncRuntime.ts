import type { SafeStorageProxy } from './safeStorageProxy'
import { createSafeStorageProxy } from './safeStorageProxy'
import { createSupabaseAuthClient } from './supabaseAuth'
import { createSyncSessionStore } from './syncSessionStore'
import { createSyncAccountService, type SyncAccountService } from './syncAccount'
import { logger } from './logger'
import type { AuthConfirmationRedirect } from './authDeepLink'

declare const __REFORA_SUPABASE_URL__: string
declare const __REFORA_SUPABASE_PUBLISHABLE_KEY__: string

export interface SyncRuntimeDeps {
  userDataDir: string
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  env?: NodeJS.ProcessEnv
  safeStorage?: SafeStorageProxy
  issueConfirmationRedirect: () => AuthConfirmationRedirect
}

export function validSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const validProtocol = url.protocol === 'https:'
      || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
    return validProtocol
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (url.pathname === '/' || url.pathname === '')
  } catch {
    return false
  }
}

export function validSupabasePublishableKey(value: string): boolean {
  const key = value.trim()
  if (key.startsWith('sb_publishable_')) return key.length > 'sb_publishable_'.length
  if (key.startsWith('sb_secret_')) return false
  const parts = key.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    return !!payload
      && typeof payload === 'object'
      && (payload as Record<string, unknown>).role === 'anon'
  } catch {
    return false
  }
}

export function createSyncRuntime({
  userDataDir,
  fetch,
  env = process.env,
  safeStorage = createSafeStorageProxy(),
  issueConfirmationRedirect
}: SyncRuntimeDeps): SyncAccountService {
  const embeddedUrl = typeof __REFORA_SUPABASE_URL__ === 'string'
    ? __REFORA_SUPABASE_URL__
    : ''
  const embeddedPublishableKey = typeof __REFORA_SUPABASE_PUBLISHABLE_KEY__ === 'string'
    ? __REFORA_SUPABASE_PUBLISHABLE_KEY__
    : ''
  const url = env.REFORA_SUPABASE_URL?.trim() || embeddedUrl.trim()
  const publishableKey = env.REFORA_SUPABASE_PUBLISHABLE_KEY?.trim()
    || embeddedPublishableKey.trim()
  const configured = validSupabaseUrl(url) && validSupabasePublishableKey(publishableKey)
  if ((url || publishableKey) && !configured) {
    logger.warn('sync: Supabase configuration is incomplete or invalid')
  }
  const auth = configured
    ? createSupabaseAuthClient({ url, publishableKey, fetch, issueConfirmationRedirect })
    : null
  return createSyncAccountService({
    configured,
    auth,
    sessions: createSyncSessionStore(userDataDir, safeStorage)
  })
}
