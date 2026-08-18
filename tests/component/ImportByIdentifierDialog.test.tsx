import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showContextMenu } from '@lobehub/ui'

const mocks = vi.hoisted(() => ({
  importByIdentifier: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

vi.mock('../../src/renderer/store/documentStore', () => ({
  useDocumentStore: Object.assign(
    (selector: (state: { importByIdentifier: typeof mocks.importByIdentifier }) => unknown) =>
      selector({ importByIdentifier: mocks.importByIdentifier }),
    { getState: () => ({ importByIdentifier: mocks.importByIdentifier }) }
  )
}))

import ImportByIdentifierDialog from '../../src/renderer/components/ImportByIdentifierDialog'

describe('ImportByIdentifierDialog', () => {
  beforeEach(() => {
    mocks.importByIdentifier.mockReset().mockResolvedValue(null)
    vi.mocked(showContextMenu).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('delegates a trimmed identifier to the store and closes after success', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ImportByIdentifierDialog open onClose={onClose} />)

    const importButton = screen.getByRole('button', { name: 'identifierImport.import' })
    expect(importButton).toBeDisabled()
    await user.type(screen.getByPlaceholderText('identifierImport.placeholder'), '  10.1000/test  ')
    await user.click(importButton)

    expect(mocks.importByIdentifier).toHaveBeenCalledWith('10.1000/test')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('submits via Enter key', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ImportByIdentifierDialog open onClose={onClose} />)

    await user.type(screen.getByPlaceholderText('identifierImport.placeholder'), '2401.12345{Enter}')

    expect(mocks.importByIdentifier).toHaveBeenCalledWith('2401.12345')
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  it('does nothing when input is empty', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ImportByIdentifierDialog open onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'identifierImport.import' }))

    expect(mocks.importByIdentifier).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('uses a single focus border without an outer ring', () => {
    render(<ImportByIdentifierDialog open onClose={vi.fn()} />)

    expect(screen.getByPlaceholderText('identifierImport.placeholder')).toHaveClass('focus:ring-0')
  })

  it('clears the input when cancelled', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ImportByIdentifierDialog open onClose={onClose} />)

    const input = screen.getByPlaceholderText('identifierImport.placeholder')
    await user.type(input, 'doi')
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))

    expect(input).toHaveValue('')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps the dialog open and shows the error when import fails', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    mocks.importByIdentifier.mockResolvedValue('Import failed: lookup failed')
    render(<ImportByIdentifierDialog open onClose={onClose} />)

    await user.type(screen.getByPlaceholderText('identifierImport.placeholder'), '2401.12345')
    await user.click(screen.getByRole('button', { name: 'identifierImport.import' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Import failed: lookup failed')
    expect(screen.getByRole('button', { name: 'identifierImport.retry' })).toBeEnabled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('can close immediately while an import is pending and ignores its eventual result', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    let resolveImport: (message: string | null) => void = () => {}
    mocks.importByIdentifier.mockReturnValue(new Promise((resolve) => { resolveImport = resolve }))
    const { rerender } = render(<ImportByIdentifierDialog open onClose={onClose} />)

    await user.type(screen.getByPlaceholderText('identifierImport.placeholder'), '2401.12345')
    await user.click(screen.getByRole('button', { name: 'identifierImport.import' }))

    expect(screen.getByRole('status')).toHaveTextContent('identifierImport.backgroundHint')
    await user.click(screen.getByRole('button', { name: 'common.close' }))
    expect(onClose).toHaveBeenCalledOnce()

    rerender(<ImportByIdentifierDialog open onClose={onClose} />)
    expect(screen.getByPlaceholderText('identifierImport.placeholder')).toHaveValue('')
    resolveImport('identifierImport.networkFailed')
    await act(async () => {})
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('explains when the network is taking longer than expected', async () => {
    vi.useFakeTimers()
    let resolveImport: (message: string | null) => void = () => {}
    mocks.importByIdentifier.mockReturnValue(new Promise((resolve) => { resolveImport = resolve }))
    render(<ImportByIdentifierDialog open onClose={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('identifierImport.placeholder'), {
      target: { value: '2401.12345' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'identifierImport.import' }))
    await act(() => vi.advanceTimersByTimeAsync(5_000))

    expect(screen.getByRole('status')).toHaveTextContent('identifierImport.slowNetwork')
    resolveImport(null)
    await act(async () => {})
  })

  it('offers cut, copy, and paste from the input context menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const readText = vi.fn().mockResolvedValue('arXiv:')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText }
    })
    render(<ImportByIdentifierDialog open onClose={vi.fn()} />)
    const input = screen.getByPlaceholderText('identifierImport.placeholder') as HTMLInputElement

    fireEvent.change(input, { target: { value: '2401.12345' } })
    input.setSelectionRange(0, 4)
    fireEvent.contextMenu(input)

    const items = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      label: string
      disabled?: boolean
      onClick: () => Promise<void>
    }>
    expect(items.map((item) => [item.key, item.label])).toEqual([
      ['cut', 'identifierImport.cut'],
      ['copy', 'identifierImport.copy'],
      ['paste', 'identifierImport.paste']
    ])
    expect(items[0].disabled).toBe(false)
    expect(items[1].disabled).toBe(false)

    await act(() => items[1].onClick())
    expect(writeText).toHaveBeenCalledWith('2401')

    await act(() => items[0].onClick())
    expect(input).toHaveValue('.12345')

    input.setSelectionRange(0, 0)
    fireEvent.contextMenu(input)
    const pasteItems = vi.mocked(showContextMenu).mock.calls[1][0] as typeof items
    await act(() => pasteItems[2].onClick())
    expect(readText).toHaveBeenCalledOnce()
    expect(input).toHaveValue('arXiv:.12345')
  })
})
