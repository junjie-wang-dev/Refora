import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { showContextMenu } from '../../src/renderer/utils/contextMenu'
import { useDocumentStore } from '../../src/renderer/store/documentStore'

beforeEach(() => vi.mocked(window.api.contextMenu.show).mockReset().mockResolvedValue(null))

describe('native context menu bridge', () => {
  it('sends serializable items and dispatches a nested action without losing its captured selection', async () => {
    const copy = vi.fn()
    vi.mocked(window.api.contextMenu.show).mockResolvedValue('1.0')
    showContextMenu([
      { key: 'copy', label: 'Copy', disabled: true, onClick: vi.fn(), icon: 'copy' },
      { key: 'ai', type: 'submenu', label: 'AI', children: [{ key: 'copy', label: 'Copy selection', onClick: copy }] }
    ])
    const payload = vi.mocked(window.api.contextMenu.show).mock.calls[0][0]
    expect(JSON.parse(JSON.stringify(payload))[1].children[0]).toEqual({ id: '1.0', label: 'Copy selection', type: 'normal', enabled: true })
    expect(payload[0]).toHaveProperty('icon', 'copy')
    await waitFor(() => expect(copy).toHaveBeenCalledOnce())
  })

  it('does not invoke actions on cancellation or disabled entries', async () => {
    const action = vi.fn()
    showContextMenu([{ key: 'copy', label: 'Copy', onClick: action }])
    await Promise.resolve()
    vi.mocked(window.api.contextMenu.show).mockResolvedValue('0')
    showContextMenu([{ key: 'copy', label: 'Copy', disabled: true, onClick: action }])
    await Promise.resolve()
    expect(action).not.toHaveBeenCalled()
  })

  it('ignores a stale menu response after another menu opens', async () => {
    let resolve!: (id: string) => void
    vi.mocked(window.api.contextMenu.show).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const action = vi.fn()
    showContextMenu([{ key: 'copy', label: 'Copy', onClick: action }])
    showContextMenu([{ key: 'other', label: 'Other' }])
    resolve('0')
    await Promise.resolve()
    expect(action).not.toHaveBeenCalled()
  })

  it('reports a failed menu action', async () => {
    const toast = vi.spyOn(useDocumentStore.getState(), 'showToast')
    vi.mocked(window.api.contextMenu.show).mockResolvedValue('0')
    showContextMenu([{ key: 'copy', label: 'Copy', onClick: () => Promise.reject(new Error('failed')) }])
    await waitFor(() => expect(toast).toHaveBeenCalled())
    toast.mockRestore()
  })
})
