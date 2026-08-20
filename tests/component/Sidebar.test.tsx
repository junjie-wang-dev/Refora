import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ListFilter, Category, Document, ReforaApi } from '../../src/shared/ipc-types'

const defaultCategories: Category[] = [
  { id: 'cat1', name: 'ML', sortOrder: 0, createdAt: 0, count: 5 },
  { id: 'cat2', name: 'NLP', sortOrder: 1, createdAt: 0, count: 3 },
  { id: 'cat3', name: 'Vision', sortOrder: 2, createdAt: 0, count: 7 },
]

const mocks = vi.hoisted(() => {
  const setListMode = vi.fn()
  const fetchCategories = vi.fn()
  const createCategory = vi.fn()
  const renameCategory = vi.fn()
  const deleteCategory = vi.fn()
  const fetchDocuments = vi.fn()

  const state: Record<string, unknown> = {
    categories: [] as Category[],
    listMode: { mode: 'all' } as ListFilter,
    focusedDocId: null as string | null,
    selectedIds: [] as string[],
    documents: [] as Document[],
    documentCounts: { all: 0, recentlyRead: 0, recentlyAdded: 0, starred: 0 },
    importProgress: null as { current: number; total: number } | null,
    identifierImporting: 0 as number,
    setListMode,
    fetchCategories,
    createCategory,
    renameCategory,
    deleteCategory,
    fetchDocuments,
    showToast: vi.fn(),
  }

  return { setListMode, fetchCategories, createCategory, renameCategory, deleteCategory, fetchDocuments, state }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: () => new Promise<void>(() => {}) },
  }),
}))

vi.mock('@renderer/store/documentStore', () => ({
  useDocumentStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(mocks.state) : mocks.state),
    {
      getState: () => mocks.state,
      setState: (partial: Record<string, unknown>) => void Object.assign(mocks.state, partial),
    }
  ),
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

vi.mock('../../src/renderer/hooks/useTheme', () => ({
  useTheme: () => ({ mode: 'system', resolvedTheme: 'light', setMode: vi.fn() })
}))

vi.mock('../../src/renderer/components/SettingsModal', () => ({
  default: vi.fn(() => null)
}))

vi.mock('../../src/renderer/components/AccountModal', () => ({
  default: vi.fn(() => null)
}))

vi.mock('../../src/renderer/components/ImportByIdentifierDialog', () => ({
  default: vi.fn(() => null)
}))

import Sidebar from '../../src/renderer/components/Sidebar'
import AccountModal from '../../src/renderer/components/AccountModal'
import SettingsModal from '../../src/renderer/components/SettingsModal'
import { useSyncAccountStore } from '../../src/renderer/store/syncAccountStore'

const renderSidebar = () => render(<Sidebar collapsed={false} onToggleCollapse={vi.fn()} />)
const api = (window as unknown as { api: ReforaApi }).api

describe('Sidebar', () => {
  let authConfirmationCallback: ((payload: {
    status: 'confirmed' | 'error'
    message: string | null
  }) => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.categories = defaultCategories
    mocks.state.listMode = { mode: 'all' }
    mocks.state.focusedDocId = null
    mocks.state.documents = []
    mocks.state.documentCounts = { all: 0, recentlyRead: 0, recentlyAdded: 0, starred: 0 }
    mocks.state.importProgress = null
    mocks.state.identifierImporting = 0
    useSyncAccountStore.setState({
      status: null,
      loading: false,
      loadFailed: false,
      confirmation: null
    })
    api.events.onSyncAuthConfirmation = vi.fn((cb) => {
      authConfirmationCallback = cb
    })
    api.sync.status = vi.fn().mockResolvedValue({
      configured: true,
      syncAvailable: false,
      signedIn: false,
      enabled: false,
      state: 'signedOut',
      account: null
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders all smart list items', () => {
    renderSidebar()
    expect(screen.getByText('sidebar.allFiles')).toBeInTheDocument()
    expect(screen.getByText('sidebar.recentlyRead')).toBeInTheDocument()
    expect(screen.getByText('sidebar.recentlyAdded')).toBeInTheDocument()
    expect(screen.getByText('sidebar.starred')).toBeInTheDocument()
  })

  it('opens the dedicated account window from the sidebar account entry', async () => {
    const user = userEvent.setup()
    renderSidebar()

    await user.click(screen.getByRole('button', { name: 'sidebar.account.open' }))

    expect(vi.mocked(AccountModal).mock.calls.some(([props]) => (
      props.open
    ))).toBe(true)
    expect(vi.mocked(SettingsModal).mock.calls.some(([props]) => props.open)).toBe(false)
  })

  it('shows the signed-in email and sync state in the sidebar footer', async () => {
    api.sync.status = vi.fn().mockResolvedValue({
      configured: true,
      syncAvailable: false,
      signedIn: true,
      enabled: false,
      state: 'disabled',
      account: { id: 'user-1', email: 'reader@example.com' }
    })

    renderSidebar()

    expect(await screen.findByText('reader@example.com')).toBeInTheDocument()
    expect(screen.getByText('sidebar.account.syncUnavailable')).toBeInTheDocument()
  })

  it('opens the account window when macOS delivers an auth confirmation link', () => {
    renderSidebar()

    act(() => {
      authConfirmationCallback?.({ status: 'confirmed', message: null })
    })

    expect(useSyncAccountStore.getState().confirmation).toEqual({
      status: 'confirmed',
      message: null
    })
    expect(vi.mocked(AccountModal).mock.calls.some(([props]) => props.open)).toBe(true)
  })

  it('shows the per-mode document count on every smart list item', () => {
    mocks.state.documentCounts = { all: 12, recentlyRead: 4, recentlyAdded: 2, starred: 1 }
    renderSidebar()

    const itemFor = (label: string) =>
      screen.getByText(label).closest('[class*="sidebar-item"]') as HTMLElement

    expect(itemFor('sidebar.allFiles').textContent).toContain('12')
    expect(itemFor('sidebar.recentlyRead').textContent).toContain('4')
    expect(itemFor('sidebar.recentlyAdded').textContent).toContain('2')
    expect(itemFor('sidebar.starred').textContent).toContain('1')
  })

  it('does not render native titles for the top toolbar actions', () => {
    renderSidebar()

    expect(screen.getByLabelText('tooltip.collapseSidebar')).not.toHaveAttribute('title')
    expect(screen.getByLabelText('tooltip.addFile')).not.toHaveAttribute('title')
    expect(screen.getByLabelText('tooltip.importFromIdentifier')).not.toHaveAttribute('title')
  })

  it('renders the collapsed toolbar in its current parent', () => {
    const { container } = render(<Sidebar collapsed onToggleCollapse={vi.fn()} />)

    const toolbar = container.querySelector('.sidebar-floating-toolbar')
    expect(toolbar).toBeInTheDocument()
    expect(toolbar).toHaveStyle({ left: '8px' })
    expect(screen.getByLabelText('tooltip.expandSidebar')).toBeInTheDocument()
    expect(screen.getByLabelText('tooltip.addFile')).toBeInTheDocument()
    expect(screen.getByLabelText('tooltip.importFromIdentifier')).toBeInTheDocument()
  })

  it('calls setListMode with { mode: "all" } when All Files is clicked', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByText('sidebar.allFiles'))
    expect(mocks.setListMode).toHaveBeenCalledWith({ mode: 'all' })
  })

  it('renders categories section with names and counts', () => {
    renderSidebar()
    expect(screen.getByText('sidebar.categories')).toBeInTheDocument()
    expect(screen.getByText('ML').closest('[class*="sidebar-item"]')).toHaveTextContent('5')
    expect(screen.getByText('NLP').closest('[class*="sidebar-item"]')).toHaveTextContent('3')
    expect(screen.getByText('Vision').closest('[class*="sidebar-item"]')).toHaveTextContent('7')
  })

  it('shows empty state placeholder when categories array is empty', () => {
    mocks.state.categories = []
    renderSidebar()
    expect(screen.getByText('sidebar.emptyCategories')).toBeInTheDocument()
    expect(screen.queryByText('ML')).not.toBeInTheDocument()
  })

  it('shows an inline input when the create-category button is clicked', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByLabelText('sidebar.createCategory'))
    expect(screen.getByPlaceholderText('sidebar.categoryName')).toBeInTheDocument()
  })

  it('creates a category when typing and pressing Enter in the inline input', async () => {
    const user = userEvent.setup()
    mocks.createCategory.mockResolvedValue({ id: 'new', name: 'Foo', sortOrder: 0, createdAt: 0 })
    renderSidebar()
    await user.click(screen.getByLabelText('sidebar.createCategory'))
    const input = screen.getByPlaceholderText('sidebar.categoryName')
    await user.type(input, 'Foo{Enter}')
    await waitFor(() => expect(mocks.createCategory).toHaveBeenCalledWith('Foo'))
  })

  it('cancels inline create on Escape without creating', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByLabelText('sidebar.createCategory'))
    const input = screen.getByPlaceholderText('sidebar.categoryName')
    await user.type(input, 'Bar{Escape}')
    expect(mocks.createCategory).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('sidebar.categoryName')).not.toBeInTheDocument()
  })

  it('calls setListMode with category mode and correct categoryId on category click', async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByText('ML'))
    expect(mocks.setListMode).toHaveBeenCalledWith({ mode: 'category', categoryId: 'cat1' })
  })

  it('applies sidebar-item-active class to the active smart list item', () => {
    mocks.state.listMode = { mode: 'starred' }
    renderSidebar()

    const starredItem = screen.getByText('sidebar.starred').closest('[class*="sidebar-item"]')
    expect(starredItem).toHaveClass('sidebar-item-active')

    const allFilesItem = screen.getByText('sidebar.allFiles').closest('[class*="sidebar-item"]')
    expect(allFilesItem).not.toHaveClass('sidebar-item-active')
  })

  it('applies sidebar-item-active class to the active category item', () => {
    mocks.state.listMode = { mode: 'category', categoryId: 'cat2' }
    renderSidebar()

    const nlpItem = screen.getByText('NLP').closest('[class*="sidebar-item"]')
    expect(nlpItem).toHaveClass('sidebar-item-active')

    const mlItem = screen.getByText('ML').closest('[class*="sidebar-item"]')
    expect(mlItem).not.toHaveClass('sidebar-item-active')
  })
})
