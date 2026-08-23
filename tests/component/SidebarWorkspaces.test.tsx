import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../../src/shared/ipc-types'

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
  renameWorkspace: vi.fn(),
  requestActiveWorkspace: vi.fn(),
  showConfirm: vi.fn(),
  showContextMenu: vi.fn(),
  state: {
    activeWorkspaceId: 'ws-1' as string | null,
    chatStreaming: false,
    workspaces: [] as Workspace[]
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@lobehub/ui', () => ({
  showContextMenu: mocks.showContextMenu
}))

vi.mock('../../src/renderer/store/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...mocks.state,
      createWorkspace: mocks.createWorkspace,
      deleteWorkspace: mocks.deleteWorkspace,
      fetchWorkspaces: mocks.fetchWorkspaces,
      renameWorkspace: mocks.renameWorkspace,
      requestActiveWorkspace: mocks.requestActiveWorkspace
    })
}))

vi.mock('../../src/renderer/store/confirmStore', () => ({
  useConfirmStore: (selector: (state: { show: typeof mocks.showConfirm }) => unknown) =>
    selector({ show: mocks.showConfirm })
}))

import SidebarWorkspaces from '../../src/renderer/components/SidebarWorkspaces'

const workspaces: Workspace[] = [
  { id: 'ws-1', name: 'Research', createdAt: 1, updatedAt: 1 },
  { id: 'ws-2', name: 'Reading', createdAt: 2, updatedAt: 2 }
]

describe('SidebarWorkspaces', () => {
  beforeEach(() => {
    mocks.createWorkspace.mockReset().mockResolvedValue(workspaces[0])
    mocks.deleteWorkspace.mockReset().mockResolvedValue(undefined)
    mocks.fetchWorkspaces.mockReset().mockResolvedValue(undefined)
    mocks.renameWorkspace.mockReset().mockResolvedValue(undefined)
    mocks.requestActiveWorkspace.mockReset().mockResolvedValue(true)
    mocks.showConfirm.mockReset()
    mocks.showContextMenu.mockReset()
    mocks.state.activeWorkspaceId = 'ws-1'
    mocks.state.chatStreaming = false
    mocks.state.workspaces = workspaces
  })

  afterEach(cleanup)

  it('fetches workspaces and renders the empty state', () => {
    mocks.state.workspaces = []
    render(<SidebarWorkspaces />)
    expect(mocks.fetchWorkspaces).toHaveBeenCalledOnce()
    expect(screen.getByText('sidebar.emptyWorkspaces')).toBeInTheDocument()
  })

  it('creates a trimmed workspace and cancels a second draft', async () => {
    const user = userEvent.setup()
    render(<SidebarWorkspaces />)

    await user.click(screen.getByRole('button', { name: 'sidebar.createWorkspace' }))
    const input = screen.getByPlaceholderText('sidebar.workspaceName')
    await user.type(input, '  New workspace  {Enter}')
    await waitFor(() => expect(mocks.createWorkspace).toHaveBeenCalledWith('New workspace'))

    await user.click(screen.getByRole('button', { name: 'sidebar.createWorkspace' }))
    await user.type(screen.getByPlaceholderText('sidebar.workspaceName'), '{Escape}')
    expect(screen.queryByPlaceholderText('sidebar.workspaceName')).not.toBeInTheDocument()
  })

  it('selects workspaces and disables switching while another chat streams', () => {
    mocks.state.chatStreaming = true
    render(<SidebarWorkspaces />)

    const active = screen.getByRole('button', { name: 'Research' })
    const other = screen.getByRole('button', { name: 'Reading' })
    fireEvent.click(active)
    expect(mocks.requestActiveWorkspace).toHaveBeenCalledWith('ws-1')
    expect(active).toHaveClass('sidebar-item-active')
    expect(other).toHaveAttribute('aria-disabled', 'true')
  })

  it('exposes create through the section context menu', () => {
    render(<SidebarWorkspaces />)
    fireEvent.contextMenu(screen.getByText('sidebar.workspaces').parentElement as HTMLElement)

    const items = mocks.showContextMenu.mock.calls[0][0] as Array<{
      key: string
      onClick: () => void
    }>
    expect(items.map((item) => item.key)).toEqual(['create'])
    act(() => items[0].onClick())
    expect(screen.getByPlaceholderText('sidebar.workspaceName')).toBeInTheDocument()
  })

  it('renames a workspace from its context menu', async () => {
    const user = userEvent.setup()
    render(<SidebarWorkspaces />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Research' }))

    const items = mocks.showContextMenu.mock.calls[0][0] as Array<{
      key: string
      onClick: () => void
    }>
    act(() => items.find((item) => item.key === 'rename')?.onClick())
    const input = screen.getByDisplayValue('Research')
    await user.clear(input)
    await user.type(input, 'Renamed{Enter}')

    await waitFor(() => {
      expect(mocks.renameWorkspace).toHaveBeenCalledWith('ws-1', 'Renamed')
    })
  })

  it('commits a changed workspace name on blur', async () => {
    const user = userEvent.setup()
    render(<SidebarWorkspaces />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Research' }))
    const items = mocks.showContextMenu.mock.calls[0][0] as Array<{
      key: string
      onClick: () => void
    }>
    act(() => items.find((item) => item.key === 'rename')?.onClick())

    const input = screen.getByDisplayValue('Research')
    await user.clear(input)
    await user.type(input, 'Blurred')
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.renameWorkspace).toHaveBeenCalledWith('ws-1', 'Blurred'))
  })

  it('confirms workspace deletion from the item context menu', async () => {
    render(<SidebarWorkspaces />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Research' }))
    const items = mocks.showContextMenu.mock.calls[0][0] as Array<{
      key: string
      onClick: () => void
    }>
    act(() => items.find((item) => item.key === 'delete')?.onClick())

    const request = mocks.showConfirm.mock.calls[0][0] as { onConfirm: () => void }
    request.onConfirm()
    await waitFor(() => expect(mocks.deleteWorkspace).toHaveBeenCalledWith('ws-1'))
  })
})
