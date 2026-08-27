import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Document, GlobalSearchResult, LibrarySwitchResult, ReforaApi } from '@shared/ipc-types'

const mocks = vi.hoisted(() => ({
  setSearchResults: vi.fn(),
  setFocusedDoc: vi.fn(),
  clearSearch: vi.fn(),
  openPdf: vi.fn(),
  showToast: vi.fn(),
  requestActiveWorkspace: vi.fn(),
  openPanel: vi.fn(),
  openMarkdownCard: vi.fn(),
  setActiveThreadId: vi.fn(),
  documentStoreSubscriber: null as null | ((
    state: { isSearching: boolean },
    previousState: { isSearching: boolean }
  ) => void),
  documentStoreSubscribe: vi.fn(),
  documentSearchState: {
    isSearching: false,
    searchQuery: ''
  },
  workspaceState: {
    activeWorkspaceId: 'ws-current',
    chatStreaming: false
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/store/documentStore', () => ({
  useDocumentStore: Object.assign(
    (selector: (state: {
      setSearchResults: typeof mocks.setSearchResults
      setFocusedDoc: typeof mocks.setFocusedDoc
      clearSearch: typeof mocks.clearSearch
      openPdf: typeof mocks.openPdf
      showToast: typeof mocks.showToast
    }) => unknown) => selector({
      setSearchResults: mocks.setSearchResults,
      setFocusedDoc: mocks.setFocusedDoc,
      clearSearch: mocks.clearSearch,
      openPdf: mocks.openPdf,
      showToast: mocks.showToast
    }),
    {
      subscribe: mocks.documentStoreSubscribe,
      getState: () => ({
        ...mocks.documentSearchState,
        setSearchResults: mocks.setSearchResults,
        setFocusedDoc: mocks.setFocusedDoc,
        clearSearch: mocks.clearSearch,
        openPdf: mocks.openPdf,
        showToast: mocks.showToast
      })
    }
  )
}))

vi.mock('@renderer/store/workspaceStore', () => {
  const getState = () => ({
    activeWorkspaceId: mocks.workspaceState.activeWorkspaceId,
    chatStreaming: mocks.workspaceState.chatStreaming,
    requestActiveWorkspace: mocks.requestActiveWorkspace,
    openPanel: mocks.openPanel,
    openMarkdownCard: mocks.openMarkdownCard,
    setActiveThreadId: mocks.setActiveThreadId
  })
  return {
    useWorkspaceStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    )
  }
})

import GlobalSearch from '@renderer/components/GlobalSearch'

const paper = {
  id: 'paper-1',
  fileName: 'transformer.pdf',
  title: 'Transformer Research',
  authors: 'Ada Lovelace',
  year: '2025',
  venue: 'NeurIPS'
} as Document

const results: GlobalSearchResult = {
  documents: [paper],
  workspaceFiles: [{
    id: 'asset-1',
    workspaceId: 'ws-files',
    workspaceName: 'Experiments',
    fileName: 'transformer-data.csv',
    mimeType: 'text/csv',
    previewKind: 'text',
    fileMissing: 0,
    updatedAt: 10
  }],
  workspaceContents: [{
    id: 'report-1',
    workspaceId: 'ws-content',
    workspaceName: 'Synthesis',
    kind: 'report',
    title: 'Transformer synthesis',
    snippet: 'Sparse transformer attention improves scaling.',
    matchedAt: 15
  }],
  chats: [{
    threadId: 'thread-1',
    workspaceId: 'ws-chat',
    workspaceName: 'Reading notes',
    title: 'Transformer discussion',
    snippet: 'What is sparse attention?',
    role: 'user',
    matchedAt: 20
  }]
}

const api = window.api as ReforaApi
const originalGlobalSearch = api.search.global
const originalOpenAsset = api.workspaceAssets.open
const originalOnLibrarySwitched = api.events.onLibrarySwitched
let librarySwitchedCallback: ((payload: LibrarySwitchResult) => void) | null = null

describe('GlobalSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.workspaceState.activeWorkspaceId = 'ws-current'
    mocks.workspaceState.chatStreaming = false
    mocks.documentSearchState.isSearching = false
    mocks.documentSearchState.searchQuery = ''
    mocks.setSearchResults.mockImplementation((query: string) => {
      mocks.documentSearchState.isSearching = true
      mocks.documentSearchState.searchQuery = query
    })
    mocks.clearSearch.mockImplementation(() => {
      mocks.documentSearchState.isSearching = false
      mocks.documentSearchState.searchQuery = ''
    })
    mocks.requestActiveWorkspace.mockResolvedValue(true)
    mocks.documentStoreSubscriber = null
    mocks.documentStoreSubscribe.mockImplementation((callback) => {
      mocks.documentStoreSubscriber = callback
      return vi.fn()
    })
    librarySwitchedCallback = null
    api.search.global = vi.fn().mockResolvedValue(results)
    api.workspaceAssets.open = vi.fn().mockResolvedValue(undefined)
    api.events.onLibrarySwitched = vi.fn((callback) => {
      librarySwitchedCallback = callback
      return vi.fn()
    })
  })

  afterEach(() => {
    cleanup()
    api.search.global = originalGlobalSearch
    api.workspaceAssets.open = originalOpenAsset
    api.events.onLibrarySwitched = originalOnLibrarySwitched
  })

  it('renders above every panel and groups every result type', async () => {
    const { container } = render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })

    expect(container.firstElementChild).toHaveClass(
      'absolute',
      'left-1/2',
      'top-2.5',
      '-translate-x-1/2',
      'z-[60]',
      'isolate',
      'no-drag',
      'pointer-events-auto'
    )
    expect(container.firstElementChild).not.toHaveClass('fixed', 'pointer-events-none', 'inset-x-0')
    expect(input).toHaveClass('h-7', 'rounded-lg', 'bg-background')
    expect(screen.queryByText('⌘F')).not.toBeInTheDocument()
    fireEvent.mouseDown(input.parentElement as HTMLElement)
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'transformer' } })

    await waitFor(() => expect(api.search.global).toHaveBeenCalledWith('transformer'))
    expect(await screen.findByText('globalSearch.papers · 1')).toBeInTheDocument()
    expect(screen.getByRole('listbox')).toHaveClass('bg-panel')
    expect(screen.getByRole('listbox')).not.toHaveClass('bg-panel/95', 'backdrop-blur-xl')
    expect(screen.getByText('globalSearch.workspaceFiles · 1')).toBeInTheDocument()
    expect(screen.getByText('globalSearch.workspaceContents · 1')).toBeInTheDocument()
    expect(screen.getByText('globalSearch.chats · 1')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'globalSearch.openPaper: Transformer Research' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'globalSearch.openWorkspaceFile: transformer-data.csv' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'globalSearch.openWorkspaceContent: Transformer synthesis' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'globalSearch.openChat: Transformer discussion' })).toBeInTheDocument()
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      'global-search-option-document-paper-1'
    )
    expect(screen.getByRole('option', {
      name: 'globalSearch.openPaper: Transformer Research'
    })).toHaveAttribute('id', 'global-search-option-document-paper-1')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute(
      'aria-activedescendant',
      'global-search-option-workspaceFile-asset-1'
    )
  })

  it('focuses papers without opening PDFs and synchronizes the document list search state', async () => {
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })
    const option = await screen.findByRole('option', { name: 'globalSearch.openPaper: Transformer Research' })

    fireEvent.click(option)

    expect(mocks.setSearchResults).toHaveBeenCalledWith('transformer', [paper])
    expect(mocks.setFocusedDoc).toHaveBeenCalledWith('paper-1')
    expect(mocks.openPdf).not.toHaveBeenCalled()
  })

  it('synchronizes paper results as soon as they resolve while the document list is open', async () => {
    render(<GlobalSearch documentListOpen />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })

    fireEvent.change(input, { target: { value: 'Junjie' } })

    await waitFor(() => expect(mocks.setSearchResults).toHaveBeenCalledWith('Junjie', [paper]))
    expect(mocks.openPdf).not.toHaveBeenCalled()
  })

  it('does not replace the hidden document list while global results resolve', async () => {
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })

    fireEvent.change(input, { target: { value: 'Junjie' } })

    await screen.findByText('globalSearch.papers · 1')
    expect(mocks.setSearchResults).not.toHaveBeenCalled()
  })

  it('clears the global query when the synchronized document list clears its search', async () => {
    render(<GlobalSearch documentListOpen />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'Junjie' } })
    await waitFor(() => expect(mocks.setSearchResults).toHaveBeenCalledWith('Junjie', [paper]))

    act(() => {
      mocks.documentStoreSubscriber?.(
        { isSearching: false },
        { isSearching: true }
      )
    })

    expect(input).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('navigates workspace file, workspace content, and chat results to their owning workspaces', async () => {
    const onOpenChat = vi.fn()
    render(<GlobalSearch onOpenChat={onOpenChat} />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })
    const fileOption = await screen.findByRole('option', { name: 'globalSearch.openWorkspaceFile: transformer-data.csv' })

    fireEvent.click(fileOption)
    await waitFor(() => {
      expect(mocks.requestActiveWorkspace).toHaveBeenCalledWith('ws-files')
      expect(api.workspaceAssets.open).toHaveBeenCalledWith('asset-1')
    })

    fireEvent.focus(input)
    const contentOption = await screen.findByRole('option', {
      name: 'globalSearch.openWorkspaceContent: Transformer synthesis'
    })
    fireEvent.click(contentOption)

    await waitFor(() => {
      expect(mocks.requestActiveWorkspace).toHaveBeenCalledWith('ws-content')
      expect(mocks.openMarkdownCard).toHaveBeenCalledWith('report', 'report-1')
    })

    fireEvent.focus(input)
    const chatOption = await screen.findByRole('option', { name: 'globalSearch.openChat: Transformer discussion' })
    fireEvent.click(chatOption)

    await waitFor(() => {
      expect(mocks.requestActiveWorkspace).toHaveBeenCalledWith('ws-chat')
      expect(mocks.setActiveThreadId).toHaveBeenCalledWith('thread-1')
      expect(onOpenChat).toHaveBeenCalledOnce()
    })
  })

  it('opens a global chat result without opening an empty workspace panel', async () => {
    api.search.global = vi.fn().mockResolvedValue({
      ...results,
      documents: [],
      workspaceFiles: [],
      chats: [{
        ...results.chats[0],
        workspaceId: null,
        workspaceName: null,
        threadId: 'global-thread'
      }]
    })
    const onOpenChat = vi.fn()
    render(<GlobalSearch onOpenChat={onOpenChat} />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })

    const option = await screen.findByRole('option', {
      name: 'globalSearch.openChat: Transformer discussion'
    })
    expect(option).toHaveTextContent('globalSearch.globalChat')
    fireEvent.click(option)

    await waitFor(() => {
      expect(mocks.requestActiveWorkspace).toHaveBeenCalledWith(null)
      expect(mocks.setActiveThreadId).toHaveBeenCalledWith('global-thread')
      expect(onOpenChat).toHaveBeenCalledOnce()
    })
    expect(mocks.openPanel).not.toHaveBeenCalled()
  })

  it('supports keyboard selection and clears document search state', async () => {
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })
    await screen.findByRole('option', { name: 'globalSearch.openPaper: Transformer Research' })

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(mocks.setFocusedDoc).toHaveBeenCalledWith('paper-1')
    expect(mocks.openPdf).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'globalSearch.clear' }))
    expect(input).toHaveValue('')
    expect(mocks.clearSearch).toHaveBeenCalledOnce()
  })

  it('clears local results when the active library changes', async () => {
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })
    await screen.findByRole('option', { name: 'globalSearch.openPaper: Transformer Research' })

    act(() => {
      librarySwitchedCallback?.({
        libraryFolderPath: '/next-library',
        dbExisted: true,
        scanned: 0,
        imported: 0,
        skipped: 0,
        errors: []
      })
    })

    expect(input).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('reports workspace file open failures', async () => {
    api.workspaceAssets.open = vi.fn().mockRejectedValue(new Error('Cannot open asset'))
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })
    const option = await screen.findByRole('option', { name: 'globalSearch.openWorkspaceFile: transformer-data.csv' })

    fireEvent.click(option)

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Cannot open asset'))
  })

  it('shows search failures explicitly and retries the same query', async () => {
    api.search.global = vi.fn()
      .mockRejectedValueOnce(new Error('Search unavailable'))
      .mockResolvedValueOnce(results)
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })

    fireEvent.change(input, { target: { value: 'transformer' } })

    expect(await screen.findByRole('alert')).toHaveTextContent('Search unavailable')
    expect(screen.queryByText('globalSearch.noResults')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'globalSearch.retry' }))

    await waitFor(() => expect(api.search.global).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('globalSearch.papers · 1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not open a workspace result when pending renderer drafts fail to save', async () => {
    mocks.requestActiveWorkspace.mockResolvedValue(false)
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })
    const option = await screen.findByRole('option', {
      name: 'globalSearch.openWorkspaceContent: Transformer synthesis'
    })

    fireEvent.click(option)

    await waitFor(() => {
      expect(mocks.requestActiveWorkspace).toHaveBeenCalledWith('ws-content')
    })
    expect(mocks.openMarkdownCard).not.toHaveBeenCalled()
  })

  it('focuses missing papers without trying to open the file', async () => {
    api.search.global = vi.fn().mockResolvedValue({
      ...results,
      documents: [{ ...paper, fileMissing: 1 }]
    })
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })
    const option = await screen.findByRole('option', { name: 'globalSearch.openPaper: Transformer Research' })

    fireEvent.click(option)

    expect(mocks.setFocusedDoc).toHaveBeenCalledWith('paper-1')
    expect(mocks.openPdf).not.toHaveBeenCalled()
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  it('opens another workspace or chat while AI work continues in the background', async () => {
    mocks.workspaceState.chatStreaming = true
    render(<GlobalSearch />)
    const input = screen.getByRole('combobox', { name: 'globalSearch.label' })
    fireEvent.change(input, { target: { value: 'transformer' } })
    const fileOption = await screen.findByRole('option', { name: 'globalSearch.openWorkspaceFile: transformer-data.csv' })
    const contentOption = screen.getByRole('option', {
      name: 'globalSearch.openWorkspaceContent: Transformer synthesis'
    })
    const chatOption = screen.getByRole('option', { name: 'globalSearch.openChat: Transformer discussion' })

    expect(fileOption).toBeEnabled()
    expect(contentOption).toBeEnabled()
    expect(chatOption).toBeEnabled()
    fireEvent.click(fileOption)
    await waitFor(() => expect(mocks.requestActiveWorkspace).toHaveBeenCalledWith('ws-files'))
    expect(api.workspaceAssets.open).toHaveBeenCalledWith('asset-1')

    fireEvent.change(input, { target: { value: 'transformer again' } })
    fireEvent.click(await screen.findByRole('option', {
      name: 'globalSearch.openChat: Transformer discussion'
    }))
    await waitFor(() => expect(mocks.requestActiveWorkspace).toHaveBeenCalledWith('ws-chat'))
    expect(mocks.setActiveThreadId).toHaveBeenCalledWith('thread-1')
  })
})
