import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import WorkspaceLatexDialog from '../../src/renderer/components/workspace/WorkspaceLatexDialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const state = vi.hoisted(() => ({ latexProjects: [], items: [], fetchLatexProjects: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/renderer/store/workspaceStore', () => ({ useWorkspaceStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }))
afterEach(cleanup)

it('keeps the import report visible until skipped files have been acknowledged', async () => {
  const project = { id: 'imported', title: 'Imported', rootFile: 'main.tex', files: ['main.tex'] }
  const execute = window.api.latex.execute
  window.api.latex.execute = vi.fn().mockResolvedValue({ project, importReport: { imported: ['main.tex'], skipped: ['data/unsupported.xyz'] } })
  const onClose = vi.fn()
  const onCreated = vi.fn()
  try {
    render(<WorkspaceLatexDialog workspaceId="ws" placement={{ x: 0, y: 0 }} onClose={onClose} onCreated={onCreated} onOpen={vi.fn().mockResolvedValue(undefined)} />)
    fireEvent.click(screen.getByRole('button', { name: 'latex.import' }))
    await screen.findByRole('status')
    expect(onCreated).toHaveBeenCalledWith(project)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('latex.skippedFiles'))
    expect(screen.getByText('data/unsupported.xyz')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'latex.done' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  } finally { window.api.latex.execute = execute }
})
