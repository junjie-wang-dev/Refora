import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, opts?: { count?: number }) => opts?.count != null ? `${k}-${opts.count}` : k })
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

import ConfirmDialog from '../../src/renderer/components/ConfirmDialog'
import { useConfirmStore } from '../../src/renderer/store/confirmStore'

describe('ConfirmDialog', () => {
  beforeEach(() => {
    useConfirmStore.setState({ request: null })
  })

  afterEach(() => {
    cleanup()
    useConfirmStore.setState({ request: null })
  })

  it('renders nothing when no confirm request exists', () => {
    const { container } = render(<ConfirmDialog />)
    expect(container.firstChild).toBeNull()
  })

  it('renders confirm-store request and calls onConfirm on confirm', () => {
    const onConfirm = vi.fn()
    useConfirmStore.getState().show({ title: 'Are you sure?', message: 'Really?', confirmText: 'Yes', cancelText: 'No', danger: true, onConfirm })
    render(<ConfirmDialog />)
    expect(screen.getByText('Really?')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Yes'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(useConfirmStore.getState().request).toBeNull()
  })

  it('dismisses on cancel', () => {
    const onConfirm = vi.fn()
    useConfirmStore.getState().show({ title: 't', message: 'm', onConfirm })
    render(<ConfirmDialog />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(useConfirmStore.getState().request).toBeNull()
  })

  it('supports destructive confirmation requests', () => {
    const action = vi.fn()
    useConfirmStore.getState().show({
      title: 'Delete',
      message: 'Special warning',
      confirmText: 'Delete',
      danger: true,
      onConfirm: action
    })
    render(<ConfirmDialog />)
    expect(screen.getByText('Special warning')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(action).toHaveBeenCalledTimes(1)
  })
})
