vi.mock('../../src/renderer/utils/contextMenu', () => ({ showContextMenu: vi.fn() }))
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { showContextMenu } from '../../src/renderer/utils/contextMenu'
import WorkspaceMarkdownView from '../../src/renderer/components/workspace/WorkspaceMarkdownView'
import { useWorkspaceStore } from '../../src/renderer/store/workspaceStore'
import type { WorkspaceNote } from '../../src/shared/ipc-types'
import { flushRendererPersistence, invalidateRendererSettingWrites } from '../../src/renderer/persistence'

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

let testNoteId = ''
let testIndex = 0

beforeEach(() => {
  testNoteId = `markdown-view-${++testIndex}`
})

function renderView(overrides: Partial<React.ComponentProps<typeof WorkspaceMarkdownView>> = {}) {
  const onBack = vi.fn()
  const onUpdate = vi.fn().mockResolvedValue(true)
  const view = render(
    <WorkspaceMarkdownView
      kind="note"
      id={testNoteId}
      title="Research notes"
      contentMd={'# Findings\n\nInitial content'}
      timestamp={1}
      onBack={onBack}
      onUpdate={onUpdate}
      {...overrides}
    />
  )
  return { onBack, onUpdate, ...view }
}

const originalOpenPdf = window.api.documents.openPdf
const mockOpenPdf = vi.fn()

afterEach(() => {
  cleanup()
  invalidateRendererSettingWrites()
  vi.useRealTimers()
  vi.mocked(showContextMenu).mockReset()
  vi.restoreAllMocks()
  window.api.documents.openPdf = originalOpenPdf
})

describe('WorkspaceMarkdownView', () => {
  it('opens a refora document link in the PDF reader', async () => {
    window.api.documents.openPdf = mockOpenPdf
    mockOpenPdf.mockResolvedValue(undefined)
    renderView({
      kind: 'report',
      contentMd: '[3DGUT](refora://doc/e9e71747-2fd1-4038-ab42-00553e68328c)'
    })

    const link = screen.getByRole('button', { name: '3DGUT' })
    expect(link).toHaveClass('cursor-pointer')
    expect(screen.queryByRole('link', { name: '3DGUT' })).not.toBeInTheDocument()
    fireEvent.click(link)

    await waitFor(() => {
      expect(mockOpenPdf).toHaveBeenCalledWith('e9e71747-2fd1-4038-ab42-00553e68328c', false)
    })
  })

  it('keeps regular Markdown links external', () => {
    renderView({ contentMd: '[Example](https://example.com)' })

    expect(screen.getByRole('link', { name: 'Example' })).toHaveAttribute(
      'target',
      '_blank'
    )
  })

  it('provides copy, select-all, and edit actions from the reading context menu', async () => {
    const writeText = vi.spyOn(window.api.clipboard, 'writeText').mockResolvedValue()
    renderView()
    const content = screen.getByText('Initial content')
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(content)
    selection?.removeAllRanges()
    selection?.addRange(range)

    fireEvent.contextMenu(content)

    const items = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      disabled?: boolean
      onClick?: () => void | Promise<void>
    }>
    expect(items.map((item) => item.key)).toEqual(['copy', 'selectAll', 'divider', 'edit'])
    expect(items[0].disabled).toBe(false)

    await act(async () => {
      await items[0].onClick?.()
    })
    expect(writeText).toHaveBeenCalledWith('Initial content')

    selection?.removeAllRanges()
    items[1].onClick?.()
    expect(selection?.toString()).toContain('Research notes')
    expect(selection?.toString()).toContain('Initial content')

    await act(async () => {
      items[3].onClick?.()
      await Promise.resolve()
    })
    expect(screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })).toBeInTheDocument()
  })

  it('keeps the summary reading context menu read-only and disables copy without a selection', () => {
    window.getSelection()?.removeAllRanges()
    renderView({ kind: 'summary', onUpdate: undefined })

    fireEvent.contextMenu(screen.getByText('Initial content'))

    const items = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      disabled?: boolean
    }>
    expect(items.map((item) => item.key)).toEqual(['copy', 'selectAll'])
    expect(items[0].disabled).toBe(true)
  })

  it.each(['note', 'report'] as const)('renders sanitized HTML in a %s', (kind) => {
    const { container } = renderView({
      kind,
      contentMd: '<table><tbody><tr><td>m<sup>2</sup></td></tr></tbody></table><iframe></iframe>'
    })

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('2').tagName).toBe('SUP')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('keeps the fullscreen toolbar draggable while preserving interactive controls', () => {
    renderView({ fullscreen: true })

    const backButton = screen.getByRole('button', { name: 'workspace.navigateBack' })
    expect(backButton.closest('[data-testid="panel-tab-header"]')).toHaveClass('drag-region')
    expect(backButton.closest('[data-testid="panel-tab-leading"]')).toHaveClass('no-drag')
    expect(backButton.closest('[data-testid="panel-tab-actions"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'workspace.navigateForward' })).toBeDisabled()
  })

  it('saves a changed draft before closing the workspace tab', async () => {
    const onClose = vi.fn()
    const { onUpdate } = renderView({ initialMode: 'edit', onClose })
    fireEvent.change(screen.getByRole('textbox', { name: 'workspace.noteContentLabel' }), {
      target: { value: 'Saved before close' }
    })

    fireEvent.click(screen.getByRole('button', { name: 'workspace.close' }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(testNoteId, {
        title: 'Research notes',
        contentMd: 'Saved before close'
      })
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('saves a changed draft before navigating back to the board', async () => {
    const { onBack, onUpdate } = renderView({ initialMode: 'edit' })
    fireEvent.change(screen.getByRole('textbox', { name: 'workspace.noteContentLabel' }), {
      target: { value: 'Saved before navigating back' }
    })

    fireEvent.click(screen.getByRole('button', { name: 'workspace.navigateBack' }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(testNoteId, {
        title: 'Research notes',
        contentMd: 'Saved before navigating back'
      })
      expect(onBack).toHaveBeenCalledTimes(1)
    })
  })

  it('saves a pending draft during a renderer persistence flush', async () => {
    const { onUpdate } = renderView({ initialMode: 'edit' })
    fireEvent.change(screen.getByRole('textbox', { name: 'workspace.noteContentLabel' }), {
      target: { value: 'Saved during flush' }
    })

    await act(async () => {
      await flushRendererPersistence()
    })

    expect(onUpdate).toHaveBeenCalledWith(testNoteId, {
      title: 'Research notes',
      contentMd: 'Saved during flush'
    })
  })

  it('opens in reading mode and exposes a reading/editing switch', () => {
    renderView()

    expect(screen.getByRole('heading', { name: 'Research notes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.markdownRead' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'workspace.markdownEdit' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'workspace.markdownEdit' }))

    expect(screen.getByRole('textbox', { name: 'workspace.noteTitleLabel' })).toHaveValue('Research notes')
    expect(screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })).toHaveValue('# Findings\n\nInitial content')
  })

  it('reconciles an external update when the local draft is clean', () => {
    const onBack = vi.fn()
    const onUpdate = vi.fn().mockResolvedValue(true)
    const { rerender } = render(
      <WorkspaceMarkdownView
        kind="note"
        id={testNoteId}
        title="Original title"
        contentMd="Original content"
        timestamp={1}
        onBack={onBack}
        onUpdate={onUpdate}
      />
    )

    rerender(
      <WorkspaceMarkdownView
        kind="note"
        id={testNoteId}
        title="External title"
        contentMd="External content"
        timestamp={2}
        onBack={onBack}
        onUpdate={onUpdate}
      />
    )

    expect(screen.getByRole('heading', { name: 'External title' })).toBeInTheDocument()
    expect(screen.getByText('External content')).toBeInTheDocument()
  })

  it('protects a dirty draft from an external update until the latest version is reloaded', async () => {
    vi.useFakeTimers()
    const onBack = vi.fn()
    const onUpdate = vi.fn().mockResolvedValue(true)
    const { rerender } = render(
      <WorkspaceMarkdownView
        kind="note"
        id={testNoteId}
        title="Original title"
        contentMd="Original content"
        timestamp={1}
        initialMode="edit"
        onBack={onBack}
        onUpdate={onUpdate}
      />
    )
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })
    fireEvent.change(content, { target: { value: 'Unsaved local content' } })

    rerender(
      <WorkspaceMarkdownView
        kind="note"
        id={testNoteId}
        title="External title"
        contentMd="External content"
        timestamp={2}
        initialMode="edit"
        onBack={onBack}
        onUpdate={onUpdate}
      />
    )

    expect(content).toHaveValue('Unsaved local content')
    expect(screen.getByRole('alert')).toHaveTextContent('workspace.externalUpdateConflict')
    fireEvent.click(screen.getByRole('button', { name: 'workspace.markdownRead' }))
    await act(async () => Promise.resolve())
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'workspace.markdownEdit' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'workspace.reloadExternalUpdate' }))
    expect(screen.getByRole('textbox', { name: 'workspace.noteTitleLabel' })).toHaveValue('External title')
    expect(content).toHaveValue('External content')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('places embedded reader actions inside the Markdown page', () => {
    renderView({ embedded: true })

    const actions = screen.getByTestId('markdown-floating-actions')
    expect(actions).toContainElement(
      screen.getByRole('button', { name: 'workspace.markdownRead' })
    )
    expect(actions).toContainElement(
      screen.getByRole('button', { name: 'workspace.markdownEdit' })
    )
    expect(screen.queryByTestId('panel-tab-header')).not.toBeInTheDocument()
  })

  it('saves a changed draft before returning to reading mode', async () => {
    const { onUpdate } = renderView({ initialMode: 'edit' })
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })
    fireEvent.change(content, { target: { value: 'Updated content' } })

    fireEvent.click(screen.getByRole('button', { name: 'workspace.markdownRead' }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(testNoteId, {
        title: 'Research notes',
        contentMd: 'Updated content'
      })
      expect(screen.getByRole('button', { name: 'workspace.markdownRead' })).toHaveAttribute('aria-pressed', 'true')
    })
    expect(screen.getByText('Updated content')).toBeInTheDocument()
  })

  it('automatically saves changes after 800ms with editor tools and save feedback', async () => {
    vi.useFakeTimers()
    const { onUpdate } = renderView({ initialMode: 'edit' })
    await act(async () => { await Promise.resolve() })
    const title = screen.getByRole('textbox', { name: 'workspace.noteTitleLabel' })
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })

    expect(screen.queryByText('workspace.noteTitleLabel')).not.toBeInTheDocument()
    expect(screen.queryByText('workspace.noteContentLabel')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'workspace.noteSave' })).not.toBeInTheDocument()
    expect(title).toHaveClass('bg-transparent', 'border-transparent', 'hover:bg-transparent', 'focus:bg-transparent', 'focus:ring-0', 'focus-visible:outline-none')
    expect(content).toHaveAttribute('spellcheck', 'false')
    expect(screen.getByRole('toolbar', { name: 'markdown.editor.toolbar' })).toBeInTheDocument()
    expect(screen.queryByText('markdown.saveState.saved')).not.toBeInTheDocument()

    fireEvent.change(content, { target: { value: 'Autosaved content' } })

    await act(async () => {
      vi.advanceTimersByTime(799)
    })
    expect(onUpdate).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(onUpdate).toHaveBeenCalledWith(testNoteId, {
      title: 'Research notes',
      contentMd: 'Autosaved content'
    })
  })

  it('queues a newer automatic save until an earlier save finishes', async () => {
    vi.useFakeTimers()
    const { onUpdate } = renderView({ initialMode: 'edit' })
    await act(async () => { await Promise.resolve() })
    let resolveFirstSave: (saved: boolean) => void = () => undefined
    let resolveSecondSave: (saved: boolean) => void = () => undefined
    onUpdate
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
        resolveFirstSave = resolve
      }))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
        resolveSecondSave = resolve
      }))
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })

    fireEvent.change(content, { target: { value: 'First version' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(onUpdate).toHaveBeenLastCalledWith(testNoteId, {
      title: 'Research notes',
      contentMd: 'First version'
    })

    fireEvent.change(content, { target: { value: 'Second version' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(onUpdate).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstSave(true)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onUpdate).toHaveBeenLastCalledWith(testNoteId, {
      title: 'Research notes',
      contentMd: 'Second version'
    })

    await act(async () => {
      resolveSecondSave(true)
      await Promise.resolve()
    })
  })

  it('accepts its own report save feedback while keeping a newer draft editable', async () => {
    vi.useFakeTimers()
    let resolveFirstSave: (saved: boolean) => void = () => undefined
    const onUpdate = vi.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveFirstSave = resolve
    })).mockResolvedValue(true)
    const props = {
      kind: 'report' as const,
      id: 'report-1',
      title: 'Report',
      timestamp: 1,
      initialMode: 'edit' as const,
      onBack: vi.fn(),
      onUpdate
    }
    const { rerender } = render(
      <WorkspaceMarkdownView {...props} contentMd="Initial" />
    )
    await act(async () => { await Promise.resolve() })
    const content = screen.getByRole('textbox', { name: 'workspace.reportContentLabel' })

    fireEvent.change(content, { target: { value: 'First version' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    fireEvent.change(content, { target: { value: 'Second version' } })

    rerender(<WorkspaceMarkdownView {...props} contentMd="First version" timestamp={2} />)
    await act(async () => {
      resolveFirstSave(true)
      await Promise.resolve()
    })

    expect(content).toHaveValue('Second version')
    expect(screen.queryByText('workspace.externalUpdateConflict')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(onUpdate).toHaveBeenLastCalledWith('report-1', {
      title: 'Report',
      contentMd: 'Second version'
    })
  })

  it('keeps the draft open when returning to reading mode cannot save it', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false)
    renderView({ initialMode: 'edit', onUpdate })
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })
    fireEvent.change(content, { target: { value: 'Unsaved content' } })

    fireEvent.click(screen.getByRole('button', { name: 'workspace.markdownRead' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('workspace.noteSaveFailed')
    })
    expect(content).toHaveValue('Unsaved content')
    expect(screen.getByRole('button', { name: 'workspace.markdownEdit' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows a paper AI summary as a read-only reader without editor controls', () => {
    renderView({
      kind: 'summary',
      title: 'Paper title',
      contentMd: 'Core summary\n\n## Key Points\n\n- Point one',
      onUpdate: undefined
    })

    expect(screen.getByText('Core summary')).toBeInTheDocument()
    expect(screen.getByText('Point one')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.navigateBack' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'workspace.markdownEdit' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('panel-tab-actions')).not.toBeInTheDocument()
  })

  it('retains the draft when the actual note store rolls back an optimistic save, then retries', async () => {
    const originalState = useWorkspaceStore.getState()
    const note: WorkspaceNote = {
      id: testNoteId, workspaceId: 'workspace-markdown-test', noteType: 'markdown',
      color: 'sand', title: 'Store note', contentMd: 'Persisted body', createdAt: 1, updatedAt: 1
    }
    let rejectSave!: (error: Error) => void
    const updateApi = vi.spyOn(window.api.workspaceNotes, 'update')
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject }))
      .mockImplementation(async (_id, patch) => ({ ...note, ...patch, updatedAt: 2 }))
    useWorkspaceStore.setState({ activeWorkspaceId: note.workspaceId, notes: [note] })
    function StoredNote() {
      const current = useWorkspaceStore((state) => state.notes.find((entry) => entry.id === note.id)!)
      const update = useWorkspaceStore((state) => state.updateNote)
      return <WorkspaceMarkdownView kind="note" id={current.id} title={current.title} contentMd={current.contentMd} timestamp={current.updatedAt} initialMode="edit" onBack={vi.fn()} onUpdate={update} />
    }
    try {
      render(<StoredNote />)
      const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })
      fireEvent.change(content, { target: { value: 'Writing that must survive' } })
      fireEvent.click(screen.getByRole('button', { name: 'workspace.markdownRead' }))
      await waitFor(() => expect(updateApi).toHaveBeenCalledTimes(1))
      expect(useWorkspaceStore.getState().notes[0].contentMd).toBe('Writing that must survive')
      expect(screen.getByText('markdown.saveState.saving')).toHaveAttribute('role', 'status')
      await act(async () => { rejectSave(new Error('Disk unavailable')); await Promise.resolve() })
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('workspace.noteSaveFailed'))
      expect(useWorkspaceStore.getState().notes[0].contentMd).toBe('Persisted body')
      expect(content).toHaveValue('Writing that must survive')
      fireEvent.click(screen.getByRole('button', { name: 'markdown.retrySave' }))
      await waitFor(() => expect(screen.queryByText('markdown.saveState.saving')).not.toBeInTheDocument())
      expect(screen.queryByText('markdown.saveState.saved')).not.toBeInTheDocument()
      expect(useWorkspaceStore.getState().notes[0].contentMd).toBe('Writing that must survive')
      expect(content).toHaveValue('Writing that must survive')
    } finally {
      cleanup()
      useWorkspaceStore.setState(originalState)
    }
  })

  it('keeps closing pending until text entered during the first save is also confirmed', async () => {
    let resolveFirst!: (saved: boolean) => void
    let resolveSecond!: (saved: boolean) => void
    const onUpdate = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveSecond = resolve }))
    const onClose = vi.fn()
    renderView({ initialMode: 'edit', onClose, onUpdate })
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })
    fireEvent.change(content, { target: { value: 'First draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'workspace.close' }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    fireEvent.change(content, { target: { value: 'New text during save' } })
    await act(async () => { resolveFirst(true); await Promise.resolve() })
    expect(onClose).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenLastCalledWith(testNoteId, { title: 'Research notes', contentMd: 'New text during save' })
    await act(async () => { resolveSecond(true); await Promise.resolve() })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('previews unsaved Markdown alongside the editor and renders the saved draft in reading mode', async () => {
    const { onUpdate } = renderView({ initialMode: 'edit' })
    fireEvent.click(screen.getByRole('button', { name: 'markdown.livePreview' }))
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })
    fireEvent.change(content, { target: { value: '## Live section\n\n**Preview text**' } })
    expect(screen.getByRole('heading', { name: 'Live section' })).toBeInTheDocument()
    expect(screen.getByText('Preview text').tagName).toBe('STRONG')
    expect(onUpdate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'workspace.markdownRead' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'workspace.markdownRead' })).toHaveAttribute('aria-pressed', 'true'))
    expect(onUpdate).toHaveBeenCalledWith(testNoteId, { title: 'Research notes', contentMd: '## Live section\n\n**Preview text**' })
    expect(screen.getByRole('heading', { name: 'Live section' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'workspace.noteContentLabel' })).not.toBeInTheDocument()
  })

  it('compares conflicting versions and preserves the local draft in history when loading external content', async () => {
    const onUpdate = vi.fn().mockResolvedValue(true)
    const onBack = vi.fn()
    const props = { kind: 'note' as const, id: testNoteId, title: 'Research notes', timestamp: 1, initialMode: 'edit' as const, onBack, onUpdate }
    const { rerender } = render(<WorkspaceMarkdownView {...props} contentMd="Original body" />)
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })
    fireEvent.change(content, { target: { value: 'Local draft to keep' } })
    rerender(<WorkspaceMarkdownView {...props} contentMd="External body" timestamp={2} />)
    fireEvent.click(screen.getByRole('button', { name: 'markdown.compareVersions' }))
    const comparison = screen.getByRole('dialog', { name: 'markdown.compareVersions' })
    expect(within(comparison).getByText('Local draft to keep')).toBeInTheDocument()
    expect(within(comparison).getByText('External body')).toBeInTheDocument()
    fireEvent.click(within(comparison).getByRole('button', { name: 'workspace.reloadExternalUpdate' }))
    expect(content).toHaveValue('External body')
    fireEvent.click(screen.getByRole('button', { name: 'markdown.versionHistory' }))
    const history = screen.getByRole('dialog', { name: 'markdown.versionHistory' })
    expect(within(history).getByText('Local draft to keep')).toBeInTheDocument()
    fireEvent.click(within(history).getByRole('button', { name: 'markdown.restoreVersion' }))
    expect(content).toHaveValue('Local draft to keep')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('offers recovered drafts without silently overwriting a changed saved document', async () => {
    vi.spyOn(window.api.settings, 'get').mockImplementation(async (key, fallback) => (
      key === `markdown.document.note.${testNoteId}` ? {
        draft: { title: 'Recovered title', contentMd: 'Recovered body' },
        base: { title: 'Earlier title', contentMd: 'Earlier body' }, history: []
      } : fallback
    ) as never)
    const { onUpdate } = renderView({ initialMode: 'edit' })
    await waitFor(() => expect(screen.getByText('markdown.draftRecovered')).toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })).toHaveValue('Recovered body')
    expect(screen.getByRole('alert')).toHaveTextContent('workspace.externalUpdateConflict')
    fireEvent.click(screen.getByRole('button', { name: 'markdown.compareVersions' }))
    const comparison = screen.getByRole('dialog', { name: 'markdown.compareVersions' })
    fireEvent.click(within(comparison).getByRole('button', { name: 'markdown.keepLocalVersion' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onUpdate).toHaveBeenCalledWith(testNoteId, { title: 'Recovered title', contentMd: 'Recovered body' })
  })

  it('copies the selected historical version and preserves current content when restoring it', async () => {
    const current = { title: 'Research notes', contentMd: '# Findings\n\nInitial content' }
    vi.spyOn(window.api.settings, 'get').mockImplementation(async (key, fallback) => (
      key === `markdown.document.note.${testNoteId}` ? {
        draft: current, base: current,
        history: [
          { id: 'recent-version', title: 'Recent version', contentMd: 'Recent historical body', createdAt: 2000, reason: 'saved' },
          { id: 'older-version', title: 'Older version', contentMd: 'Historical text to copy', createdAt: 1000, reason: 'saved' }
        ]
      } : fallback
    ) as never)
    const writeText = vi.spyOn(window.api.clipboard, 'writeText').mockResolvedValue()
    const { onUpdate } = renderView({ initialMode: 'edit' })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'markdown.versionHistory' }))
    const history = screen.getByRole('dialog', { name: 'markdown.versionHistory' })
    fireEvent.click(within(history).getByRole('button', { name: /Older version/ }))
    expect(within(history).getByText('Historical text to copy')).toBeInTheDocument()
    fireEvent.click(within(history).getByRole('button', { name: 'markdown.copyMarkdown' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Older version\n\nHistorical text to copy'))
    expect(screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })).toHaveValue(current.contentMd)
    fireEvent.click(within(history).getByRole('button', { name: 'markdown.restoreVersion' }))
    expect(screen.getByRole('textbox', { name: 'workspace.noteTitleLabel' })).toHaveValue('Older version')
    expect(screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })).toHaveValue('Historical text to copy')
    fireEvent.click(screen.getByRole('button', { name: 'markdown.versionHistory' }))
    const restoredHistory = screen.getByRole('dialog', { name: 'markdown.versionHistory' })
    expect(within(restoredHistory).getByRole('button', { name: /Research notes/ })).toBeInTheDocument()
    expect(within(restoredHistory).getByText(current.contentMd, { normalizer: (text) => text })).toBeInTheDocument()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('puts outline first, keeps search in the toolbar and hides idle save feedback', async () => {
    const { container } = renderView({ embedded: true })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'markdown.findDocument' })).toBeInTheDocument())
    const toolbar = container.querySelector('.markdown-workspace-toolbar')!
    expect(within(toolbar as HTMLElement).getAllByRole('button')[0]).toHaveAccessibleName('markdown.outline')
    expect(within(toolbar as HTMLElement).getByRole('search')).toBeInTheDocument()
    expect(screen.queryByText('markdown.saveState.saved')).not.toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'markdown.findDocument' })
    expect(input).not.toHaveFocus()
    fireEvent.keyDown(container.querySelector('[data-markdown-surface]')!, { key: 'f', metaKey: true })
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.change(input, { target: { value: 'Initial' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(input).not.toHaveFocus()
    expect(screen.getByRole('search')).toBeInTheDocument()
  })

  it('navigates a source outline without enabling live preview and retains the wide sidebar', async () => {
    renderView({ initialMode: 'edit', contentMd: 'Introduction\n============\n\n## **Results**\n\n```md\n# Not a heading\n```\n\nReference[^1]\n\n[^1]: Source' })
    await screen.findByRole('textbox', { name: 'workspace.noteContentLabel' })
    fireEvent.click(screen.getByRole('button', { name: 'markdown.outline' }))
    const outline = screen.getByRole('navigation')
    expect(within(outline).queryByRole('button', { name: 'Not a heading' })).not.toBeInTheDocument()
    expect(within(outline).queryByRole('button', { name: 'Footnotes' })).not.toBeInTheDocument()
    expect(within(outline).getByRole('button', { name: 'Introduction' })).toBeInTheDocument()
    fireEvent.click(within(outline).getByRole('button', { name: 'Results' }))
    const editor = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' }) as HTMLTextAreaElement
    expect(editor).toHaveFocus()
    expect(editor.selectionStart).toBe(27)
    expect(screen.getByRole('button', { name: 'markdown.livePreview' })).toHaveAttribute('aria-pressed', 'false')
    expect(outline).toBeInTheDocument()
  })

  it('expands compact search on demand and closes the overlay after heading navigation', async () => {
    const original = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { this.callback([{ target, contentRect: { width: 340 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver
    try {
      renderView({ embedded: true })
      expect(screen.queryByRole('search')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'markdown.findDocument' }))
      const input = screen.getByRole('textbox', { name: 'markdown.findDocument' })
      expect(input).toHaveFocus()
      fireEvent.change(input, { target: { value: 'Initial' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByRole('search')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'markdown.outline' }))
      expect(screen.getByRole('navigation')).toHaveClass('is-overlay')
      fireEvent.click(screen.getByRole('button', { name: 'Findings' }))
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    } finally { globalThis.ResizeObserver = original }
  })

})
