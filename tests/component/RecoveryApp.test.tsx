import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReforaApi } from '../../src/shared/ipc-types'
import RecoveryApp from '../../src/renderer/components/RecoveryApp'
import { initI18n } from '../../src/renderer/i18n'
import { useSyncAccountStore } from '../../src/renderer/store/syncAccountStore'

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

const api = (window as unknown as { api: ReforaApi }).api

describe('RecoveryApp', () => {
  let confirmationCallback: ((payload: {
    status: 'confirmed' | 'error'
    message: string | null
  }) => void) | null

  beforeEach(() => {
    initI18n('en')
    confirmationCallback = null
    api.sync.status = vi.fn().mockResolvedValue({
      configured: true,
      syncAvailable: false,
      signedIn: false,
      enabled: false,
      state: 'signedOut',
      account: null
    })
    api.events.onSyncAuthConfirmation = vi.fn((callback) => {
      confirmationCallback = callback
    })
    api.events.off = vi.fn()
    useSyncAccountStore.setState({
      status: null,
      loading: false,
      loadFailed: false,
      confirmation: null
    })
  })

  afterEach(() => cleanup())

  it('keeps account access available when the library database cannot open', async () => {
    render(<RecoveryApp />)

    expect(screen.getByText('The local library couldn’t be opened')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open account' }))

    expect(await screen.findByText('Welcome back')).toBeInTheDocument()
    expect(api.sync.status).toHaveBeenCalled()
  })

  it('opens the account confirmation result from a deep link', async () => {
    render(<RecoveryApp />)

    confirmationCallback?.({ status: 'confirmed', message: null })

    await waitFor(() => expect(screen.getByText('Email confirmed')).toBeInTheDocument())
  })
})
