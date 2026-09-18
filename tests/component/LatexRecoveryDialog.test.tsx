import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LatexConflictDialog, LatexHistoryDialog, LatexResourceDialog } from '../../src/renderer/components/latex/LatexRecoveryDialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../src/renderer/components/latex/LatexPdfPreview', () => ({ default: ({ data }: { data: string }) => <div data-testid="resource-pdf">{data}</div> }))
afterEach(cleanup)

const conflictProps = () => ({ base: 'Original', draft: 'Local changes', remote: { path: 'main.tex', content: 'Disk changes', hash: 'remote-hash' }, busy: false, onClose: vi.fn(), onMerge: vi.fn(), onSaveAs: vi.fn(), onDownload: vi.fn() })

describe('LaTeX recovery dialogs', () => {
  it('shows all three versions and saves an edited merge against the observed disk hash', () => {
    const props = conflictProps()
    render(<LatexConflictDialog {...props} />)
    expect(screen.getByLabelText('latex.baseVersion')).toHaveValue('Original')
    expect(screen.getByLabelText('latex.localVersion')).toHaveValue('Local changes')
    expect(screen.getByLabelText('latex.diskVersion')).toHaveValue('Disk changes')
    fireEvent.change(screen.getByLabelText('latex.mergedVersion'), { target: { value: 'Both changes combined' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.saveMerge' }))
    expect(props.onMerge).toHaveBeenCalledWith('Both changes combined', 'remote-hash')
  })
  it('keeps the original draft available after selecting the disk version and permits a copy', () => {
    const props = conflictProps()
    render(<LatexConflictDialog {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'latex.useDiskVersion' }))
    expect(screen.getByLabelText('latex.mergedVersion')).toHaveValue('Disk changes')
    expect(screen.getByLabelText('latex.localVersion')).toHaveValue('Local changes')
    fireEvent.change(screen.getByLabelText('latex.copyPath'), { target: { value: 'main.tex' } })
    expect(screen.getByRole('button', { name: 'latex.saveCopy' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('latex.copyPath'), { target: { value: 'chapters/recovered.tex' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.saveCopy' }))
    expect(props.onSaveAs).toHaveBeenCalledWith('chapters/recovered.tex', 'Disk changes')
  })
  it('prevents merging over a pending AI review while allowing recovery to another file', () => {
    const props = conflictProps()
    render(<LatexConflictDialog {...props} remote={{ ...props.remote, review: { id: 'review', path: 'main.tex', baseContent: 'Original', expectedHash: 'remote-hash', edits: [] } }} />)
    expect(screen.getByRole('button', { name: 'latex.saveMerge' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'latex.saveCopy' })).toBeEnabled()
  })
  it('previews the chosen history entry before restoring it', () => {
    const onRestore = vi.fn()
    render(<LatexHistoryDialog busy={false} onClose={vi.fn()} onRestore={onRestore} entries={[{ id: 'new', content: 'New version', createdAt: '2026-09-18' }, { id: 'old', content: 'Old version', createdAt: '2026-09-17' }]} />)
    fireEvent.change(screen.getByLabelText('latex.version'), { target: { value: 'old' } })
    expect(screen.getByText('Old version')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'latex.restoreVersion' }))
    expect(onRestore).toHaveBeenCalledWith('old')
  })
  it('previews image and PDF resources using local data', () => {
    const { rerender } = render(<LatexResourceDialog resource={{ path: 'chart.png', mimeType: 'image/png', base64: 'aW1hZ2U=' }} onClose={vi.fn()} />)
    expect(screen.getByAltText('chart.png')).toHaveAttribute('src', 'data:image/png;base64,aW1hZ2U=')
    rerender(<LatexResourceDialog resource={{ path: 'chart.pdf', mimeType: 'application/pdf', base64: 'cGRm' }} onClose={vi.fn()} />)
    expect(screen.getByTestId('resource-pdf')).toHaveTextContent('cGRm')
  })
})
