import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteThread: vi.fn(),
  fetchThreads: vi.fn(),
  onMenuOpenChange: vi.fn(),
  renameThread: vi.fn(),
  setActiveThreadId: vi.fn(),
  showConfirm: vi.fn(),
  state: {
    activeThreadId: 'thread-12345678' as string | null,
    threads: [] as Array<{
      id: string
      workspaceId: string
      providerId: string
      title?: string
      createdAt: number
    }>
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key
  })
}))

vi.mock('../../src/renderer/hooks/useClickOutside', () => ({
  useClickOutside: vi.fn()
}))

vi.mock('../../src/renderer/store/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...mocks.state,
      deleteThread: mocks.deleteThread,
      fetchThreads: mocks.fetchThreads,
      renameThread: mocks.renameThread,
      setActiveThreadId: mocks.setActiveThreadId
    })
}))

vi.mock('../../src/renderer/store/confirmStore', () => ({
  useConfirmStore: (selector: (state: { show: typeof mocks.showConfirm }) => unknown) =>
    selector({ show: mocks.showConfirm })
}))

import ThreadHistory from '../../src/renderer/components/workspace/ThreadHistory'

const thread = {
  id: 'thread-12345678',
  workspaceId: 'ws-1',
  providerId: 'provider-1',
  title: 'First conversation',
  createdAt: 0
}

function renderHistory(overrides: Partial<React.ComponentProps<typeof ThreadHistory>> = {}) {
  return render(
    <ThreadHistory
      streaming={false}
      onExportThread={vi.fn().mockResolvedValue(undefined)}
      menuOpen
      onMenuOpenChange={mocks.onMenuOpenChange}
      {...overrides}
    />
  )
}

describe('ThreadHistory', () => {
  beforeEach(() => {
    mocks.deleteThread.mockReset().mockResolvedValue(undefined)
    mocks.fetchThreads.mockReset().mockResolvedValue(undefined)
    mocks.onMenuOpenChange.mockReset()
    mocks.renameThread.mockReset().mockResolvedValue(undefined)
    mocks.setActiveThreadId.mockReset()
    mocks.showConfirm.mockReset()
    mocks.state.activeThreadId = thread.id
    mocks.state.threads = [thread]
  })

  afterEach(cleanup)

  it('keeps the thread menu available while streaming', async () => {
    const user = userEvent.setup()
    const { rerender } = renderHistory({ menuOpen: false })

    await user.click(screen.getByRole('button', { name: 'Thread history' }))
    expect(mocks.onMenuOpenChange).toHaveBeenCalledWith(true)

    rerender(
      <ThreadHistory
        streaming
        onExportThread={vi.fn()}
        menuOpen={false}
        onMenuOpenChange={mocks.onMenuOpenChange}
      />
    )
    expect(screen.getByRole('button', { name: 'Thread history' })).toBeEnabled()
  })

  it('allows thread switching while streaming and protects the active thread from deletion', async () => {
    renderHistory({ streaming: true })

    const switchButton = screen.getByRole('button', { name: 'First conversation' })
    expect(switchButton).toBeEnabled()
    fireEvent.click(switchButton)
    expect(mocks.setActiveThreadId).toHaveBeenCalledWith(thread.id)
    expect(mocks.onMenuOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('renders the empty state when there are no threads', () => {
    mocks.state.threads = []
    const { container } = renderHistory()
    expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    expect(container.querySelector('.right-0.top-full')).toBeInTheDocument()
  })

  it('selects and exports the active thread', async () => {
    const user = userEvent.setup()
    const onExportThread = vi.fn().mockResolvedValue(undefined)
    renderHistory({ onExportThread })

    await user.click(screen.getByRole('button', { name: 'First conversation' }))
    expect(mocks.setActiveThreadId).toHaveBeenCalledWith(thread.id)
    expect(mocks.onMenuOpenChange).toHaveBeenCalledWith(false)

    await user.click(screen.getByRole('button', { name: 'Export conversation' }))
    expect(onExportThread).toHaveBeenCalledWith(thread.id)
  })

  it('renames a thread with Enter and cancels with Escape', async () => {
    const user = userEvent.setup()
    renderHistory()

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByDisplayValue('First conversation')
    await user.clear(input)
    await user.type(input, 'Renamed{Enter}')
    expect(mocks.renameThread).toHaveBeenCalledWith(thread.id, 'Renamed')

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    await user.type(screen.getByDisplayValue('First conversation'), '{Escape}')
    expect(mocks.renameThread).toHaveBeenCalledTimes(1)
  })

  it('commits a changed title on blur', async () => {
    const user = userEvent.setup()
    renderHistory()

    await user.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByDisplayValue('First conversation')
    await user.clear(input)
    await user.type(input, 'Blurred title')
    fireEvent.blur(input)

    expect(mocks.renameThread).toHaveBeenCalledWith(thread.id, 'Blurred title')
  })

  it('confirms deletion and refreshes the thread list', async () => {
    const user = userEvent.setup()
    renderHistory()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(mocks.showConfirm).toHaveBeenCalledOnce()
    const request = mocks.showConfirm.mock.calls[0][0] as { onConfirm: () => void }
    request.onConfirm()

    await waitFor(() => {
      expect(mocks.deleteThread).toHaveBeenCalledWith(thread.id)
      expect(mocks.fetchThreads).toHaveBeenCalledOnce()
    })
  })
})
