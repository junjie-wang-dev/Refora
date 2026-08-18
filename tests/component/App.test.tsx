import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  documentState: {
    focusedDocId: null as string | null,
    selectedIds: [] as string[],
    listMode: { mode: 'all' } as { mode: string },
    init: vi.fn(),
    destroy: vi.fn()
  },
  workspaceState: {
    activeWorkspaceId: 'ws-1' as string | null,
    panelOpen: true,
    fullscreen: false,
    chatStreaming: false,
    init: vi.fn(),
    destroy: vi.fn()
  },
  ocrReaderState: {
    documentId: null as string | null,
    close: vi.fn()
  },
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
  documentListRender: vi.fn(),
  workspacePanelRender: vi.fn(),
  resizeObserverCallback: null as ResizeObserverCallback | null
}))

class ResizeObserverTestMock {
  constructor(callback: ResizeObserverCallback) {
    mocks.resizeObserverCallback = callback
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('@lobehub/ui', () => ({
  ContextMenuHost: () => null,
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('antd', () => ({
  theme: {
    darkAlgorithm: {},
    defaultAlgorithm: {}
  }
}))

vi.mock('@renderer/hooks/useAppShortcuts', () => ({
  useAppShortcuts: vi.fn()
}))

vi.mock('@renderer/hooks/useTheme', () => ({
  AppThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({ mode: 'system', resolvedTheme: 'light' })
}))

vi.mock('@renderer/theme/tokens', () => ({
  getAntdTokenOverrides: () => ({})
}))

vi.mock('@renderer/store/documentStore', () => ({
  useDocumentStore: Object.assign(
    (selector: (state: typeof mocks.documentState) => unknown) => selector(mocks.documentState),
    { getState: () => mocks.documentState }
  )
}))

vi.mock('@renderer/store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: typeof mocks.workspaceState) => unknown) => selector(mocks.workspaceState),
    { getState: () => mocks.workspaceState }
  )
}))

vi.mock('@renderer/store/ocrReaderStore', () => ({
  useOcrReaderStore: Object.assign(
    (selector: (state: typeof mocks.ocrReaderState) => unknown) => selector(mocks.ocrReaderState),
    { getState: () => mocks.ocrReaderState }
  )
}))

vi.mock('@renderer/ipc', () => ({
  api: {
    settings: {
      get: mocks.settingsGet,
      set: mocks.settingsSet
    }
  }
}))

vi.mock('@renderer/components/GlobalSearch', () => ({
  default: ({ documentListOpen }: { documentListOpen?: boolean }) => (
    <div
      data-testid="global-search"
      data-document-list-open={documentListOpen ? 'true' : 'false'}
    />
  )
}))
vi.mock('@renderer/components/Sidebar', () => ({
  default: ({ collapsed }: { collapsed: boolean }) => (
    <div data-testid={collapsed ? 'collapsed-sidebar-toolbar' : 'sidebar'} />
  )
}))
vi.mock('@renderer/components/DocumentList', () => ({
  default: ({
    compact,
    onClose,
    onDocumentFocus
  }: {
    compact: boolean
    onClose?: () => void
    onDocumentFocus?: () => void
  }) => {
    mocks.documentListRender()
    return (
      <div data-testid="document-list" data-compact={compact ? 'true' : 'false'}>
        {onClose ? <button type="button" onClick={onClose}>document-tab-close</button> : null}
        <button type="button" onClick={onDocumentFocus}>document-row</button>
      </div>
    )
  }
}))
vi.mock('@renderer/components/DetailPanel', () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <div data-testid="detail-panel">
      <button type="button" onClick={onClose}>detail-tab-close</button>
    </div>
  )
}))
vi.mock('@renderer/components/StructuredDocumentPanel', () => ({
  default: () => <div data-testid="structured-document-panel" />
}))
vi.mock('@renderer/components/workspace/WorkspacePanel', () => ({
  default: () => {
    mocks.workspacePanelRender()
    return <div data-testid="workspace-panel" />
  }
}))
vi.mock('@renderer/components/workspace/ChatPanel', () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <div data-testid="chat-panel">
      {onClose ? <button type="button" onClick={onClose}>chat-tab-close</button> : null}
    </div>
  )
}))
vi.mock('@renderer/components/ResizeDivider', () => ({
  default: ({
    onResize,
    onResizeStart,
    onResizeEnd,
    variant = 'line'
  }: {
    onResize: (delta: number) => void
    onResizeStart?: () => void
    onResizeEnd?: () => void
    variant?: string
  }) => (
    <button
      type="button"
      data-testid="resize-divider"
      data-variant={variant}
      onMouseDown={onResizeStart}
      onMouseUp={onResizeEnd}
      onClick={(event) => onResize(Number(event.currentTarget.dataset.resizeDelta ?? 0))}
    />
  )
}))
vi.mock('@renderer/components/ConfirmDialog', () => ({
  default: () => null
}))
vi.mock('@renderer/components/FirstRunWizard', () => ({
  default: () => <div data-testid="first-run-wizard" />
}))
vi.mock('@renderer/components/ui', () => ({
  Toast: () => null
}))

import App from '@renderer/App'
import { useChatDraftStore } from '@renderer/store/chatDraftStore'

function resizeDivider(divider: HTMLElement, delta: number) {
  divider.dataset.resizeDelta = String(delta)
  fireEvent.mouseDown(divider)
  fireEvent.click(divider)
  fireEvent.mouseUp(divider)
}

function rectWithWidth(width: number): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({})
  }
}

describe('App root layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.documentState.focusedDocId = null
    mocks.documentState.selectedIds = []
    mocks.documentState.listMode = { mode: 'all' }
    mocks.workspaceState.activeWorkspaceId = 'ws-1'
    mocks.workspaceState.panelOpen = true
    mocks.workspaceState.fullscreen = false
    mocks.workspaceState.chatStreaming = false
    mocks.resizeObserverCallback = null
    mocks.settingsGet.mockImplementation((_key: string, fallback: unknown) => Promise.resolve(fallback))
    mocks.settingsSet.mockResolvedValue(undefined)
    useChatDraftStore.setState({ pending: null })
    vi.stubGlobal('ResizeObserver', ResizeObserverTestMock)
  })

  afterEach(() => {
    cleanup()
    useChatDraftStore.setState({ pending: null })
    vi.unstubAllGlobals()
  })

  it('keeps the sidebar outside the search bar and all main panels below it', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const mainLayer = screen.getByTestId('app-main-layer')
    const topBar = screen.getByTestId('app-top-bar')
    const panelLayer = screen.getByTestId('app-panel-layer')

    expect(mainLayer).toHaveClass('flex', 'flex-1', 'flex-col')
    expect(topBar.parentElement).toBe(mainLayer)
    expect(topBar).toHaveClass('drag-region', 'h-12', 'shrink-0')
    expect(topBar).not.toHaveClass('z-[60]', 'border-b')
    expect(within(topBar).getByTestId('app-top-bar-separator')).toHaveStyle({
      background: 'linear-gradient(to right, var(--color-background), var(--color-border) 100px)'
    })
    expect(panelLayer).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden')
    expect(within(topBar).getByTestId('global-search')).toBeInTheDocument()
    expect(within(topBar).getByTestId('global-search')).toHaveAttribute('data-document-list-open', 'true')
    expect(within(topBar).getByRole('button', { name: 'workspace.chat.closePanel' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('app-sidebar-layer')).toContainElement(screen.getByTestId('sidebar'))
    expect(within(mainLayer).queryByTestId('sidebar')).not.toBeInTheDocument()
    expect(within(panelLayer).getByTestId('document-list')).toBeInTheDocument()
    expect(within(panelLayer).getByTestId('detail-panel')).toBeInTheDocument()
    expect(within(panelLayer).getByTestId('workspace-panel')).toBeInTheDocument()
    expect(within(panelLayer).getByTestId('chat-panel')).toBeInTheDocument()
    expect(within(panelLayer).getAllByTestId('resize-divider').length).toBeGreaterThan(0)
    expect(within(topBar).queryByTestId('resize-divider')).not.toBeInTheDocument()
    expect(topBar.compareDocumentPosition(panelLayer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await waitFor(() => expect(mocks.documentState.init).toHaveBeenCalled())
  })

  it('places the workspace canvas and AI chat at the app panel level and toggles chat from the root bar', () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const workspacePanel = screen.getByTestId('app-workspace-panel')
    const chatPanel = screen.getByTestId('app-chat-panel')
    const primaryPanels = screen.getByTestId('app-primary-panels')
    expect(primaryPanels).toContainElement(workspacePanel)
    expect(primaryPanels.parentElement).toBe(chatPanel.parentElement)
    expect(primaryPanels).toHaveClass('min-w-0', 'flex-1', 'overflow-hidden')
    expect(chatPanel).toHaveClass('min-w-0', 'shrink-0')

    fireEvent.click(screen.getByRole('button', { name: 'workspace.chat.closePanel' }))
    expect(screen.queryByTestId('app-chat-panel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'workspace.chat.openPanel' }))
    expect(screen.getByTestId('app-chat-panel')).toBeInTheDocument()
  })

  it('opens AI chat from the root bar when no workspace is selected', () => {
    mocks.workspaceState.activeWorkspaceId = null
    mocks.workspaceState.panelOpen = false

    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const openButton = screen.getByRole('button', { name: 'workspace.chat.openPanel' })
    expect(openButton).toBeEnabled()
    expect(screen.queryByTestId('app-chat-panel')).not.toBeInTheDocument()

    fireEvent.click(openButton)

    expect(screen.getByTestId('app-chat-panel')).toBeInTheDocument()
  })

  it('opens AI chat when the PDF reader requests a selection draft', () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'workspace.chat.closePanel' }))
    expect(screen.queryByTestId('app-chat-panel')).not.toBeInTheDocument()

    act(() => {
      useChatDraftStore.getState().request({
        mode: 'prefill',
        text: 'Explain the selected passage'
      })
    })

    expect(screen.getByTestId('app-chat-panel')).toBeInTheDocument()
  })

  it('renders one separator at each adjacent panel boundary', async () => {
    const view = render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const workspacePanel = screen.getByTestId('app-workspace-panel')
    expect(within(primaryPanels).getAllByTestId('resize-divider')).toHaveLength(1)
    expect(workspacePanel).not.toHaveClass('border-l')

    mocks.documentState.focusedDocId = 'doc-1'
    view.rerender(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    await waitFor(() => {
      const detailPanelContainer = screen.getByTestId('detail-panel').parentElement?.parentElement
      expect(detailPanelContainer).not.toHaveClass('border-l')
      expect(workspacePanel).toHaveClass('border-l', 'border-border/50')
    })
    expect(within(primaryPanels).getAllByTestId('resize-divider')).toHaveLength(1)
  })

  it('closes AI chat from its tab and reopens it from the root bar', () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'chat-tab-close' }))
    expect(screen.queryByTestId('app-chat-panel')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.chat.openPanel' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'workspace.chat.openPanel' }))
    expect(screen.getByTestId('app-chat-panel')).toBeInTheDocument()
  })

  it('reopens the detail panel when the focused document row is clicked again', async () => {
    mocks.documentState.focusedDocId = 'doc-1'
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const detailPanelContainer = screen.getByTestId('detail-panel').parentElement?.parentElement
    await waitFor(() => expect(detailPanelContainer).toHaveStyle({ width: '384px' }))

    fireEvent.click(screen.getByRole('button', { name: 'detail-tab-close' }))
    expect(detailPanelContainer).toHaveStyle({ width: '0px' })

    fireEvent.click(screen.getByRole('button', { name: 'document-row' }))
    expect(detailPanelContainer).toHaveStyle({ width: '384px' })
  })

  it('closes a compact document list and reopens it when a library view is selected', async () => {
    const view = render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    await waitFor(() => expect(screen.getByTestId('document-list')).toHaveAttribute('data-compact', 'true'))
    expect(screen.getByTestId('global-search')).toHaveAttribute('data-document-list-open', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'document-tab-close' }))
    expect(screen.queryByTestId('app-document-list-panel')).not.toBeInTheDocument()
    expect(screen.getByTestId('global-search')).toHaveAttribute('data-document-list-open', 'false')

    mocks.documentState.listMode = { mode: 'starred' }
    view.rerender(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)
    await waitFor(() => expect(screen.getByTestId('app-document-list-panel')).toBeInTheDocument())
    expect(screen.getByTestId('global-search')).toHaveAttribute('data-document-list-open', 'true')
  })

  it('switches the document list between compact and expanded states at resize thresholds', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentList = screen.getByTestId('document-list')
    const documentListPanel = screen.getByTestId('app-document-list-panel')
    const workspacePanel = screen.getByTestId('app-workspace-panel')
    vi.spyOn(workspacePanel, 'getBoundingClientRect').mockReturnValue(rectWithWidth(700))
    await waitFor(() => expect(documentList).toHaveAttribute('data-compact', 'true'))
    expect(documentListPanel).toHaveStyle({ width: '320px' })

    let divider = within(primaryPanels).getByTestId('resize-divider')
    resizeDivider(divider, 39)
    expect(documentList).toHaveAttribute('data-compact', 'true')
    expect(documentListPanel).toHaveStyle({ width: '359px' })

    divider = within(primaryPanels).getByTestId('resize-divider')
    divider.dataset.resizeDelta = '1'
    fireEvent.mouseDown(divider)
    fireEvent.click(divider)
    expect(documentList).toHaveAttribute('data-compact', 'false')
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'line')
    fireEvent.mouseUp(divider)
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'soft')

    vi.spyOn(documentListPanel, 'getBoundingClientRect')
      .mockReturnValueOnce(rectWithWidth(321))
      .mockReturnValue(rectWithWidth(320))
    divider = within(primaryPanels).getByTestId('resize-divider')
    divider.dataset.resizeDelta = '-1'
    fireEvent.mouseDown(divider)
    fireEvent.click(divider)
    expect(documentList).toHaveAttribute('data-compact', 'true')
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'soft')
    fireEvent.mouseUp(divider)
    expect(documentListPanel).toHaveStyle({ width: '320px' })
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'line')
  })

  it('can use all available width after expanding during the same drag', async () => {
    const view = render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentList = screen.getByTestId('document-list')
    const documentListPanel = screen.getByTestId('app-document-list-panel')
    vi.spyOn(screen.getByTestId('app-workspace-panel'), 'getBoundingClientRect')
      .mockReturnValue(rectWithWidth(1000))
    await waitFor(() => expect(documentList).toHaveAttribute('data-compact', 'true'))

    const divider = within(primaryPanels).getByTestId('resize-divider')
    fireEvent.mouseDown(divider)
    divider.dataset.resizeDelta = '40'
    fireEvent.click(divider)
    expect(documentList).toHaveAttribute('data-compact', 'false')

    divider.dataset.resizeDelta = '2000'
    fireEvent.click(divider)
    expect(documentListPanel).toHaveStyle({ width: '1020px' })
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'line')

    fireEvent.mouseUp(divider)
    expect(screen.getByTestId('app-workspace-panel')).toHaveStyle({ width: '300px' })
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'soft')

    mocks.workspaceState.panelOpen = false
    view.rerender(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)
    await waitFor(() => expect(screen.queryByTestId('app-workspace-panel')).not.toBeInTheDocument())

    mocks.workspaceState.panelOpen = true
    view.rerender(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)
    await waitFor(() => expect(documentList).toHaveAttribute('data-compact', 'true'))
    expect(documentListPanel).toHaveStyle({ width: '360px' })
  })

  it('keeps the compact state when the expanded layout has no stable room', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentList = screen.getByTestId('document-list')
    const documentListPanel = screen.getByTestId('app-document-list-panel')
    const workspacePanel = screen.getByTestId('app-workspace-panel')
    vi.spyOn(workspacePanel, 'getBoundingClientRect').mockReturnValue(rectWithWidth(300))
    await waitFor(() => expect(documentList).toHaveAttribute('data-compact', 'true'))

    resizeDivider(within(primaryPanels).getByTestId('resize-divider'), 40)

    expect(documentList).toHaveAttribute('data-compact', 'true')
    expect(documentListPanel).toHaveStyle({ width: '320px' })
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'line')
  })

  it('finishes the layout switch when the derived workspace width is unchanged', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentList = screen.getByTestId('document-list')
    vi.spyOn(screen.getByTestId('app-workspace-panel'), 'getBoundingClientRect')
      .mockReturnValue(rectWithWidth(840))
    await waitFor(() => expect(documentList).toHaveAttribute('data-compact', 'true'))

    const divider = within(primaryPanels).getByTestId('resize-divider')
    divider.dataset.resizeDelta = '40'
    fireEvent.mouseDown(divider)
    fireEvent.click(divider)
    expect(documentList).toHaveAttribute('data-compact', 'false')
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'line')

    fireEvent.mouseUp(divider)

    expect(screen.getByTestId('app-workspace-panel')).toHaveStyle({ width: '800px' })
    expect(within(primaryPanels).getByTestId('resize-divider')).toHaveAttribute('data-variant', 'soft')
  })

  it('accounts for the additional divider before expanding beside an open detail panel', async () => {
    mocks.documentState.focusedDocId = 'doc-1'
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentList = screen.getByTestId('document-list')
    vi.spyOn(screen.getByTestId('app-workspace-panel'), 'getBoundingClientRect')
      .mockReturnValue(rectWithWidth(301))
    await waitFor(() => {
      expect(documentList).toHaveAttribute('data-compact', 'true')
      expect(screen.getByTestId('detail-panel').parentElement?.parentElement).toHaveStyle({
        width: '384px'
      })
    })

    resizeDivider(within(primaryPanels).getByTestId('resize-divider'), 40)

    expect(documentList).toHaveAttribute('data-compact', 'true')
    expect(within(primaryPanels).getAllByTestId('resize-divider')).toHaveLength(1)
  })

  it('preserves the workspace minimum while resizing a compact document list', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentListPanel = screen.getByTestId('app-document-list-panel')
    vi.spyOn(documentListPanel, 'getBoundingClientRect').mockReturnValue(rectWithWidth(300))
    vi.spyOn(screen.getByTestId('app-workspace-panel'), 'getBoundingClientRect')
      .mockReturnValue(rectWithWidth(300))
    await waitFor(() => expect(screen.getByTestId('document-list')).toHaveAttribute('data-compact', 'true'))

    resizeDivider(within(primaryPanels).getByTestId('resize-divider'), 1000)

    expect(screen.getByTestId('document-list')).toHaveAttribute('data-compact', 'true')
    expect(documentListPanel).toHaveStyle({ width: '300px' })
  })

  it('returns to compact mode after a large expanded-state resize', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentList = screen.getByTestId('document-list')
    const documentListPanel = screen.getByTestId('app-document-list-panel')
    const workspacePanel = screen.getByTestId('app-workspace-panel')
    vi.spyOn(workspacePanel, 'getBoundingClientRect').mockReturnValue(rectWithWidth(700))
    await waitFor(() => expect(documentList).toHaveAttribute('data-compact', 'true'))
    resizeDivider(within(primaryPanels).getByTestId('resize-divider'), 40)
    expect(documentList).toHaveAttribute('data-compact', 'false')

    resizeDivider(within(primaryPanels).getByTestId('resize-divider'), -1000)

    expect(documentList).toHaveAttribute('data-compact', 'true')
    expect(documentListPanel).toHaveStyle({ width: '280px' })
  })

  it('returns to compact mode after the workspace reaches its maximum width', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentList = screen.getByTestId('document-list')
    const documentListPanel = screen.getByTestId('app-document-list-panel')
    const workspacePanel = screen.getByTestId('app-workspace-panel')
    vi.spyOn(workspacePanel, 'getBoundingClientRect').mockReturnValue(rectWithWidth(1200))
    await waitFor(() => expect(documentList).toHaveAttribute('data-compact', 'true'))
    resizeDivider(within(primaryPanels).getByTestId('resize-divider'), 40)
    expect(documentList).toHaveAttribute('data-compact', 'false')

    vi.spyOn(documentListPanel, 'getBoundingClientRect').mockReturnValue(rectWithWidth(800))
    const divider = within(primaryPanels).getByTestId('resize-divider')
    divider.dataset.resizeDelta = '-1000'
    fireEvent.mouseDown(divider)
    fireEvent.click(divider)

    expect(workspacePanel).toHaveStyle({ width: '1200px' })
    expect(documentList).toHaveAttribute('data-compact', 'true')
    fireEvent.mouseUp(divider)
    expect(documentListPanel).toHaveStyle({ width: '280px' })
  })

  it('returns to compact mode when layout changes squeeze an expanded document list', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const primaryPanels = screen.getByTestId('app-primary-panels')
    const documentList = screen.getByTestId('document-list')
    vi.spyOn(screen.getByTestId('app-workspace-panel'), 'getBoundingClientRect')
      .mockReturnValue(rectWithWidth(700))
    await waitFor(() => expect(documentList).toHaveAttribute('data-compact', 'true'))

    const compactDivider = within(primaryPanels).getByTestId('resize-divider')
    resizeDivider(compactDivider, 40)
    expect(documentList).toHaveAttribute('data-compact', 'false')

    act(() => {
      mocks.resizeObserverCallback?.([], {} as ResizeObserver)
    })
    expect(documentList).toHaveAttribute('data-compact', 'false')

    const documentListPanel = screen.getByTestId('app-document-list-panel')
    vi.spyOn(documentListPanel, 'getBoundingClientRect').mockReturnValue({
      bottom: 0,
      height: 0,
      left: 0,
      right: 280,
      top: 0,
      width: 280,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    act(() => {
      mocks.resizeObserverCallback?.([], {} as ResizeObserver)
    })
    expect(documentList).toHaveAttribute('data-compact', 'true')
    expect(documentListPanel).toHaveStyle({ width: '280px' })
  })

  it('resizes the compact document list without rerendering the workspace during the drag', async () => {
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const documentListPanel = screen.getByTestId('app-document-list-panel')
    vi.spyOn(screen.getByTestId('app-workspace-panel'), 'getBoundingClientRect')
      .mockReturnValue(rectWithWidth(700))
    const divider = within(screen.getByTestId('app-primary-panels')).getByTestId('resize-divider')
    await waitFor(() => expect(screen.getByTestId('document-list')).toHaveAttribute('data-compact', 'true'))

    fireEvent.mouseDown(divider)
    const renderCountBeforeMove = mocks.workspacePanelRender.mock.calls.length
    divider.dataset.resizeDelta = '30'
    fireEvent.click(divider)

    expect(documentListPanel).toHaveStyle({ width: '350px' })
    expect(mocks.workspacePanelRender).toHaveBeenCalledTimes(renderCountBeforeMove)

    fireEvent.mouseUp(divider)
    expect(documentListPanel).toHaveStyle({ width: '350px' })
    expect(mocks.workspacePanelRender.mock.calls.length).toBeGreaterThan(renderCountBeforeMove)
  })

  it('resizes the detail panel without rerendering the document list during the drag', async () => {
    mocks.documentState.focusedDocId = 'doc-1'
    mocks.workspaceState.activeWorkspaceId = null
    mocks.workspaceState.panelOpen = false
    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const detailPanel = screen.getByTestId('detail-panel').parentElement?.parentElement as HTMLElement
    await waitFor(() => expect(detailPanel).toHaveStyle({ width: '384px' }))
    const divider = within(screen.getByTestId('app-primary-panels')).getByTestId('resize-divider')
    const renderCountBeforeDrag = mocks.documentListRender.mock.calls.length

    fireEvent.mouseDown(divider)
    divider.dataset.resizeDelta = '30'
    fireEvent.click(divider)

    expect(detailPanel).toHaveStyle({ width: '354px' })
    expect(mocks.documentListRender).toHaveBeenCalledTimes(renderCountBeforeDrag)

    fireEvent.mouseUp(divider)
    expect(detailPanel).toHaveStyle({ width: '354px' })
    expect(mocks.documentListRender.mock.calls.length).toBeGreaterThan(renderCountBeforeDrag)
  })

  it('keeps the root bar visible above a fullscreen workspace', () => {
    mocks.workspaceState.fullscreen = true

    render(<App listColumnState={null} sidebarCollapsed={false} firstRun={false} />)

    const topBar = screen.getByTestId('app-top-bar')
    const panelLayer = screen.getByTestId('app-panel-layer')
    expect(within(topBar).getByTestId('global-search')).toBeInTheDocument()
    expect(screen.queryByTestId('app-sidebar-layer')).not.toBeInTheDocument()
    expect(within(panelLayer).getByTestId('workspace-panel')).toBeInTheDocument()
    expect(within(panelLayer).queryByTestId('document-list')).not.toBeInTheDocument()
  })

  it('places the collapsed sidebar toolbar inside the root top bar', () => {
    render(<App listColumnState={null} sidebarCollapsed firstRun={false} />)

    const topBar = screen.getByTestId('app-top-bar')
    expect(within(topBar).getByTestId('collapsed-sidebar-toolbar')).toBeInTheDocument()
    expect(within(topBar).getByTestId('global-search')).toBeInTheDocument()
    expect(screen.queryByTestId('app-sidebar-layer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
  })
})
