import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useConfirmStore } from '../../src/renderer/store/confirmStore'

beforeEach(() => {
  useConfirmStore.setState({ request: null })
})

describe('useConfirmStore', () => {
  it('starts with no request', () => {
    expect(useConfirmStore.getState().request).toBeNull()
  })

  it('show() sets a request with defaults for optional fields', () => {
    const onConfirm = vi.fn()
    useConfirmStore.getState().show({ title: 'Delete?', message: 'Sure?', onConfirm })
    const req = useConfirmStore.getState().request
    expect(req).not.toBeNull()
    expect(req!.title).toBe('Delete?')
    expect(req!.message).toBe('Sure?')
    expect(req!.confirmText).toBe('OK')
    expect(req!.cancelText).toBe('Cancel')
    expect(req!.danger).toBe(false)
    expect(req!.onConfirm).toBe(onConfirm)
  })

  it('show() honors provided confirmText, cancelText and danger', () => {
    useConfirmStore.getState().show({
      title: 't', message: 'm', confirmText: 'Yes', cancelText: 'No', danger: true,
      onConfirm: () => {}
    })
    const req = useConfirmStore.getState().request!
    expect(req.confirmText).toBe('Yes')
    expect(req.cancelText).toBe('No')
    expect(req.danger).toBe(true)
  })

  it('show() stores optional input options for prompt-style requests', () => {
    const onConfirm = vi.fn()
    useConfirmStore.getState().show({
      title: 't',
      message: 'm',
      input: { defaultValue: 'draft', placeholder: 'Name' },
      onConfirm
    })
    const req = useConfirmStore.getState().request!
    expect(req.input).toEqual({ defaultValue: 'draft', placeholder: 'Name' })
    expect(req.onConfirm).toBe(onConfirm)
  })

  it('dismiss() clears the request', () => {
    useConfirmStore.getState().show({ title: 't', message: 'm', onConfirm: () => {} })
    useConfirmStore.getState().dismiss()
    expect(useConfirmStore.getState().request).toBeNull()
  })
})
