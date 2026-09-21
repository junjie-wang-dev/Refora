import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import WorkspaceLatexView from '../../src/renderer/components/latex/WorkspaceLatexView'
import { flushRendererPersistence } from '../../src/renderer/persistence'
import type { LatexFile, LatexRequest, LatexResponse, LatexSyncBox } from '../../src/shared/latex-types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../src/renderer/components/latex/LatexPdfPreview', () => ({ default: ({ data, target, syncEnabled, onLocateSource }: { data?: string; target?: { box: LatexSyncBox }; syncEnabled?: boolean; onLocateSource?: (page: number, x: number, y: number) => void }) => <div data-preview={data}><span>PDF preview</span>{target && <span>{target.box.path}:{target.box.line}</span>}<button disabled={!syncEnabled} onClick={() => onLocateSource?.(2, 30, 35)}>Locate included source</button></div> }))
const project = { id: 'p', title: 'Paper', rootFile: 'main.tex', files: ['main.tex', 'refs.bib', 'figures/chart.png', 'figures/supplement/plot.pdf', 'sections/intro.tex'] }
let cached: LatexResponse['compilation']
let previewResponse: Promise<LatexResponse> | null = null
let compileResult: LatexResponse['compilation']
let stored: LatexFile = { path: 'main.tex', content: 'Original source', hash: 'first' }
const execute = vi.fn(async (_workspace: string, request: LatexRequest): Promise<LatexResponse> => {
  if (request.action === 'list') return { projects: [project] }
  if (request.action === 'project' || request.action === 'create') return { project }
  if (request.action === 'preview') return previewResponse ?? { compilation: cached }
  if (request.action === 'read') return { file: { ...stored } }
  if (request.action === 'write') {
    if (request.expectedHash !== stored.hash) throw { code: 'conflict', message: 'External update conflict' }
    stored = { path: request.path, content: request.content, hash: 'saved' }
    return { file: { ...stored } }
  }
  if (request.action === 'compile') return { compilation: compileResult }
  return {}
})

beforeEach(() => {
  cached = undefined
  previewResponse = null
  compileResult = { success: true, log: 'Done', pdfBase64: 'cGRm' }
  stored = { path: 'main.tex', content: 'Original source', hash: 'first' }
  execute.mockClear()
  window.api.latex.execute = execute
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.useRealTimers() })
async function open() {
  render(<WorkspaceLatexView workspaceId="ws" active />)
  fireEvent.click(await screen.findByRole('button', { name: /Paper/ }))
  return screen.findByLabelText('latex.source')
}

describe('LaTeX workspace editor', () => {
  it('places the working wrap toggle alongside save and cursor status in one footer', async () => {
    const source = await open()
    const toggle = screen.getByRole('button', { name: 'latex.softWrap' })
    const footer = toggle.closest('footer')
    expect(footer).not.toBeNull()
    expect(footer).toContainElement(screen.getByRole('button', { name: 'latex.save' }))
    expect(footer).toHaveTextContent('latex.position')
    expect(source.closest('.latex-source')).not.toContainElement(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    expect(source).toHaveAttribute('wrap', 'off')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(source).toHaveAttribute('wrap', 'soft')
  })

  it('saves the edited file before compilation and exposes the active file to AI', async () => {
    const source = await open()
    fireEvent.change(source, { target: { value: 'Edited source' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
    await screen.findByText('PDF preview')
    expect(stored.content).toBe('Edited source')
    const calls = execute.mock.calls.map((call) => call[1].action)
    expect(calls.indexOf('write')).toBeLessThan(calls.indexOf('compile'))
    expect(execute).toHaveBeenCalledWith('ws', { action: 'activate', projectId: 'p', path: 'main.tex' })
  })

  it('preserves an unsaved draft on AI conflict and blocks navigation until resolved', async () => {
    const source = await open()
    fireEvent.change(source, { target: { value: 'My unsaved draft' } })
    stored = { path: 'main.tex', content: 'AI revision', hash: 'ai' }
    fireEvent.click(screen.getByRole('button', { name: 'latex.save' }))
    await screen.findByText('External update conflict')
    expect(source).toHaveValue('My unsaved draft')
    await expect(flushRendererPersistence()).rejects.toThrow()
    fireEvent.click(screen.getByRole('button', { name: 'latex.resolveConflict' }))
    await screen.findByRole('dialog', { name: 'latex.resolveConflict' })
    expect(source).toHaveValue('My unsaved draft')
    fireEvent.click(screen.getByRole('button', { name: 'latex.useDiskVersion' }))
    fireEvent.click(screen.getByRole('button', { name: 'latex.saveMerge' }))
    await waitFor(() => expect(source).toHaveValue('AI revision'))
  })

  it('refreshes a clean editor after the AI writes the open document', async () => {
    const source = await open()
    stored = { path: 'main.tex', content: 'AI updated the document', hash: 'ai' }
    await waitFor(() => expect(source).toHaveValue('AI updated the document'), { timeout: 3000 })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('flushes the current draft when the workspace or application closes', async () => {
    const source = await open()
    fireEvent.change(source, { target: { value: 'Save before leaving' } })
    await act(async () => { await flushRendererPersistence() })
    expect(stored.content).toBe('Save before leaving')
  })

  it('resizes and remembers the source and preview split', async () => {
    await open()
    const surfaces = document.querySelector('.latex-editing-surfaces') as HTMLDivElement
    const source = document.querySelector('.latex-editor-region') as HTMLElement
    Object.defineProperty(surfaces, 'clientWidth', { configurable: true, value: 1000 })

    expect(source).toHaveStyle({ flex: '0 0 50%' })
    const divider = screen.getByRole('separator')
    fireEvent.mouseDown(divider, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 650 })
    expect(source).toHaveStyle({ flex: '0 0 65%' })
    fireEvent.mouseUp(document)
    expect(localStorage.getItem('refora.latex.splitPercent')).toBe('65')
  })

  it('recovers a local draft and detects that AI changed the stored file', async () => {
    localStorage.setItem('refora.latex.draft.ws.p.main.tex', JSON.stringify({ content: 'Recovered', hash: 'old' }))
    const source = await open()
    expect(source).toHaveValue('Recovered')
    expect(screen.getByRole('alert')).toHaveTextContent('latex.conflict')
    expect(screen.getByRole('button', { name: 'latex.compile' })).toBeDisabled()
  })
})

it('keeps creation and compiler settings out of the writing surface', async () => {
  await open()
  expect(screen.queryByLabelText('latex.projectTitle')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('latex.engine')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'latex.moreActions' }))
  fireEvent.click(screen.getByRole('button', { name: 'latex.buildSettings' }))
  expect(screen.getByRole('dialog', { name: 'latex.buildSettings' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('latex.engine'), { target: { value: 'xelatex' } })
  fireEvent.click(screen.getByRole('button', { name: 'latex.done' }))
  fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
  await screen.findByText('PDF preview')
  expect(execute).toHaveBeenCalledWith('ws', { action: 'compile', projectId: 'p', engine: 'xelatex', compileId: expect.any(String) })
})

it('opens project creation as a focused dialog and cancels without modifying a document', async () => {
  render(<WorkspaceLatexView workspaceId="ws" active />)
  fireEvent.click(screen.getByRole('button', { name: 'latex.create' }))
  expect(screen.getByLabelText('latex.projectTitle')).toHaveFocus()
  fireEvent.change(screen.getByLabelText('latex.projectTitle'), { target: { value: 'A new paper' } })
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(execute.mock.calls.some((call) => call[1].action === 'create')).toBe(false)
})

it('switches files through navigation, saves the draft, and has no document tab bar', async () => {
  const implementation = execute.getMockImplementation()!
  execute.mockImplementation(async (workspaceId, request) => {
    if (request.action === 'read' && request.path === 'refs.bib') return { file: { path: 'refs.bib', content: '@article{paper}', hash: 'references' } }
    return implementation(workspaceId, request)
  })
  try {
    const source = await open()
    expect(screen.queryByRole('tab', { name: 'main.tex' })).not.toBeInTheDocument()
    fireEvent.change(source, { target: { value: 'Preserved when switching files' } })
    fireEvent.click(screen.getByRole('button', { name: 'refs.bib' }))
    await waitFor(() => expect(screen.getByLabelText('latex.source')).toHaveValue('@article{paper}'))
    expect(stored.content).toBe('Preserved when switching files')
    expect(screen.getByRole('button', { name: 'latex.currentFile' })).toHaveTextContent('refs.bib')
    expect(screen.queryByRole('tab', { name: 'refs.bib' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /main.tex/ }))
    await waitFor(() => expect(screen.getByLabelText('latex.source')).toHaveValue('Preserved when switching files'))
  } finally { execute.mockImplementation(implementation) }
})

it('loads a fixed project and lets its parent own the active AI context', async () => {
  const onFileChange = vi.fn()
  const onOpenProject = vi.fn().mockResolvedValue(undefined)
  render(<WorkspaceLatexView workspaceId="ws" active initialProject={project} manageActiveContext={false} onFileChange={onFileChange} onOpenProject={onOpenProject} />)
  await waitFor(() => expect(screen.getByLabelText('latex.source')).toHaveValue('Original source'))
  expect(onFileChange).toHaveBeenCalledWith('p', 'main.tex')
  expect(execute.mock.calls.some((call) => call[1].action === 'activate')).toBe(false)
  expect(screen.queryByRole('button', { name: 'latex.project' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'latex.moreActions' }))
  fireEvent.click(screen.getByRole('button', { name: 'latex.openProject' }))
  fireEvent.click(screen.getByRole('button', { name: /Paper/ }))
  await waitFor(() => expect(onOpenProject).toHaveBeenCalledWith(project))
})

it('separates source actions and compilation into their own pane headers', async () => {
  await open()
  const toolbar = document.querySelector<HTMLElement>('.latex-topbar')!
  expect(toolbar.contains(screen.getByRole('button', { name: 'latex.currentFile' }))).toBe(true)
  expect(toolbar.contains(screen.getByRole('button', { name: 'latex.compile' }))).toBe(false)
  expect(document.querySelector('.latex-preview-toolbar')).toContainElement(screen.getByRole('button', { name: 'latex.compile' }))
  expect(document.querySelector('.latex-editor-region')).toContainElement(toolbar)
  expect(document.querySelector('.latex-workspace > .latex-topbar')).toBeNull()
  expect(toolbar.contains(screen.getByRole('button', { name: 'latex.preview' }))).toBe(true)
  expect(document.querySelector('.latex-document-toolbar')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'latex.images' }))
  expect(screen.getByRole('tab', { name: 'latex.images' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'latex.currentFile' }))
  expect(screen.getByRole('tab', { name: 'latex.files' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'latex.moreActions' }))
  expect(screen.getByRole('button', { name: 'latex.openProject' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'latex.buildSettings' })).toBeInTheDocument()
})

it('keeps search in the toolbar and focuses source search from preview', async () => {
  render(<WorkspaceLatexView workspaceId="ws" initialProject={project} active />)
  await screen.findByLabelText('latex.source')
  const sidebar = screen.getByRole('button', { name: 'latex.toggleSidebar' })
  expect(sidebar).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(sidebar)
  expect(sidebar).toHaveAttribute('aria-pressed', 'false')
  const search = screen.getByRole('textbox', { name: 'latex.find' })
  expect(document.querySelector('.latex-topbar')).toContainElement(search)
  expect(screen.queryByRole('button', { name: 'latex.backToWorkspace' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'latex.find' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'latex.preview' }))
  fireEvent.focus(search)
  expect(screen.getByRole('button', { name: 'latex.edit' })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(search, { target: { value: 'Text' } })
  fireEvent.keyDown(search, { key: 'Escape' })
  expect(search).toBeInTheDocument()
  expect(search).toHaveValue('')
  expect(screen.getByLabelText('latex.source')).toHaveFocus()
})

it('focuses the editor after creating a source file', async () => {
  const implementation = execute.getMockImplementation()!
  const newFile = { path: 'sections/focus.tex', content: '', hash: 'new-file' }
  execute.mockImplementation(async (workspaceId, request) => {
    if (request.action === 'write' && request.path === newFile.path) return { file: newFile, project: { ...project, files: [...project.files, newFile.path] } }
    if (request.action === 'read' && request.path === newFile.path) return { file: newFile }
    return implementation(workspaceId, request)
  })
  try {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'latex.newFile' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'latex.newFile' }), { target: { value: newFile.path } })
    fireEvent.submit(screen.getByRole('dialog', { name: 'latex.newFile' }).querySelector('form')!)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByLabelText('latex.source')).toHaveFocus())
    expect(screen.getByRole('button', { name: 'latex.currentFile' })).toHaveTextContent('focus.tex')
  } finally { execute.mockImplementation(implementation) }
})

it('navigates both ways across files and disables stale source maps', async () => {
  const implementation = execute.getMockImplementation()!
  execute.mockImplementation(async (workspaceId, request) => {
    if (request.action === 'read' && request.path === 'sections/second.tex') return { file: { path: request.path, content: 'First\nMapped section\nLast', hash: 'included' } }
    if (request.action === 'compile') return { compilation: { success: true, log: '', pdfBase64: 'cGRm', synctex: { sourceHashes: { 'main.tex': stored.hash, 'sections/second.tex': 'included' }, boxes: [
      { path: 'main.tex', line: 1, page: 1, x: 20, y: 30, width: 100, height: 12 },
      { path: 'sections/second.tex', line: 2, page: 2, x: 20, y: 30, width: 100, height: 12 }
    ] } } }
    return implementation(workspaceId, request)
  })
  try {
    await open()
    const forward = screen.getByRole('button', { name: 'latex.goToPdf' })
    expect(forward).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
    await waitFor(() => expect(forward).toBeEnabled())
    fireEvent.click(forward)
    await screen.findByText('main.tex:1')
    fireEvent.click(screen.getByRole('button', { name: 'Locate included source' }))
    await waitFor(() => expect(screen.getByLabelText('latex.source')).toHaveValue('First\nMapped section\nLast'))
    const source = screen.getByLabelText<HTMLTextAreaElement>('latex.source')
    await waitFor(() => expect(source.selectionStart).toBe(6))
    expect(source.selectionEnd).toBe(20)
    expect(source).toHaveFocus()
    fireEvent.change(source, { target: { value: 'Changed source' } })
    expect(forward).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Locate included source' })).toBeDisabled()
  } finally { execute.mockImplementation(implementation) }
})

it('rejects navigation when the source changed outside the editor after compilation', async () => {
  const implementation = execute.getMockImplementation()!
  execute.mockImplementation(async (workspaceId, request) => {
    if (request.action === 'compile') return { compilation: { success: true, log: '', pdfBase64: 'cGRm', synctex: { sourceHashes: { 'main.tex': 'first' }, boxes: [{ path: 'main.tex', line: 1, page: 1, x: 20, y: 30, width: 100, height: 12 }] } } }
    return implementation(workspaceId, request)
  })
  try {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
    const forward = screen.getByRole('button', { name: 'latex.goToPdf' })
    await waitFor(() => expect(forward).toBeEnabled())
    stored = { ...stored, hash: 'external-change' }
    fireEvent.click(forward)
    await screen.findByText('latex.syncRecompile')
    expect(forward).toBeDisabled()
    expect(screen.queryByText('main.tex:1')).not.toBeInTheDocument()
  } finally { execute.mockImplementation(implementation) }
})

it('places direction arrows on the source/PDF divider without starting a resize or stealing the caret', async () => {
  const source = await open()
  const group = screen.getByRole('group', { name: 'latex.syncNavigation' })
  const forward = screen.getByRole('button', { name: 'latex.goToPdf' })
  const reverse = screen.getByRole('button', { name: 'latex.goToCode' })
  expect(group).toContainElement(forward)
  expect(group).toContainElement(reverse)
  expect(group.closest('.latex-sync-divider')).toContainElement(screen.getByRole('separator'))
  expect(document.querySelector('.latex-statusbar')).not.toContainElement(forward)
  source.focus()
  fireEvent.mouseDown(forward)
  fireEvent.mouseMove(document, { clientX: 900 })
  fireEvent.mouseUp(document)
  expect(source).toHaveFocus()
  expect(document.querySelector('.latex-editor-region')).toHaveStyle({ flex: '0 0 50%' })
})

it('only shows floating sync controls in the split layout', async () => {
  await open()
  expect(screen.getByRole('group', { name: 'latex.syncNavigation' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'latex.edit' }))
  expect(screen.queryByRole('group', { name: 'latex.syncNavigation' })).not.toBeInTheDocument()
  expect(document.querySelector('.latex-sync-divider')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'latex.preview' }))
  expect(screen.queryByRole('button', { name: 'latex.goToCode' })).not.toBeInTheDocument()
  expect(document.querySelector('.latex-sync-divider')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'latex.split' }))
  expect(screen.getByRole('button', { name: 'latex.goToPdf' })).toBeInTheDocument()
  expect(screen.getByRole('separator')).toBeInTheDocument()
})


it('detects staged AI changes without a hash change and saves individual review decisions', async () => {
  await open()
  stored = { ...stored, review: { id: 'r1', path: 'main.tex', baseContent: stored.content, expectedHash: stored.hash, edits: [{ id: 'e1', startLine: 0, endLine: 1, before: stored.content, after: 'Proposed source', status: 'pending' }] } }
  await screen.findByRole('region', { name: 'latex.aiReview' }, { timeout: 3000 })
  expect(screen.queryByLabelText('latex.source')).not.toBeInTheDocument()
  execute.mockImplementationOnce(async (_workspace, request) => {
    expect(request).toMatchObject({ action: 'review', reviewId: 'r1', decision: 'accept', editId: 'e1' })
    stored = { path: 'main.tex', content: 'Proposed source', hash: 'accepted' }
    return { file: stored, project }
  })
  fireEvent.click(screen.getByRole('button', { name: 'latex.acceptChange' }))
  await waitFor(() => expect(screen.getByLabelText('latex.source')).toHaveValue('Proposed source'))
})


it('restores the last PDF and SyncTeX without compiling and keeps it when a later compile fails', async () => {
  cached = { success: true, log: 'Cached build', pdfBase64: 'cached-pdf', builtAt: '2026-09-17T12:00:00Z', stale: false, engine: 'xelatex', synctex: { boxes: [], sourceHashes: { 'main.tex': 'first' } } }
  render(<WorkspaceLatexView workspaceId="ws" active initialProject={project} />)
  await screen.findByText('PDF preview')
  await waitFor(() => expect(screen.getByRole('button', { name: 'latex.goToPdf' })).toBeEnabled())
  expect(execute.mock.calls.some(call => call[1].action === 'compile')).toBe(false)
  expect(screen.getByText('XeLaTeX')).toBeVisible()
  compileResult = { success: false, log: 'Syntax error' }
  fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
  await screen.findByText('latex.compileFailed')
  expect(screen.getByText('PDF preview')).toBeVisible()
  expect(document.querySelector('[data-preview]')).toHaveAttribute('data-preview', 'cached-pdf')
  expect(screen.getByRole('button', { name: 'latex.goToPdf' })).toBeDisabled()
})

it('keeps an out-of-date cached PDF visible while disabling source mapping', async () => {
  cached = { success: true, log: '', pdfBase64: 'old-pdf', stale: true }
  await open()
  await screen.findByText('PDF preview')
  expect(screen.getByText('latex.previewStale')).toBeVisible()
  expect(screen.getByRole('button', { name: 'latex.goToPdf' })).toBeDisabled()
})

it('does not let a delayed cached preview replace a newly compiled PDF', async () => {
  let resolve!: (value: LatexResponse) => void
  previewResponse = new Promise(done => { resolve = done })
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
  await screen.findByText('PDF preview')
  await act(async () => resolve({ compilation: { success: true, log: '', pdfBase64: 'older-cache' } }))
  expect(document.querySelector('[data-preview]')).toHaveAttribute('data-preview', 'cGRm')
})


it('shows folders containing only resources without trying to open binary files as source', async () => {
  await open()
  expect(screen.getByText('figures')).toBeVisible()
  expect(screen.getByText('supplement')).toBeVisible()
  expect(screen.getByTitle('figures/chart.png')).toBeVisible()
  expect(screen.getByTitle('figures/supplement/plot.pdf')).toBeVisible()
  execute.mockClear()
  fireEvent.click(screen.getByTitle('figures/chart.png'))
  await waitFor(() => expect(execute).toHaveBeenCalledWith('ws', { action: 'resource', projectId: 'p', path: 'figures/chart.png' }))
  await waitFor(() => expect(screen.getByTitle('sections/intro.tex')).toBeEnabled())
  fireEvent.click(screen.getByTitle('sections/intro.tex'))
  await waitFor(() => expect(execute).toHaveBeenCalledWith('ws', { action: 'read', projectId: 'p', path: 'sections/intro.tex' }))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('allows typing and file navigation during compilation and marks the delayed PDF stale', async () => {
  const implementation = execute.getMockImplementation()!
  const compilation = deferred<LatexResponse>()
  execute.mockImplementation(async (workspace, request) => {
    if (request.action === 'compile') return compilation.promise
    if (request.action === 'read' && request.path === 'refs.bib') return { file: { path: 'refs.bib', content: '@article{new}', hash: 'bib' } }
    return implementation(workspace, request)
  })
  try {
    const source = await open()
    fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('ws', expect.objectContaining({ action: 'compile' })))
    expect(source).toBeEnabled()
    fireEvent.change(source, { target: { value: 'Written during compile' } })
    fireEvent.click(screen.getByRole('button', { name: 'refs.bib' }))
    await waitFor(() => expect(screen.getByLabelText('latex.source')).toHaveValue('@article{new}'))
    expect(stored.content).toBe('Written during compile')
    await act(async () => compilation.resolve({ compilation: { success: true, log: '', pdfBase64: 'old-snapshot' } }))
    expect(screen.getByText('latex.previewStale')).toBeVisible()
    expect(screen.getByRole('button', { name: 'latex.goToPdf' })).toBeDisabled()
  } finally { execute.mockImplementation(implementation) }
})

it('cancels the original compilation after switching to another project', async () => {
  const implementation = execute.getMockImplementation()!
  const compilation = deferred<LatexResponse>()
  const second = { ...project, id: 'second', title: 'Second paper' }
  execute.mockImplementation(async (workspace, request) => {
    if (request.action === 'list') return { projects: [project, second] }
    if (request.action === 'project' && request.projectId === 'second') return { project: second }
    if (request.action === 'compile') return compilation.promise
    return implementation(workspace, request)
  })
  try {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('ws', expect.objectContaining({ action: 'compile' })))
    fireEvent.click(screen.getByRole('button', { name: 'latex.moreActions' }))
    fireEvent.click(screen.getByRole('button', { name: 'latex.openProject' }))
    fireEvent.click(await screen.findByRole('button', { name: /Second paper/ }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('ws', { action: 'activate', projectId: 'second', path: 'main.tex' }))
    fireEvent.click(screen.getByRole('button', { name: 'latex.cancelCompile' }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('ws', { action: 'cancelCompile', projectId: 'p', compileId: expect.any(String) }))
    await act(async () => compilation.resolve({ compilation: { success: true, log: '', pdfBase64: 'first-project-pdf' } }))
    expect(document.querySelector('[data-preview="first-project-pdf"]')).toBeNull()
  } finally { execute.mockImplementation(implementation) }
})

it('invalidates the preview when another project input changes while the current source is unchanged', async () => {
  const implementation = execute.getMockImplementation()!
  let revision = 'inputs-one'
  cached = { success: true, log: '', pdfBase64: 'cached', stale: false, synctex: { boxes: [], sourceHashes: { 'main.tex': 'first' } } }
  execute.mockImplementation(async (workspace, request) => {
    if (request.action === 'project') return { project: { ...project, inputRevision: revision } }
    return implementation(workspace, request)
  })
  try {
    const source = await open()
    await waitFor(() => expect(screen.getByRole('button', { name: 'latex.goToPdf' })).toBeEnabled())
    revision = 'inputs-two'
    cached = { ...cached, stale: true }
    await screen.findByText('latex.previewStale', {}, { timeout: 3000 })
    expect(source).toHaveValue('Original source')
    expect(screen.getByRole('button', { name: 'latex.goToPdf' })).toBeDisabled()
    expect(execute.mock.calls.filter(([, request]) => request.action === 'preview').length).toBeGreaterThanOrEqual(2)
  } finally { execute.mockImplementation(implementation) }
})

it('keeps a newer recovery draft when an earlier save finishes', async () => {
  const implementation = execute.getMockImplementation()!
  const saving = deferred<LatexResponse>()
  execute.mockImplementation(async (workspace, request) => request.action === 'write' ? saving.promise : implementation(workspace, request))
  try {
    const source = await open()
    fireEvent.change(source, { target: { value: 'First edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.save' }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('ws', expect.objectContaining({ action: 'write', content: 'First edit' })))
    fireEvent.change(source, { target: { value: 'Newer unsaved edit' } })
    await waitFor(() => expect(JSON.parse(localStorage.getItem('refora.latex.draft.ws.p.main.tex') || '{}').content).toBe('Newer unsaved edit'))
    await act(async () => saving.resolve({ file: { path: 'main.tex', content: 'First edit', hash: 'saved-first' } }))
    expect(source).toHaveValue('Newer unsaved edit')
    expect(JSON.parse(localStorage.getItem('refora.latex.draft.ws.p.main.tex') || '{}')).toMatchObject({ content: 'Newer unsaved edit', hash: 'saved-first' })
  } finally { execute.mockImplementation(implementation) }
})

it('keeps the rename form open when the backend rejects the destination', async () => {
  const implementation = execute.getMockImplementation()!
  execute.mockImplementation(async (workspace, request) => {
    if (request.action === 'resource') return { resource: { path: request.path, mimeType: 'text/plain', base64: '', hash: 'first' } }
    if (request.action === 'rename') throw new Error('Destination already exists')
    return implementation(workspace, request)
  })
  try {
    await open()
    fireEvent.click(screen.getAllByRole('button', { name: 'latex.renameFile' })[0])
    fireEvent.change(screen.getByLabelText('latex.filePath'), { target: { value: 'refs.bib' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.applyFileChange' }))
    await screen.findAllByText('Destination already exists')
    expect(screen.getByLabelText('latex.filePath')).toHaveValue('refs.bib')
  } finally { execute.mockImplementation(implementation) }
})

it('restores an accepted-edit snapshot using the latest file hash', async () => {
  const implementation = execute.getMockImplementation()!
  execute.mockImplementation(async (workspace, request) => {
    if (request.action === 'history') return { history: [{ id: 'before-ai', content: 'Before AI edits', createdAt: '2026-09-18T12:00:00Z' }] }
    if (request.action === 'restore') return { project, file: { path: 'main.tex', content: 'Before AI edits', hash: 'restored' } }
    return implementation(workspace, request)
  })
  try {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'latex.moreActions' }))
    fireEvent.click(screen.getByRole('button', { name: 'latex.history' }))
    await screen.findByRole('dialog', { name: 'latex.history' })
    expect(screen.getByText('Before AI edits')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'latex.restoreVersion' }))
    await waitFor(() => expect(screen.getByLabelText('latex.source')).toHaveValue('Before AI edits'))
    expect(execute).toHaveBeenCalledWith('ws', { action: 'restore', projectId: 'p', path: 'main.tex', historyId: 'before-ai', expectedHash: 'first' })
  } finally { execute.mockImplementation(implementation) }
})

it('saves a conflicting draft as a separate project file without overwriting the disk version', async () => {
  const implementation = execute.getMockImplementation()!
  let copy: LatexFile | null = null
  execute.mockImplementation(async (workspace, request) => {
    if (request.action === 'write' && request.path === 'main-recovered.tex') {
      copy = { path: request.path, content: request.content, hash: 'copy' }
      return { file: copy, project: { ...project, files: [...project.files, copy.path] } }
    }
    return implementation(workspace, request)
  })
  try {
    const source = await open()
    fireEvent.change(source, { target: { value: 'My valuable draft' } })
    stored = { ...stored, content: 'External version', hash: 'external' }
    fireEvent.click(screen.getByRole('button', { name: 'latex.save' }))
    await screen.findByText('External update conflict')
    fireEvent.click(screen.getByRole('button', { name: 'latex.resolveConflict' }))
    await screen.findByRole('dialog', { name: 'latex.resolveConflict' })
    fireEvent.click(screen.getByRole('button', { name: 'latex.saveCopy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'latex.currentFile' })).toHaveTextContent('main-recovered.tex'))
    expect(screen.getByLabelText('latex.source')).toHaveValue('My valuable draft')
    expect(stored.content).toBe('External version')
    expect(copy).toMatchObject({ content: 'My valuable draft' })
    expect(execute).toHaveBeenCalledWith('ws', { action: 'write', projectId: 'p', path: 'main-recovered.tex', content: 'My valuable draft', expectedHash: '' })
  } finally { execute.mockImplementation(implementation) }
})

it('does not dispatch a cancelled compilation after its pending save finishes', async () => {
  const implementation = execute.getMockImplementation()!
  const saving = deferred<LatexResponse>()
  execute.mockImplementation(async (workspace, request) => request.action === 'write' ? saving.promise : implementation(workspace, request))
  try {
    const source = await open()
    fireEvent.change(source, { target: { value: 'Save before build' } })
    fireEvent.click(screen.getByRole('button', { name: 'latex.compile' }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('ws', expect.objectContaining({ action: 'write', content: 'Save before build' })))
    fireEvent.click(screen.getByRole('button', { name: 'latex.cancelCompile' }))
    await act(async () => saving.resolve({ file: { path: 'main.tex', content: 'Save before build', hash: 'saved' } }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'latex.cancelCompile' })).not.toBeInTheDocument())
    expect(execute.mock.calls.some(([, request]) => request.action === 'compile')).toBe(false)
    expect(screen.getByLabelText('latex.source')).toHaveValue('Save before build')
  } finally { execute.mockImplementation(implementation) }
})

it('serializes queued save requests and writes the latest draft only once with the new hash', async () => {
  const implementation = execute.getMockImplementation()!
  const first = deferred<LatexResponse>()
  const second = deferred<LatexResponse>()
  let writes = 0
  execute.mockImplementation(async (workspace, request) => {
    if (request.action === 'write') return ++writes === 1 ? first.promise : second.promise
    return implementation(workspace, request)
  })
  try {
    const source = await open()
    fireEvent.change(source, { target: { value: 'First save' } })
    fireEvent.keyDown(source, { key: 's', metaKey: true })
    await waitFor(() => expect(writes).toBe(1))
    fireEvent.change(source, { target: { value: 'Latest save' } })
    fireEvent.keyDown(source, { key: 's', metaKey: true })
    fireEvent.keyDown(source, { key: 's', metaKey: true })
    expect(writes).toBe(1)
    await act(async () => first.resolve({ file: { path: 'main.tex', content: 'First save', hash: 'first-saved' } }))
    await waitFor(() => expect(writes).toBe(2))
    expect(execute).toHaveBeenLastCalledWith('ws', { action: 'write', projectId: 'p', path: 'main.tex', content: 'Latest save', expectedHash: 'first-saved' })
    await act(async () => second.resolve({ file: { path: 'main.tex', content: 'Latest save', hash: 'latest-saved' } }))
    expect(writes).toBe(2)
    expect(screen.getByLabelText('latex.source')).toHaveValue('Latest save')
    expect(localStorage.getItem('refora.latex.draft.ws.p.main.tex')).toBeNull()
  } finally { execute.mockImplementation(implementation) }
})
