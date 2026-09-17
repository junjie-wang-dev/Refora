import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import LatexReviewPanel from '../../src/renderer/components/latex/LatexReviewPanel'
import type { LatexReview } from '../../src/shared/latex-types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
const review: LatexReview = { id: 'review', path: 'main.tex', baseContent: 'Old\nKeep\nDelete\n', expectedHash: 'hash', edits: [
  { id: 'a', startLine: 0, endLine: 1, before: 'Old\n', after: 'New\n', status: 'pending' },
  { id: 'b', startLine: 2, endLine: 3, before: 'Delete\n', after: '', status: 'pending' }
] }
it('shows additions and deletions with individual and bulk review controls', () => {
  const resolve = vi.fn()
  render(<LatexReviewPanel review={review} busy={false} onResolve={resolve} />)
  expect(screen.getByText('Old').closest('.latex-diff-row')).toHaveClass('latex-review-removed')
  expect(screen.getByText('New').closest('.latex-diff-row')).toHaveClass('latex-review-added')
  expect(screen.getByText('Delete').closest('.latex-diff-row')).toHaveClass('latex-review-removed')
  fireEvent.click(screen.getAllByRole('button', { name: 'latex.acceptChange' })[0])
  expect(resolve).toHaveBeenLastCalledWith('accept', 'a')
  fireEvent.click(screen.getAllByRole('button', { name: 'latex.rejectChange' })[1])
  expect(resolve).toHaveBeenLastCalledWith('reject', 'b')
  fireEvent.click(screen.getByRole('button', { name: 'latex.acceptAll' }))
  expect(resolve).toHaveBeenLastCalledWith('accept')
  fireEvent.click(screen.getByRole('button', { name: 'latex.rejectAll' }))
  expect(resolve).toHaveBeenLastCalledWith('reject')
})


it('navigates between changes and expands collapsed unchanged context', () => {
  const middle = Array.from({ length: 20 }, (_, index) => `Unchanged ${index}\n`).join('')
  const longReview: LatexReview = { ...review, baseContent: 'Old\n' + middle + 'Delete\n', edits: [review.edits[0], { ...review.edits[1], startLine: 21, endLine: 22 }] }
  render(<LatexReviewPanel review={longReview} busy={false} onResolve={vi.fn()} />)
  expect(screen.queryByText('Unchanged 10')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'latex.nextChange' }))
  expect(screen.getAllByRole('region', { name: 'latex.aiChangeLine' })[1]).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: 'latex.previousChange' }))
  expect(screen.getAllByRole('region', { name: 'latex.aiChangeLine' })[0]).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: 'latex.showUnchanged' }))
  expect(screen.getByText('Unchanged 10')).toBeVisible()
})
