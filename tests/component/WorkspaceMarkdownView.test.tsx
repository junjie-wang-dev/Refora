import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { showContextMenu } from '@lobehub/ui'
import WorkspaceMarkdownView from '../../src/renderer/components/workspace/WorkspaceMarkdownView'
import { flushRendererPersistence } from '../../src/renderer/persistence'

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

function renderView(overrides: Partial<React.ComponentProps<typeof WorkspaceMarkdownView>> = {}) {
  const onBack = vi.fn()
  const onUpdate = vi.fn().mockResolvedValue(true)
  const view = render(
    <WorkspaceMarkdownView
      kind="note"
      id="note-1"
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
      expect(mockOpenPdf).toHaveBeenCalledWith('e9e71747-2fd1-4038-ab42-00553e68328c')
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
      expect(onUpdate).toHaveBeenCalledWith('note-1', {
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
      expect(onUpdate).toHaveBeenCalledWith('note-1', {
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

    expect(onUpdate).toHaveBeenCalledWith('note-1', {
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
      expect(onUpdate).toHaveBeenCalledWith('note-1', {
        title: 'Research notes',
        contentMd: 'Updated content'
      })
      expect(screen.getByRole('button', { name: 'workspace.markdownRead' })).toHaveAttribute('aria-pressed', 'true')
    })
    expect(screen.getByText('Updated content')).toBeInTheDocument()
  })

  it('automatically saves changes after 800ms without editor field labels or a save button', async () => {
    vi.useFakeTimers()
    const { onUpdate } = renderView({ initialMode: 'edit' })
    const title = screen.getByRole('textbox', { name: 'workspace.noteTitleLabel' })
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })

    expect(screen.queryByText('workspace.noteTitleLabel')).not.toBeInTheDocument()
    expect(screen.queryByText('workspace.noteContentLabel')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'workspace.noteSave' })).not.toBeInTheDocument()
    expect(title).toHaveClass('bg-transparent', 'border-transparent', 'hover:bg-transparent', 'focus:bg-transparent', 'focus:ring-0', 'focus-visible:outline-none')
    expect(content).toHaveClass('bg-transparent', 'border-transparent', 'hover:bg-transparent', 'focus:bg-transparent', 'focus:ring-0', 'focus-visible:outline-none')

    fireEvent.change(content, { target: { value: 'Autosaved content' } })

    await act(async () => {
      vi.advanceTimersByTime(799)
    })
    expect(onUpdate).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(onUpdate).toHaveBeenCalledWith('note-1', {
      title: 'Research notes',
      contentMd: 'Autosaved content'
    })
  })

  it('queues a newer automatic save until an earlier save finishes', async () => {
    vi.useFakeTimers()
    const { onUpdate } = renderView({ initialMode: 'edit' })
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
    expect(onUpdate).toHaveBeenLastCalledWith('note-1', {
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
    expect(onUpdate).toHaveBeenLastCalledWith('note-1', {
      title: 'Research notes',
      contentMd: 'Second version'
    })

    await act(async () => {
      resolveSecondSave(true)
      await Promise.resolve()
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
})
