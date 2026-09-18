import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LatexExplorer from '../../src/renderer/components/latex/LatexExplorer'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => values?.path ? `${key} ${values.path}` : key }) }))

afterEach(cleanup)

const props = () => ({
  tab: 'files' as const, onTabChange: vi.fn(), files: ['main.tex', 'chapter.tex', 'figure.png'], currentFile: 'main.tex', rootFile: 'main.tex', source: '\\section{Draft}', assets: [], busy: false,
  onOpen: vi.fn(), onInsert: vi.fn(), onNavigate: vi.fn(), onCreate: vi.fn(), onClose: vi.fn()
})

describe('LaTeX project explorer', () => {
  it('opens resources and renames source files using project-relative paths', async () => {
    const onPreview = vi.fn()
    const onRename = vi.fn().mockResolvedValue(undefined)
    render(<LatexExplorer {...props()} onPreview={onPreview} onRename={onRename} />)
    fireEvent.click(screen.getByRole('button', { name: 'figure.png' }))
    expect(onPreview).toHaveBeenCalledWith('figure.png')
    fireEvent.click(screen.getByRole('button', { name: 'latex.renameFile chapter.tex' }))
    expect(screen.getByText('latex.renameReferencesHint')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'latex.filePath' }), { target: { value: 'chapters/intro.tex' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.applyFileChange' }))
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('chapter.tex', 'chapters/intro.tex'))
  })
  it('requires explicit deletion confirmation and protects the root file', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    render(<LatexExplorer {...props()} onDelete={onDelete} />)
    expect(screen.getByRole('button', { name: 'latex.deleteFile main.tex' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'latex.deleteFile chapter.tex' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'latex.deleteFileAction' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('chapter.tex'))
  })
  it('imports additional files and previews PDF resources', () => {
    const onImport = vi.fn()
    const onPreview = vi.fn()
    render(<LatexExplorer {...props()} files={['main.tex', 'figures/chart.pdf']} onImport={onImport} onPreview={onPreview} />)
    fireEvent.click(screen.getByRole('button', { name: 'latex.importFiles' }))
    expect(onImport).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'chart.pdf' }))
    expect(onPreview).toHaveBeenCalledWith('figures/chart.pdf')
  })
  it('retains the rename dialog and displays a rejected file operation', async () => {
    render(<LatexExplorer {...props()} onRename={vi.fn().mockRejectedValue(new Error('Destination exists'))} />)
    fireEvent.click(screen.getByRole('button', { name: 'latex.renameFile chapter.tex' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'latex.filePath' }), { target: { value: 'main.tex' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.applyFileChange' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Destination exists')
    expect(screen.getByRole('textbox', { name: 'latex.filePath' })).toHaveValue('main.tex')
  })
  it('searches all project files and navigates to a result line', () => {
    const onNavigateFile = vi.fn()
    render(<LatexExplorer {...props()} tab="search" onNavigateFile={onNavigateFile} projectSources={[{ path: 'main.tex', content: '' }, { path: 'chapter.tex', content: 'first\nMatching citation' }]} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'latex.searchProject' }), { target: { value: 'CITATION' } })
    fireEvent.click(screen.getByText('Matching citation').closest('button')!)
    expect(onNavigateFile).toHaveBeenCalledWith('chapter.tex', 2)
  })
  it('uses unsaved current content in the project outline', () => {
    const onNavigateFile = vi.fn()
    render(<LatexExplorer {...props()} tab="outline" onNavigateFile={onNavigateFile} projectSources={[{ path: 'main.tex', content: '\\section{Old}' }, { path: 'chapter.tex', content: '\\section{Chapter}' }]} />)
    expect(screen.queryByText('Old')).not.toBeInTheDocument()
    expect(screen.getByText('Draft')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Chapter').closest('button')!)
    expect(onNavigateFile).toHaveBeenCalledWith('chapter.tex', 1)
  })
})
