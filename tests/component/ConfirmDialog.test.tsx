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

  it('passes an undefined input value for plain confirmation requests', () => {
    const onConfirm = vi.fn()
    useConfirmStore.getState().show({ title: 't', message: 'm', onConfirm })
    render(<ConfirmDialog />)
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByText('OK'))
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  it('confirms an input request with the entered value on Enter', () => {
    const onConfirm = vi.fn()
    useConfirmStore.getState().show({
      title: 'New category',
      message: 'Name',
      confirmText: 'Create',
      cancelText: 'Cancel',
      input: { defaultValue: '', placeholder: 'Name' },
      onConfirm
    })
    render(<ConfirmDialog />)

    const input = screen.getByPlaceholderText('Name')
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: ' Papers ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledWith(' Papers ')
    expect(useConfirmStore.getState().request).toBeNull()
  })

  it('dismisses an input request on Escape without confirming', () => {
    const onConfirm = vi.fn()
    useConfirmStore.getState().show({
      title: 't',
      message: 'm',
      input: { defaultValue: 'draft', placeholder: 'Name' },
      onConfirm
    })
    render(<ConfirmDialog />)

    const input = screen.getByPlaceholderText('Name')
    expect(input).toHaveValue('draft')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onConfirm).not.toHaveBeenCalled()
    expect(useConfirmStore.getState().request).toBeNull()
  })
})
