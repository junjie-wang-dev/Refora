import type { SyncAuthConfirmation } from '../../shared/sync-types'

export const AUTH_CONFIRMATION_REDIRECT_URL = 'refora://auth/confirmed'

function callbackParams(url: URL): URLSearchParams {
  const params = new URLSearchParams(url.search)
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  for (const [key, value] of fragment) {
    if (!params.has(key)) params.set(key, value)
  }
  return params
}

export function parseAuthConfirmationDeepLink(value: string): SyncAuthConfirmation | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (
    url.protocol !== 'refora:'
    || url.hostname !== 'auth'
    || url.pathname !== '/confirmed'
    || url.username
    || url.password
  ) {
    return null
  }

  const params = callbackParams(url)
  const error = params.get('error_description') ?? params.get('error')
  if (error) {
    return {
      status: 'error',
      message: error.slice(0, 500)
    }
  }
  return { status: 'confirmed', message: null }
}
