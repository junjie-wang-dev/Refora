import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LatexResourceDialog } from '../../src/renderer/components/latex/LatexRecoveryDialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../src/renderer/components/latex/LatexPdfPreview', () => ({ default: () => <div aria-label="PDF reader" /> }))
afterEach(cleanup)

it('shows the file name and directory with an accessible icon-only close button', () => {
  const onClose = vi.fn()
  render(<LatexResourceDialog resource={{ path: 'figures/a-long-file-name.png', mimeType: 'image/png', base64: 'aW1hZ2U=' }} onClose={onClose} />)
  expect(screen.getByRole('heading', { name: 'a-long-file-name.png' })).toBeVisible()
  expect(screen.getByText('figures · image/png')).toBeVisible()
  expect(screen.getByRole('img', { name: 'figures/a-long-file-name.png' })).toHaveAttribute('src', 'data:image/png;base64,aW1hZ2U=')
  const close = screen.getByRole('button', { name: 'common.close' })
  expect(close).toHaveTextContent('')
  expect(close).toHaveFocus()
  fireEvent.click(close)
  expect(onClose).toHaveBeenCalledOnce()
})

it('closes with Escape and restores focus to the opener', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const onClose = vi.fn()
  const view = render(<LatexResourceDialog resource={{ path: 'paper.pdf', mimeType: 'application/pdf', base64: 'cGRm' }} onClose={onClose} />)
  expect(screen.getByLabelText('PDF reader')).toBeInTheDocument()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount()
  expect(opener).toHaveFocus()
  opener.remove()
})

it('explains unsupported file previews', () => {
  render(<LatexResourceDialog resource={{ path: 'data.bin', mimeType: 'application/octet-stream', base64: '' }} onClose={vi.fn()} />)
  expect(screen.getByRole('status')).toHaveTextContent('latex.resourceNoPreview')
})
