import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import WorkspaceLatexView from '../../src/renderer/components/latex/WorkspaceLatexView'
import { flushRendererPersistence } from '../../src/renderer/persistence'
import type { LatexRequest, LatexResponse } from '../../src/shared/latex-types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../src/renderer/components/latex/LatexPdfPreview', () => ({ default: () => <div>PDF preview</div> }))
const project = { id: 'p', title: 'Paper', rootFile: 'main.tex', files: ['main.tex', 'refs.bib'] }
let stored = { path: 'main.tex', content: 'Original source', hash: 'first' }
const execute = vi.fn(async (_workspace: string, request: LatexRequest): Promise<LatexResponse> => {
  if (request.action === 'list') return { projects: [project] }
  if (request.action === 'project' || request.action === 'create') return { project }
  if (request.action === 'read') return { file: { ...stored } }
  if (request.action === 'write') {
    if (request.expectedHash !== stored.hash) throw { code: 'conflict', message: 'External update conflict' }
    stored = { path: request.path, content: request.content, hash: 'saved' }
    return { file: { ...stored } }
  }
  if (request.action === 'compile') return { compilation: { success: true, log: 'Done', pdfBase64: 'cGRm' } }
  return {}
})

beforeEach(() => {
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
    fireEvent.click(screen.getByRole('button', { name: 'latex.reload' }))
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
  expect(execute).toHaveBeenCalledWith('ws', { action: 'compile', projectId: 'p', engine: 'xelatex' })
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

it('combines file navigation and all primary actions in one toolbar', async () => {
  await open()
  const toolbar = document.querySelector('.latex-topbar')!
  expect(toolbar.contains(screen.getByRole('button', { name: 'latex.currentFile' }))).toBe(true)
  expect(toolbar.contains(screen.getByRole('button', { name: 'latex.compile' }))).toBe(true)
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
