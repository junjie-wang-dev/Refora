import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { showContextMenu } from '@lobehub/ui'
import Board from '@renderer/components/workspace/Board'
import type {
  AiReport,
  AiSummary,
  Document,
  WorkspaceAsset,
  WorkspaceItem,
  WorkspaceItemsChangedEvent,
  WorkspaceNote
} from '@shared/ipc-types'

const DOC_MIME = 'application/x-refora-docids'

const mockAddDocs = vi.fn()
const mockAddAssets = vi.fn()
const mockDeleteAsset = vi.fn()
const mockFetchItems = vi.fn()
const mockRemoveItem = vi.fn()
const mockDeleteReport = vi.fn()
const mockResizeItem = vi.fn()
const mockMoveItem = vi.fn()
const mockCreateNote = vi.fn()
const mockDeleteNote = vi.fn()
const mockUpdateNote = vi.fn()
const mockUpdateReport = vi.fn()
const mockConnectionsList = vi.fn()
const mockConnectionsCreate = vi.fn()
const mockConnectionsDelete = vi.fn()
const mockCopyWorkspaceAsset = vi.fn()
const mockCopyMarkdown = vi.fn()
const mockWriteClipboardText = vi.fn()
const { mockShowToast, mockTranslate } = vi.hoisted(() => ({
  mockShowToast: vi.fn(),
  mockTranslate: (key: string, fallback?: string) => fallback ?? key
}))

let mockItems: WorkspaceItem[] = []
let mockReports: unknown[] = []
let mockNotes: unknown[] = []
let mockAssets: WorkspaceAsset[] = []
let mockActiveWorkspaceId: string | null = 'ws-1'
let mockWorkspaceItemsChangedHandler: ((payload: WorkspaceItemsChangedEvent) => void) | null = null

vi.mock('@renderer/store/workspaceStore', () => ({
  useWorkspaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      items: mockItems,
      reports: mockReports,
      notes: mockNotes,
      assets: mockAssets,
      activeWorkspaceId: mockActiveWorkspaceId,
      addDocs: mockAddDocs,
      addAssets: mockAddAssets,
      deleteAsset: mockDeleteAsset,
      fetchItems: mockFetchItems,
      removeItem: mockRemoveItem,
      deleteReport: mockDeleteReport,
      resizeItem: mockResizeItem,
      moveItem: mockMoveItem,
      createNote: mockCreateNote,
      deleteNote: mockDeleteNote,
      updateNote: mockUpdateNote,
      updateReport: mockUpdateReport
    })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockTranslate
  })
}))

vi.mock('@renderer/store/documentStore', () => ({
  useDocumentStore: {
    getState: () => ({ showToast: mockShowToast })
  }
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

beforeEach(() => {
  vi.mocked(showContextMenu).mockReset()
  mockAddDocs.mockReset().mockResolvedValue(undefined)
  mockAddAssets.mockReset().mockResolvedValue(undefined)
  mockDeleteAsset.mockReset().mockResolvedValue(undefined)
  mockFetchItems.mockReset().mockResolvedValue(undefined)
  mockRemoveItem.mockReset()
  mockDeleteReport.mockReset()
  mockResizeItem.mockReset().mockResolvedValue(true)
  mockMoveItem.mockReset().mockResolvedValue(true)
  mockCreateNote.mockReset().mockResolvedValue(null)
  mockDeleteNote.mockReset()
  mockUpdateNote.mockReset().mockResolvedValue(true)
  mockUpdateReport.mockReset().mockResolvedValue(true)
  mockConnectionsList.mockReset().mockResolvedValue([])
  mockConnectionsCreate.mockReset()
  mockConnectionsDelete.mockReset().mockResolvedValue(undefined)
  mockCopyWorkspaceAsset.mockReset().mockResolvedValue(undefined)
  mockCopyMarkdown.mockReset().mockResolvedValue(undefined)
  mockWriteClipboardText.mockReset().mockResolvedValue(undefined)
  mockShowToast.mockReset()
  mockItems = []
  mockReports = []
  mockNotes = []
  mockAssets = []
  mockActiveWorkspaceId = 'ws-1'
  mockWorkspaceItemsChangedHandler = null

  const api = window.api as unknown as Record<string, unknown>
  const documents = api.documents as Record<string, unknown>
  documents.get = vi.fn().mockResolvedValue(null)
  const ai = api.ai as Record<string, unknown>
  ai.summaryGet = vi.fn().mockResolvedValue(null)
  const workspaceConnections = api.workspaceConnections as Record<string, unknown>
  workspaceConnections.list = mockConnectionsList
  workspaceConnections.create = mockConnectionsCreate
  workspaceConnections.delete = mockConnectionsDelete
  const events = api.events as Record<string, unknown>
  events.onWorkspaceItemsChanged = vi.fn((cb: (payload: WorkspaceItemsChangedEvent) => void) => {
    mockWorkspaceItemsChangedHandler = cb
  })
  events.off = vi.fn()
  api.getPathForFile = vi.fn((file: { name?: string }) => file.name ? `/tmp/${file.name}` : '')
  const workspaceAssets = api.workspaceAssets as Record<string, unknown>
  workspaceAssets.textPreview = vi.fn().mockResolvedValue({ content: '', truncated: false })
  workspaceAssets.previewUrl = vi.fn((id: string) => `refora-asset://asset/${id}`)
  workspaceAssets.open = vi.fn().mockResolvedValue(undefined)
  workspaceAssets.reveal = vi.fn().mockResolvedValue(undefined)
  api.clipboard = {
    copyWorkspaceAsset: mockCopyWorkspaceAsset,
    copyMarkdown: mockCopyMarkdown,
    writeText: mockWriteClipboardText
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function makeItem(id: string, docId: string, x: number): WorkspaceItem {
  return {
    id,
    workspaceId: 'ws-1',
    kind: 'document',
    docId,
    reportId: null,
    noteId: null,
    assetId: null,
    sortOrder: x,
    width: 300,
    height: 200,
    x,
    y: 0,
    zIndex: x,
    addedAt: x
  }
}

describe('Board drag-and-drop', () => {
  it('shows empty drag hint when board has no items', () => {
    render(<Board />)
    expect(screen.getByText('workspace.dragPapersHint')).toBeInTheDocument()
  })

  it('accepts document drops via DOC_MIME and calls addDocs', async () => {
    const { container } = render(<Board />)
    const board = container.firstElementChild as HTMLElement

    const dataTransfer = {
      types: [DOC_MIME],
      dropEffect: 'none',
      getData: (type: string) =>
        type === DOC_MIME ? JSON.stringify(['doc-a', 'doc-b']) : '',
      setData: vi.fn()
    }

    fireEvent.dragOver(board, { dataTransfer })
    const dropEvent = new MouseEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 240
    })
    Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer })
    fireEvent(board, dropEvent)

    await waitFor(() => {
      expect(mockAddDocs).toHaveBeenCalledWith(['doc-a', 'doc-b'], { x: 170, y: 140 })
    })
  })

  it('ignores text/plain payloads without the document MIME type', () => {
    const { container } = render(<Board />)
    const board = container.firstElementChild as HTMLElement

    const dataTransfer = {
      types: ['text/plain'],
      dropEffect: 'none',
      getData: (type: string) => (type === 'text/plain' ? 'doc-x,doc-y' : ''),
      setData: vi.fn()
    }

    fireEvent.drop(board, { dataTransfer })
    expect(mockAddDocs).not.toHaveBeenCalled()
  })

  it('accepts Finder file drops and calls addAssets with managed paths', async () => {
    const { container } = render(<Board />)
    const board = container.firstElementChild as HTMLElement

    const dataTransfer = {
      types: ['Files'],
      dropEffect: 'none',
      files: [{ name: 'notes.md' }, { name: 'image.png' }],
      getData: () => '',
      setData: vi.fn()
    }

    const dropEvent = new MouseEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 240
    })
    Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer })
    fireEvent(board, dropEvent)

    await waitFor(() => {
      expect(mockAddAssets).toHaveBeenCalledWith(
        ['/tmp/notes.md', '/tmp/image.png'],
        { x: 170, y: 140 }
      )
    })
  })
})

describe('Board card clipboard actions', () => {
  it('opens Markdown notes and reports in the workspace Markdown view', () => {
    const report: AiReport = {
      id: 'report-1',
      workspaceId: 'ws-1',
      title: 'Research report',
      contentMd: 'Report body',
      sourceDocIds: [],
      model: null,
      createdAt: 1
    }
    const note: WorkspaceNote = {
      id: 'note-1',
      workspaceId: 'ws-1',
      noteType: 'markdown',
      title: 'Markdown note',
      contentMd: '- Item',
      createdAt: 1,
      updatedAt: 1
    }
    const onOpenMarkdownCard = vi.fn()
    mockReports = [report]
    mockNotes = [note]
    mockItems = [
      {
        ...makeItem('item-report', '', 0),
        kind: 'report',
        docId: null,
        reportId: report.id
      },
      {
        ...makeItem('item-note', '', 1),
        kind: 'note',
        docId: null,
        noteId: note.id
      }
    ]

    const { container } = render(<Board onOpenMarkdownCard={onOpenMarkdownCard} />)
    fireEvent.click(container.querySelector('[data-card-kind="report"]') as HTMLElement)
    fireEvent.click(container.querySelector('[data-card-kind="note"]') as HTMLElement)

    expect(onOpenMarkdownCard).toHaveBeenNthCalledWith(1, { kind: 'report', id: report.id })
    expect(onOpenMarkdownCard).toHaveBeenNthCalledWith(2, { kind: 'note', id: note.id })

    fireEvent.contextMenu(container.querySelector('[data-card-kind="report"]') as HTMLElement)
    const items = vi.mocked(showContextMenu).mock.calls.at(-1)?.[0] as Array<{
      key: string
      onClick?: () => void
    }>
    items.find((item) => item.key === 'edit')?.onClick?.()

    expect(onOpenMarkdownCard).toHaveBeenLastCalledWith(
      { kind: 'report', id: report.id },
      'edit'
    )
  })

  it('opens a document AI summary in the workspace Markdown reader', async () => {
    const document = {
      id: 'doc-1',
      fileName: 'paper.pdf',
      title: 'Paper title'
    } as Document
    const summary: AiSummary = {
      docId: document.id,
      model: 'test',
      content: {
        core: 'Core summary',
        keyPoints: ['Point one'],
        methods: 'Methods',
        contribution: 'Contribution'
      },
      createdAt: 1,
      updatedAt: 2
    }
    const onOpenMarkdownCard = vi.fn()
    mockItems = [makeItem('item-paper', document.id, 0)]
    const api = window.api as unknown as Record<string, unknown>
    const documents = api.documents as Record<string, unknown>
    const ai = api.ai as Record<string, unknown>
    documents.get = vi.fn().mockResolvedValue(document)
    ai.summaryGet = vi.fn().mockResolvedValue(summary)

    const { container } = render(<Board onOpenMarkdownCard={onOpenMarkdownCard} />)
    await waitFor(() => expect(screen.getByText('Paper title')).toBeInTheDocument())
    fireEvent.click(container.querySelector('[data-paper-details]') as HTMLElement)

    expect(onOpenMarkdownCard).toHaveBeenCalledWith({
      kind: 'summary',
      doc: document,
      summary
    })
  })

  it('copies reports and Markdown notes as Markdown files', () => {
    const report: AiReport = {
      id: 'report-1',
      workspaceId: 'ws-1',
      title: 'Research report',
      contentMd: 'Report body',
      sourceDocIds: [],
      model: null,
      createdAt: 1
    }
    const note: WorkspaceNote = {
      id: 'note-1',
      workspaceId: 'ws-1',
      noteType: 'markdown',
      title: 'Markdown note',
      contentMd: '- Item',
      createdAt: 1,
      updatedAt: 1
    }
    mockReports = [report]
    mockNotes = [note]
    mockItems = [
      {
        ...makeItem('item-report', '', 0),
        kind: 'report',
        docId: null,
        reportId: report.id
      },
      {
        ...makeItem('item-note', '', 1),
        kind: 'note',
        docId: null,
        noteId: note.id
      }
    ]

    const { container } = render(<Board />)
    for (const kind of ['report', 'note']) {
      fireEvent.contextMenu(container.querySelector(`[data-card-kind="${kind}"]`) as HTMLElement)
      const items = vi.mocked(showContextMenu).mock.calls.at(-1)?.[0] as Array<{
        key: string
        onClick?: () => void
      }>
      items.find((item) => item.key === 'copy')?.onClick?.()
    }

    expect(mockCopyMarkdown).toHaveBeenNthCalledWith(1, 'Research report', '# Research report\n\nReport body\n')
    expect(mockCopyMarkdown).toHaveBeenNthCalledWith(2, 'Markdown note', '# Markdown note\n\n- Item\n')
  })

  it('copies the current sticky-note draft as plain text', () => {
    const note: WorkspaceNote = {
      id: 'sticky-1',
      workspaceId: 'ws-1',
      noteType: 'plain',
      title: 'Sticky note',
      contentMd: 'Saved text',
      createdAt: 1,
      updatedAt: 1
    }
    mockNotes = [note]
    mockItems = [{
      ...makeItem('item-sticky', '', 0),
      kind: 'note',
      docId: null,
      noteId: note.id
    }]

    const { container } = render(<Board />)
    const content = screen.getByRole('textbox', { name: 'workspace.stickyNoteContentLabel' })
    fireEvent.click(content)
    fireEvent.change(content, {
      target: { value: 'Unsaved current text' }
    })
    fireEvent.contextMenu(container.querySelector('[data-card-kind="sticky"]') as HTMLElement)
    const items = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      onClick?: () => void
    }>
    items.find((item) => item.key === 'copy')?.onClick?.()

    expect(mockWriteClipboardText).toHaveBeenCalledWith('Unsaved current text')
  })

  it('copies a paper card as a generated Markdown file', async () => {
    const doc = {
      id: 'doc-1',
      title: 'Paper title',
      fileName: 'paper.pdf',
      authors: 'Ada Lovelace',
      year: '2026',
      abstract: 'Abstract body'
    } as Document
    mockItems = [makeItem('item-paper', doc.id, 0)]
    const api = window.api as unknown as Record<string, unknown>
    const documents = api.documents as Record<string, unknown>
    documents.get = vi.fn().mockResolvedValue(doc)

    const { container } = render(<Board />)
    await waitFor(() => expect(container.querySelector('[data-card-kind="document"]')).toBeInTheDocument())
    fireEvent.contextMenu(container.querySelector('[data-card-kind="document"]') as HTMLElement)
    const items = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      onClick?: () => void
    }>
    items.find((item) => item.key === 'copy')?.onClick?.()

    expect(mockCopyMarkdown).toHaveBeenCalledOnce()
    expect(mockCopyMarkdown.mock.calls[0][0]).toBe('Paper title')
    expect(mockCopyMarkdown.mock.calls[0][1]).toContain('# Paper title')
    expect(mockCopyMarkdown.mock.calls[0][1]).toContain('**Authors:** Ada Lovelace')
    expect(mockCopyMarkdown.mock.calls[0][1]).toContain('## Abstract')
  })
})

describe('Board workspace assets', () => {
  it.each([
    ['image', 'image/png', 'figure.png', 'img'],
    ['video', 'video/mp4', 'demo.mp4', 'video']
  ] as const)('renders a %s as an edge-to-edge media card with hover details', (previewKind, mimeType, fileName, elementName) => {
    const asset: WorkspaceAsset = {
      id: `asset-${previewKind}`,
      workspaceId: 'ws-1',
      fileName,
      filePath: `refora-assets/asset-${previewKind}/${fileName}`,
      sourcePath: `/tmp/${fileName}`,
      mimeType,
      previewKind,
      fileSize: 2048,
      fileHash: 'hash',
      fileMissing: 0,
      createdAt: 0,
      updatedAt: 0
    }
    mockAssets = [asset]
    mockItems = [{
      ...makeItem(`item-${previewKind}`, '', 0),
      kind: 'asset',
      docId: null,
      assetId: asset.id
    }]

    const { container } = render(<Board />)

    const card = container.querySelector('[data-card-kind="asset"]') as HTMLElement
    expect(card).toHaveClass('workspace-content-card--media', 'p-0')
    expect(card).toHaveAttribute('data-asset-preview-kind', previewKind)
    expect(card.querySelector('[data-card-scroll]')).toBeNull()
    expect(card.querySelector('[data-asset-media-overlay]')).toHaveClass(
      'workspace-asset-media-overlay',
      'inset-x-0',
      'top-0',
      'z-30'
    )
    const media = card.querySelector(elementName) as HTMLImageElement | HTMLVideoElement
    expect(media).toHaveClass('workspace-asset-media', 'object-cover')
    expect(media).toHaveAttribute('src', `refora-asset://asset/${asset.id}`)
    expect(screen.getByText(fileName)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.assetOpen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.assetReveal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.assetDelete' })).toBeInTheDocument()

    fireEvent.contextMenu(card)
    const contextItems = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      onClick?: () => void
    }>
    contextItems.find((item) => item.key === 'copy')?.onClick?.()
    expect(mockCopyWorkspaceAsset).toHaveBeenCalledWith(asset.id)

    if (media instanceof HTMLVideoElement) {
      expect(media).toHaveAttribute('draggable', 'false')
      expect(card.querySelector('[data-card-video-drag-surface]')).toHaveClass('top-0', 'bottom-14', 'z-20')
      expect(media).toHaveAttribute('preload', 'metadata')
      expect(media).not.toHaveAttribute('controls')
      fireEvent.mouseEnter(card)
      expect(media).toHaveAttribute('controls')
      fireEvent.mouseLeave(card)
      expect(media).not.toHaveAttribute('controls')
    }
  })

  it('drags a video card from its top area without taking over the native control bar', () => {
    const asset: WorkspaceAsset = {
      id: 'asset-video-drag',
      workspaceId: 'ws-1',
      fileName: 'demo.mp4',
      filePath: 'refora-assets/asset-video-drag/demo.mp4',
      sourcePath: '/tmp/demo.mp4',
      mimeType: 'video/mp4',
      previewKind: 'video',
      fileSize: 2048,
      fileHash: 'hash',
      fileMissing: 0,
      createdAt: 0,
      updatedAt: 0
    }
    mockAssets = [asset]
    mockItems = [{
      ...makeItem('item-video-drag', '', 0),
      kind: 'asset',
      docId: null,
      assetId: asset.id
    }]

    const { container } = render(<Board />)
    const mediaCard = container.querySelector('[data-card-kind="asset"]') as HTMLElement
    const video = mediaCard.querySelector('video') as HTMLVideoElement
    const dragSurface = mediaCard.querySelector('[data-card-video-drag-surface]') as HTMLElement
    fireEvent.mouseEnter(mediaCard)

    fireEvent.pointerDown(dragSurface, { pointerId: 21, button: 0, clientX: 20, clientY: 16 })
    fireEvent.pointerMove(document, { pointerId: 21, clientX: 80, clientY: 51 })
    fireEvent.pointerUp(document, { pointerId: 21 })

    expect(mockMoveItem).toHaveBeenCalledWith('item-video-drag', 60, 35, 1)

    mockMoveItem.mockClear()
    fireEvent.pointerDown(video, { pointerId: 22, button: 0, clientX: 20, clientY: 180 })
    fireEvent.pointerMove(document, { pointerId: 22, clientX: 80, clientY: 190 })
    fireEvent.pointerUp(document, { pointerId: 22 })

    expect(mockMoveItem).not.toHaveBeenCalled()
  })

  it('loads video metadata only when the media card approaches the viewport', () => {
    let observerCallback: IntersectionObserverCallback = () => {}
    const observe = vi.fn()
    const disconnect = vi.fn()
    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback
      }

      observe = observe
      disconnect = disconnect
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    const asset: WorkspaceAsset = {
      id: 'asset-video-lazy',
      workspaceId: 'ws-1',
      fileName: 'lazy.mp4',
      filePath: 'refora-assets/asset-video-lazy/lazy.mp4',
      sourcePath: '/tmp/lazy.mp4',
      mimeType: 'video/mp4',
      previewKind: 'video',
      fileSize: 2048,
      fileHash: 'hash',
      fileMissing: 0,
      createdAt: 0,
      updatedAt: 0
    }
    mockAssets = [asset]
    mockItems = [{
      ...makeItem('item-video-lazy', '', 0),
      kind: 'asset',
      docId: null,
      assetId: asset.id
    }]

    const { container } = render(<Board />)
    const video = container.querySelector('video') as HTMLVideoElement
    expect(observe).toHaveBeenCalled()
    expect(video).toHaveAttribute('preload', 'none')

    act(() => {
      observerCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })

    expect(video).toHaveAttribute('preload', 'metadata')
    expect(disconnect).toHaveBeenCalled()
  })

  it('renders a managed text file preview on an asset card', async () => {
    const asset: WorkspaceAsset = {
      id: 'asset-1',
      workspaceId: 'ws-1',
      fileName: 'notes.md',
      filePath: 'refora-assets/asset-1/notes.md',
      sourcePath: '/tmp/notes.md',
      mimeType: 'text/markdown',
      previewKind: 'text',
      fileSize: 20,
      fileHash: 'hash',
      fileMissing: 0,
      createdAt: 0,
      updatedAt: 0
    }
    mockAssets = [asset]
    mockItems = [{
      ...makeItem('item-asset', '', 0),
      kind: 'asset',
      docId: null,
      assetId: asset.id
    }]
    const api = window.api as unknown as Record<string, unknown>
    const workspaceAssets = api.workspaceAssets as Record<string, unknown>
    workspaceAssets.textPreview = vi.fn().mockResolvedValue({
      content: '# Managed file\n\nPreview body',
      truncated: false
    })

    const { container } = render(<Board />)

    expect(container.querySelector('[data-card-kind="asset"]')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('Managed file')).toBeInTheDocument()
      expect(screen.getByText('Preview body')).toBeInTheDocument()
    })
  })
})

describe('Board error handling', () => {
  it('reports document loading failures through the toast', async () => {
    mockItems = [
      {
        id: 'item-1',
        workspaceId: 'ws-1',
        kind: 'document',
        docId: 'doc-1',
        reportId: null,
        sortOrder: 0,
        addedAt: 0
      }
    ]
    const api = window.api as unknown as Record<string, unknown>
    const documents = api.documents as Record<string, unknown>
    documents.get = vi.fn().mockRejectedValue(new Error('DB error'))

    render(<Board />)
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('DB error')
    })
  })
})

describe('Board canvas controls and connections', () => {
  it('keeps the canvas at 100% without zoom controls or a dotted grid', () => {
    const { container } = render(<Board />)
    const board = container.firstElementChild as HTMLElement
    const world = container.querySelector('.workspace-canvas-world') as HTMLElement

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: 120
    })
    board.dispatchEvent(wheel)

    expect(world.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)')
    expect(wheel.defaultPrevented).toBe(true)
    expect(screen.queryByRole('button', { name: 'workspace.canvasZoomIn' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'workspace.canvasZoomOut' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'workspace.canvasReset' })).not.toBeInTheDocument()
    expect(container.querySelector('.workspace-canvas-grid')).not.toBeInTheDocument()
    expect(screen.queryByText('workspace.canvasHint')).not.toBeInTheDocument()
  })

  it('moves a card through a transient transform and persists only on pointer release', () => {
    mockItems = [makeItem('item-1', 'doc-1', 0)]
    const { container } = render(<Board />)
    const card = container.querySelector('[data-workspace-card-id="item-1"]') as HTMLElement

    fireEvent.pointerDown(card, { pointerId: 10, button: 0, clientX: 20, clientY: 20 })
    fireEvent.pointerMove(document, { pointerId: 10, clientX: 80, clientY: 55 })

    expect(mockMoveItem).not.toHaveBeenCalled()
    fireEvent.pointerUp(document, { pointerId: 10 })

    expect(card.style.left).toBe('0px')
    expect(card.style.top).toBe('0px')
    expect(card.style.transform).toBe('translate3d(60px, 35px, 0)')
    expect(mockMoveItem).toHaveBeenCalledOnce()
    expect(mockMoveItem).toHaveBeenCalledWith('item-1', 60, 35, 1)
  })

  it('restores connection geometry when a card drag is cancelled', async () => {
    mockItems = [makeItem('item-1', 'doc-1', 0), makeItem('item-2', 'doc-2', 400)]
    mockConnectionsList.mockResolvedValue([{
      id: 'connection-1',
      workspaceId: 'ws-1',
      sourceItemId: 'item-1',
      targetItemId: 'item-2',
      sourceAnchor: 'right',
      targetAnchor: 'left',
      createdAt: 1
    }])
    const { container } = render(<Board />)
    const connection = await waitFor(() => {
      const path = container.querySelector('svg g path[stroke="transparent"]') as SVGPathElement | null
      expect(path).not.toBeNull()
      return path as SVGPathElement
    })
    const initialPath = connection.getAttribute('d')
    const card = container.querySelector('[data-workspace-card-id="item-1"]') as HTMLElement

    fireEvent.pointerDown(card, { pointerId: 14, button: 0, clientX: 20, clientY: 20 })
    fireEvent.pointerMove(document, { pointerId: 14, clientX: 80, clientY: 55 })
    await waitFor(() => expect(connection.getAttribute('d')).not.toBe(initialPath))

    fireEvent.pointerCancel(document, { pointerId: 14 })

    expect(card.style.transform).toBe('translate3d(0px, 0px, 0)')
    expect(connection.getAttribute('d')).toBe(initialPath)
    expect(mockMoveItem).not.toHaveBeenCalled()
  })

  it('pans with Space plus the primary button or with the middle button', () => {
    const { container } = render(<Board />)
    const board = container.firstElementChild as HTMLElement
    const world = container.querySelector('.workspace-canvas-world') as HTMLElement

    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    fireEvent.pointerDown(board, { pointerId: 11, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(document, { pointerId: 11, clientX: 140, clientY: 130 })
    fireEvent.pointerUp(document, { pointerId: 11 })
    fireEvent.keyUp(window, { code: 'Space', key: ' ' })

    expect(world.style.transform).toBe('translate3d(40px, 30px, 0) scale(1)')

    fireEvent.pointerDown(board, { pointerId: 12, button: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(document, { pointerId: 12, clientX: 120, clientY: 125 })
    fireEvent.pointerUp(document, { pointerId: 12 })

    expect(world.style.transform).toBe('translate3d(60px, 55px, 0) scale(1)')
  })

  it('selects cards by click, focus, and marquee while showing floating actions', () => {
    mockItems = [makeItem('item-1', 'doc-1', 0), makeItem('item-2', 'doc-2', 400)]
    const { container } = render(<Board />)
    const board = container.firstElementChild as HTMLElement
    const first = container.querySelector('[data-workspace-card-id="item-1"]') as HTMLElement
    const second = container.querySelector('[data-workspace-card-id="item-2"]') as HTMLElement

    fireEvent.focus(first)
    expect(first).toHaveAttribute('data-selected', 'true')
    expect(screen.getByRole('toolbar', { name: 'workspace.selectionActions' })).toBeInTheDocument()

    fireEvent.pointerDown(second, { pointerId: 21, button: 0, shiftKey: true })
    fireEvent.pointerUp(document, { pointerId: 21 })
    expect(first).toHaveAttribute('data-selected', 'true')
    expect(second).toHaveAttribute('data-selected', 'true')

    first.getBoundingClientRect = () => ({
      left: 20,
      top: 20,
      right: 320,
      bottom: 220,
      width: 300,
      height: 200,
      x: 20,
      y: 20,
      toJSON: () => ({})
    })
    second.getBoundingClientRect = () => ({
      left: 420,
      top: 20,
      right: 720,
      bottom: 220,
      width: 300,
      height: 200,
      x: 420,
      y: 20,
      toJSON: () => ({})
    })
    fireEvent.pointerDown(board, { pointerId: 22, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(document, { pointerId: 22, clientX: 350, clientY: 250 })
    expect(container.querySelector('.workspace-selection-marquee')).toBeInTheDocument()
    fireEvent.pointerUp(document, { pointerId: 22 })

    expect(first).toHaveAttribute('data-selected', 'true')
    expect(second).not.toHaveAttribute('data-selected')
  })

  it('moves focus to the canvas and exits sticky editing when blank space is pressed', () => {
    const note: WorkspaceNote = {
      id: 'sticky-1',
      workspaceId: 'ws-1',
      noteType: 'plain',
      color: 'sand',
      title: 'Sticky',
      contentMd: 'Text',
      createdAt: 1,
      updatedAt: 1
    }
    mockNotes = [note]
    mockItems = [{
      ...makeItem('item-sticky', '', 0),
      kind: 'note',
      docId: null,
      noteId: note.id
    }]
    const { container } = render(<Board />)
    const board = container.firstElementChild as HTMLElement
    const card = container.querySelector('[data-workspace-card-id="item-sticky"]') as HTMLElement
    const content = screen.getByRole('textbox', { name: 'workspace.stickyNoteContentLabel' })

    content.focus()
    fireEvent.click(content)
    expect(content).not.toHaveAttribute('readonly')
    expect(card).toHaveAttribute('data-selected', 'true')

    fireEvent.pointerDown(board, { pointerId: 23, button: 0, clientX: 10, clientY: 10 })

    expect(document.activeElement).toBe(board)
    expect(content).toHaveAttribute('readonly')
    expect(card).not.toHaveAttribute('data-selected')
    fireEvent.pointerUp(document, { pointerId: 23 })
  })

  it('animates stacking and gridding from the floating toolbar', async () => {
    mockItems = [makeItem('item-1', 'doc-1', 0), makeItem('item-2', 'doc-2', 400)]
    const { container } = render(<Board />)
    const first = container.querySelector('[data-workspace-card-id="item-1"]') as HTMLElement
    const second = container.querySelector('[data-workspace-card-id="item-2"]') as HTMLElement

    fireEvent.pointerDown(first, { pointerId: 31, button: 0 })
    fireEvent.pointerUp(document, { pointerId: 31 })
    fireEvent.pointerDown(second, { pointerId: 32, button: 0, shiftKey: true })
    fireEvent.pointerUp(document, { pointerId: 32 })
    fireEvent.click(screen.getByRole('button', { name: 'workspace.selectionStack' }))

    expect(first).toHaveClass('is-layout-animating')
    await waitFor(() => {
      expect(mockMoveItem).toHaveBeenNthCalledWith(1, 'item-1', 0, 0, 401)
      expect(mockMoveItem).toHaveBeenNthCalledWith(2, 'item-2', 18, 18, 402)
    })

    fireEvent.click(screen.getByRole('button', { name: 'workspace.selectionGrid' }))
    await waitFor(() => {
      expect(mockMoveItem).toHaveBeenNthCalledWith(3, 'item-1', 0, 0, 401)
      expect(mockMoveItem).toHaveBeenNthCalledWith(4, 'item-2', 324, 0, 402)
    })
  })

  it('packs differently sized cards into a compact grid', async () => {
    mockItems = [
      { ...makeItem('item-1', 'doc-1', 0), width: 420, height: 120 },
      { ...makeItem('item-2', 'doc-2', 100), width: 160, height: 300 },
      { ...makeItem('item-3', 'doc-3', 200), width: 280, height: 100 },
      { ...makeItem('item-4', 'doc-4', 300), width: 120, height: 140 }
    ]
    const { container } = render(<Board />)
    const cards = [...container.querySelectorAll<HTMLElement>('[data-workspace-card]')]

    cards.forEach((card, index) => {
      fireEvent.pointerDown(card, { pointerId: 40 + index, button: 0, shiftKey: index > 0 })
      fireEvent.pointerUp(document, { pointerId: 40 + index })
    })
    fireEvent.click(screen.getByRole('button', { name: 'workspace.selectionGrid' }))

    await waitFor(() => {
      expect(mockMoveItem).toHaveBeenNthCalledWith(1, 'item-1', 0, 0, 301)
      expect(mockMoveItem).toHaveBeenNthCalledWith(2, 'item-2', 444, 0, 302)
      expect(mockMoveItem).toHaveBeenNthCalledWith(3, 'item-3', 0, 144, 303)
      expect(mockMoveItem).toHaveBeenNthCalledWith(4, 'item-4', 0, 268, 304)
    })
  })

  it('changes the selected sticky note to a preset solid color', () => {
    const note: WorkspaceNote = {
      id: 'sticky-1',
      workspaceId: 'ws-1',
      noteType: 'plain',
      color: 'sand',
      title: 'Sticky',
      contentMd: 'Text',
      createdAt: 1,
      updatedAt: 1
    }
    mockNotes = [note]
    mockItems = [{
      ...makeItem('item-sticky', '', 0),
      kind: 'note',
      docId: null,
      noteId: note.id
    }]
    const { container } = render(<Board />)
    const card = container.querySelector('[data-workspace-card-id="item-sticky"]') as HTMLElement

    fireEvent.focus(card)
    fireEvent.click(screen.getByRole('button', { name: 'workspace.stickyColorSky' }))

    expect(mockUpdateNote).toHaveBeenCalledWith('sticky-1', { color: 'sky' })
  })

  it('creates a persisted arrow connection by dragging a card-edge handle to another card', async () => {
    mockItems = [makeItem('item-1', 'doc-1', 0), makeItem('item-2', 'doc-2', 400)]
    mockConnectionsCreate.mockResolvedValue({
      id: 'connection-1',
      workspaceId: 'ws-1',
      sourceItemId: 'item-1',
      targetItemId: 'item-2',
      sourceAnchor: 'right',
      targetAnchor: 'left',
      createdAt: 1
    })
    const { container } = render(<Board />)
    const sourceHandle = container.querySelector(
      '[data-workspace-card-id="item-1"] [data-connection-handle="right"]'
    ) as HTMLButtonElement
    const sourceCard = sourceHandle.closest('[data-workspace-card]') as HTMLElement
    expect(sourceCard).toHaveClass(
      'workspace-connection-accent--document'
    )
    expect(sourceCard.querySelector('.resizable-card-content')?.contains(sourceHandle)).toBe(false)
    const targetCard = container.querySelector('[data-workspace-card-id="item-2"]') as HTMLElement
    const originalElementsFromPoint = document.elementsFromPoint
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [targetCard]
    })

    fireEvent.mouseDown(sourceHandle, { button: 0, clientX: 300, clientY: 100 })
    fireEvent.mouseMove(document, { clientX: 410, clientY: 100 })
    fireEvent.mouseUp(document, { clientX: 410, clientY: 100 })

    await waitFor(() => {
      expect(mockConnectionsCreate).toHaveBeenCalledWith(
        'ws-1',
        'item-1',
        'item-2',
        'right',
        'left'
      )
    })
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: originalElementsFromPoint
    })
  })

  it('reloads connections after an agent workspace change event', async () => {
    mockConnectionsList.mockResolvedValue([])
    render(<Board />)

    await waitFor(() => {
      expect(mockConnectionsList).toHaveBeenCalledTimes(1)
    })

    act(() => {
      mockWorkspaceItemsChangedHandler?.({ workspaceId: 'ws-1', reason: 'other' })
    })

    await waitFor(() => {
      expect(mockConnectionsList).toHaveBeenCalledTimes(2)
    })
  })
})
