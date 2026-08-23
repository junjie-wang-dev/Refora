import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AiReport, Document, WorkspaceAsset, WorkspaceNote } from '../../src/shared/ipc-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))

const mockShowContextMenu = vi.fn()
const mockOpenPdf = vi.fn()
const originalOpenPdf = window.api.documents.openPdf
const mockBoardCreateNote = vi.hoisted(() => vi.fn())
const mockPdfReaderState = vi.hoisted(() => ({
  tabs: [] as Array<{ id: string; title: string | null; fileName: string }>,
  activeDocumentId: null as string | null,
  open: vi.fn(),
  activate: vi.fn(),
  close: vi.fn()
}))
const mockWorkspacePanelState = vi.hoisted(() => ({
  workspaces: [
    { id: 'ws-1', name: 'Research', createdAt: 1, updatedAt: 1 },
    { id: 'ws-2', name: 'Reading notes', createdAt: 2, updatedAt: 2 }
  ],
  activeWorkspaceId: 'ws-1' as string | null,
  openWorkspaceIds: ['ws-1'] as string[],
  panelView: 'workspace' as 'workspace' | 'markdown' | 'pdf',
  fullscreen: false,
  chatStreaming: false,
  reports: [] as AiReport[],
  notes: [] as WorkspaceNote[],
  markdownCardRequest: null as { kind: 'report' | 'note'; id: string } | null,
  setActiveWorkspace: vi.fn(),
  requestActiveWorkspace: vi.fn(),
  closeWorkspaceTab: vi.fn(),
  toggleFullscreen: vi.fn(),
  closePanel: vi.fn(),
  showWorkspace: vi.fn(),
  showMarkdown: vi.fn(),
  clearMarkdownCardRequest: vi.fn(),
  updateNote: vi.fn(),
  updateReport: vi.fn()
}))

vi.mock('../../src/renderer/store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: typeof mockWorkspacePanelState) => unknown) => selector(mockWorkspacePanelState),
    { getState: () => mockWorkspacePanelState }
  )
}))

vi.mock('../../src/renderer/store/pdfReaderStore', () => ({
  usePdfReaderStore: Object.assign(
    (selector: (state: typeof mockPdfReaderState) => unknown) => selector(mockPdfReaderState),
    { getState: () => mockPdfReaderState }
  )
}))

vi.mock('../../src/renderer/components/PdfReader', () => ({
  default: ({ onBack }: { onBack?: () => void }) => (
    <button type="button" onClick={onBack}>PDF reader</button>
  )
}))

vi.mock('../../src/renderer/components/workspace/Board', async () => {
  const React = await import('react')
  return {
    default: React.forwardRef(function MockBoard(
      props: { onOpenMarkdownCard?: (card: { kind: 'report'; id: string }) => void },
      ref
    ) {
      React.useImperativeHandle(ref, () => ({ createNote: mockBoardCreateNote, addFiles: vi.fn() }))
      return React.createElement(
        'div',
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => props.onOpenMarkdownCard?.({ kind: 'report', id: 'report-1' })
          },
          'Open report card'
        ),
        'Board'
      )
    })
  }
})

vi.mock('../../src/renderer/components/workspace/ChatPanel', () => ({
  default: () => <div>Chat panel</div>
}))

vi.mock('../../src/renderer/components/ResizeDivider', () => ({
  default: ({ orientation = 'vertical' }: { orientation?: 'vertical' | 'horizontal' }) => (
    <div data-testid="resize-divider" data-orientation={orientation}>Resize divider</div>
  )
}))

vi.mock('@lobehub/ui', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Modal: ({ children, open, title, footer }: {
    children: React.ReactNode
    open: boolean
    title: string
    footer: React.ReactNode
  }) => (
    <div data-testid="modal-root" data-open={String(open)}>
      {open && (
        <div data-testid="modal">
          <div data-testid="modal-title">{title}</div>
          <div data-testid="modal-body">{children}</div>
          <div data-testid="modal-footer">{footer}</div>
        </div>
      )}
    </div>
  ),
  Button: ({ children, onClick, danger, disabled }: {
    children: React.ReactNode
    onClick?: () => void
    danger?: boolean
    disabled?: boolean
  }) => (
    <button data-testid={danger ? 'modal-btn-danger' : 'modal-btn'} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  showContextMenu: (...args: unknown[]) => mockShowContextMenu(...args)
}))

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => (
      <div {...props}>{children}</div>
    )
  },
  MotionConfig: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

const ReportCardModule = await import('../../src/renderer/components/workspace/ReportCard')
const ReportCard = ReportCardModule.default
const PaperCard = (await import('../../src/renderer/components/workspace/PaperCard')).default
const NoteCard = (await import('../../src/renderer/components/workspace/NoteCard')).default
const AssetCard = (await import('../../src/renderer/components/workspace/AssetCard')).default
const StickyNoteCard = (await import('../../src/renderer/components/workspace/StickyNoteCard')).default
const ResizableCard = (await import('../../src/renderer/components/workspace/ResizableCard')).default
const WorkspacePanel = (await import('../../src/renderer/components/workspace/WorkspacePanel')).default

function makeReport(overrides: Partial<AiReport> = {}): AiReport {
  return {
    id: 'r1',
    workspaceId: 'ws-1',
    title: 'Test Report',
    contentMd: 'Paragraph one.\n\nParagraph two.',
    sourceDocIds: [],
    model: 'gpt-4o',
    createdAt: 1700000000000,
    ...overrides
  }
}

beforeEach(() => {
  mockShowContextMenu.mockReset()
  mockOpenPdf.mockReset().mockResolvedValue(undefined)
  mockPdfReaderState.activeDocumentId = null
  mockPdfReaderState.tabs = []
  mockPdfReaderState.open.mockReset()
  mockPdfReaderState.activate.mockReset()
  mockPdfReaderState.close.mockReset()
  window.api.documents.openPdf = mockOpenPdf
  mockBoardCreateNote.mockReset()
  mockWorkspacePanelState.workspaces = [
    { id: 'ws-1', name: 'Research', createdAt: 1, updatedAt: 1 },
    { id: 'ws-2', name: 'Reading notes', createdAt: 2, updatedAt: 2 }
  ]
  mockWorkspacePanelState.activeWorkspaceId = 'ws-1'
  mockWorkspacePanelState.openWorkspaceIds = ['ws-1']
  mockWorkspacePanelState.panelView = 'workspace'
  mockWorkspacePanelState.fullscreen = false
  mockWorkspacePanelState.chatStreaming = false
  mockWorkspacePanelState.reports = []
  mockWorkspacePanelState.notes = []
  mockWorkspacePanelState.markdownCardRequest = null
  mockWorkspacePanelState.setActiveWorkspace.mockReset()
  mockWorkspacePanelState.setActiveWorkspace.mockImplementation((id: string | null) => {
    mockWorkspacePanelState.activeWorkspaceId = id
    if (id && !mockWorkspacePanelState.openWorkspaceIds.includes(id)) {
      mockWorkspacePanelState.openWorkspaceIds = [...mockWorkspacePanelState.openWorkspaceIds, id]
    }
    mockWorkspacePanelState.panelView = 'workspace'
  })
  mockWorkspacePanelState.requestActiveWorkspace.mockReset().mockImplementation(
    async (id: string | null) => {
      mockWorkspacePanelState.setActiveWorkspace(id)
      return true
    }
  )
  mockWorkspacePanelState.closeWorkspaceTab.mockReset()
  mockWorkspacePanelState.closeWorkspaceTab.mockImplementation((id: string) => {
    mockWorkspacePanelState.openWorkspaceIds = mockWorkspacePanelState.openWorkspaceIds.filter(
      (workspaceId) => workspaceId !== id
    )
  })
  mockWorkspacePanelState.closePanel.mockReset()
  mockWorkspacePanelState.showWorkspace.mockReset()
  mockWorkspacePanelState.showWorkspace.mockImplementation(() => {
    mockWorkspacePanelState.panelView = 'workspace'
  })
  mockWorkspacePanelState.showMarkdown.mockReset().mockImplementation(() => {
    mockWorkspacePanelState.panelView = 'markdown'
  })
  mockWorkspacePanelState.clearMarkdownCardRequest.mockReset()
  mockWorkspacePanelState.updateNote.mockReset().mockResolvedValue(true)
  mockWorkspacePanelState.updateReport.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.api.documents.openPdf = originalOpenPdf
})

describe('ReportCard', () => {
  it('opens the report with the keyboard from its title action', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(
      <ReportCard
        report={makeReport()}
        onDelete={() => {}}
        onUpdate={async () => true}
        onOpen={onOpen}
      />
    )

    screen.getByRole('button', { name: 'Test Report' }).focus()
    await user.keyboard('{Enter}')

    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('opens a citation PDF without opening the Markdown reader or a browser link', async () => {
    const onOpen = vi.fn()
    render(
      <ReportCard
        report={makeReport({
          contentMd: '[3DGUT](refora://doc/e9e71747-2fd1-4038-ab42-00553e68328c)'
        })}
        onDelete={() => {}}
        onUpdate={async () => true}
        onOpen={onOpen}
      />
    )

    const citation = screen.getByRole('button', { name: '3DGUT' })
    expect(screen.queryByRole('link', { name: '3DGUT' })).not.toBeInTheDocument()
    fireEvent.click(citation)

    await waitFor(() => {
      expect(mockOpenPdf).toHaveBeenCalledWith('e9e71747-2fd1-4038-ab42-00553e68328c')
    })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('renders the report title and preview content', () => {
    render(<ReportCard report={makeReport()} onDelete={() => {}} onUpdate={async () => true} />)
    expect(screen.getByText('Test Report')).toBeTruthy()
    expect(screen.getByText(/Paragraph one/)).toBeTruthy()
  })

  it('renders formatted date', () => {
    render(<ReportCard report={makeReport({ createdAt: 1700000000000 })} onDelete={() => {}} onUpdate={async () => true} />)
    expect(screen.getByText('2023-11-14')).toBeTruthy()
  })

  it('shows context menu on right-click with copy, edit, export, and delete options', () => {
    const { container } = render(<ReportCard report={makeReport()} onDelete={() => {}} onUpdate={async () => true} />)
    const card = container.querySelector('.card') as HTMLElement
    expect(card).toBeTruthy()
    fireEvent.contextMenu(card)
    expect(mockShowContextMenu).toHaveBeenCalledTimes(1)
    const items = mockShowContextMenu.mock.calls[0][0] as Array<{
      key: string
      label: string
      danger?: boolean
      onClick: () => void
    }>
    expect(items).toHaveLength(4)
    expect(items[0].key).toBe('copy')
    expect(items[0].label).toBe('workspace.cardCopy')
    expect(items[1].key).toBe('edit')
    expect(items[1].label).toBe('workspace.reportEdit')
    expect(items[2].key).toBe('export')
    expect(items[2].label).toBe('workspace.reportExportMd')
    expect(items[3].key).toBe('delete')
    expect(items[3].danger).toBe(true)
    expect(items[3].label).toBe('workspace.reportDelete')
  })

  it('copies a report from its context menu', () => {
    const onCopy = vi.fn()
    const { container } = render(
      <ReportCard report={makeReport()} onDelete={() => {}} onUpdate={async () => true} onCopy={onCopy} />
    )
    fireEvent.contextMenu(container.querySelector('.card') as HTMLElement)
    const items = mockShowContextMenu.mock.calls[0][0] as Array<{ key: string; onClick: () => void }>
    act(() => items.find((item) => item.key === 'copy')?.onClick())
    expect(onCopy).toHaveBeenCalledOnce()
  })

  it('opens modal when context menu delete action is clicked', () => {
    const { container } = render(<ReportCard report={makeReport()} onDelete={() => {}} onUpdate={async () => true} />)
    const card = container.querySelector('.card') as HTMLElement
    fireEvent.contextMenu(card)
    const items = mockShowContextMenu.mock.calls[0][0] as Array<{ onClick: () => void }>
    act(() => {
      items[3].onClick()
    })
    expect(screen.getByTestId('modal')).toBeTruthy()
  })

  it('confirms a context-menu delete before calling onDelete', () => {
    const onDelete = vi.fn()
    const { container } = render(<ReportCard report={makeReport()} onDelete={onDelete} onUpdate={async () => true} />)
    const card = container.querySelector('.card') as HTMLElement
    fireEvent.contextMenu(card)
    const items = mockShowContextMenu.mock.calls[0][0] as Array<{ onClick: () => void }>
    act(() => {
      items[3].onClick()
    })
    const dangerBtn = screen.getByTestId('modal-btn-danger')
    expect(dangerBtn.textContent).toContain('common.confirm')
    fireEvent.click(dangerBtn)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('shows source papers and opens an available source', () => {
    const onOpenSource = vi.fn()
    render(
      <ReportCard
        report={makeReport({ sourceDocIds: ['doc-1'] })}
        sourceDocuments={new Map([['doc-1', { id: 'doc-1', title: 'Source Paper', fileName: 'source.pdf' } as never]])}
        onOpenSource={onOpenSource}
        onDelete={() => {}}
        onUpdate={async () => true}
      />
    )

    fireEvent.click(screen.getByText('Test Report'))
    fireEvent.click(screen.getByRole('button', { name: 'Source Paper' }))
    expect(onOpenSource).toHaveBeenCalledWith('doc-1')
  })
})

describe('Workspace card types', () => {
  it('opens the PDF from the left preview and generates a summary from empty right details', () => {
    const onOpenPdf = vi.fn()
    const onOpenSummary = vi.fn()
    const onSummarize = vi.fn()
    const paper = {
      id: 'doc / 1',
      fileName: 'paper.pdf',
      fileHash: 'hash / 1',
      updatedAt: 42,
      fileMissing: 0,
      title: 'Paper title'
    } as Document
    const { container } = render(
      <PaperCard
        doc={paper}
        summary={null}
        summarizing={false}
        summaryError={null}
        onSummarize={onSummarize}
        onOpenPdf={onOpenPdf}
        onRemove={() => {}}
        onOpenSummary={onOpenSummary}
      />
    )

    const preview = screen.getByRole('button', { name: 'workspace.pdfPreview' })
    expect(preview.querySelector('img')).toHaveAttribute(
      'src',
      'refora-document://preview/doc%20%2F%201?v=hash%20%2F%201-42'
    )
    expect(preview).toHaveClass('h-full', 'max-w-[70%]', 'shrink-0')
    expect(preview).not.toHaveClass('w-[38%]')
    expect(preview.querySelector('img')).toHaveClass('h-full', 'w-auto')
    const details = container.querySelector('[data-paper-details]') as HTMLElement
    expect(details).toContainElement(
      screen.getByText('Paper title')
    )
    expect(details).toHaveClass('cursor-pointer')
    fireEvent.click(preview)
    expect(onOpenPdf).toHaveBeenCalledOnce()
    expect(onOpenSummary).not.toHaveBeenCalled()
    fireEvent.click(details)
    expect(onSummarize).toHaveBeenCalledOnce()
    expect(onOpenSummary).not.toHaveBeenCalled()
    expect(onOpenPdf).toHaveBeenCalledOnce()
  })

  it('does not request another summary while the paper is already summarizing', () => {
    const onSummarize = vi.fn()
    const { container } = render(
      <PaperCard
        doc={{ id: 'doc-1', fileName: 'paper.pdf', title: 'Paper title' } as Document}
        summary={null}
        summarizing
        summaryError={null}
        onSummarize={onSummarize}
        onOpenPdf={() => {}}
        onRemove={() => {}}
      />
    )

    fireEvent.click(container.querySelector('[data-paper-details]') as HTMLElement)

    expect(onSummarize).not.toHaveBeenCalled()
  })

  it('copies a paper as Markdown from its context menu', () => {
    const onCopy = vi.fn()
    const paper = { id: 'doc-1', fileName: 'paper.pdf', title: 'Paper title' } as Document
    const { container } = render(
      <PaperCard
        doc={paper}
        summary={null}
        summarizing={false}
        summaryError={null}
        onSummarize={() => {}}
        onOpenPdf={() => {}}
        onRemove={() => {}}
        onCopy={onCopy}
      />
    )

    fireEvent.contextMenu(container.querySelector('.card') as HTMLElement)
    const items = mockShowContextMenu.mock.calls[0][0] as Array<{ key: string; onClick: () => void }>
    act(() => items.find((item) => item.key === 'copy')?.onClick())
    expect(onCopy).toHaveBeenCalledOnce()
  })

  it('keeps all summary sections in the card preview so resizing can reveal more content', () => {
    const paper = { id: 'doc-1', fileName: 'paper.pdf', title: 'Paper title' } as Document
    render(
      <PaperCard
        doc={paper}
        summary={{
          docId: 'doc-1',
          model: 'test',
          content: {
            core: 'Core summary',
            keyPoints: ['Point one', 'Point two', 'Point three', 'Point four'],
            methods: 'Methods section',
            contribution: 'Contribution section'
          },
          createdAt: 1,
          updatedAt: 1
        }}
        summarizing={false}
        summaryError={null}
        onSummarize={() => {}}
        onOpenPdf={() => {}}
        onRemove={() => {}}
      />
    )

    expect(screen.getByText('Point four')).toBeInTheDocument()
    expect(screen.getByText('Methods section')).toBeInTheDocument()
    expect(screen.getByText('Contribution section')).toBeInTheDocument()
  })

  it('keeps card bodies independently scrollable without passing the wheel to the canvas', () => {
    const onWheel = vi.fn()
    const paper = { id: 'doc-1', fileName: 'paper.pdf', title: 'Paper title' } as Document
    const { container } = render(
      <div onWheel={onWheel}>
        <PaperCard
          doc={paper}
          summary={{
            docId: 'doc-1',
            model: 'test',
            content: {
              core: 'Core summary',
              keyPoints: ['Point one'],
              methods: 'Methods section',
              contribution: 'Contribution section'
            },
            createdAt: 1,
            updatedAt: 1
          }}
          summarizing={false}
          summaryError={null}
          onSummarize={() => {}}
          onOpenPdf={() => {}}
          onRemove={() => {}}
        />
      </div>
    )

    const scrollBody = container.querySelector('[data-card-scroll]') as HTMLElement
    expect(scrollBody).toHaveClass('overflow-y-auto', 'overscroll-contain')
    fireEvent.wheel(scrollBody, { deltaY: 120 })
    expect(onWheel).not.toHaveBeenCalled()
  })

  it('gives papers, reports, and notes distinct visible type treatments', () => {
    const paper: Document = {
      id: 'doc-1',
      fileName: 'paper.pdf',
      title: 'Paper title'
    } as Document
    const note: WorkspaceNote = {
      id: 'note-1',
      workspaceId: 'ws-1',
      noteType: 'markdown',
      title: 'Note title',
      contentMd: 'Note content',
      createdAt: 1,
      updatedAt: 1
    }
    const asset: WorkspaceAsset = {
      id: 'asset-1',
      workspaceId: 'ws-1',
      fileName: 'Asset title.txt',
      filePath: '/tmp/Asset title.txt',
      sourcePath: '/tmp/Asset title.txt',
      mimeType: 'text/plain',
      previewKind: 'none',
      fileSize: 12,
      fileHash: 'asset-hash',
      fileMissing: 0,
      createdAt: 1,
      updatedAt: 1
    }

    const { container: paperContainer } = render(
      <PaperCard
        doc={paper}
        summary={null}
        summarizing={false}
        summaryError={null}
        onSummarize={() => {}}
        onOpenPdf={() => {}}
        onRemove={() => {}}
      />
    )
    const { container: reportContainer } = render(
      <ReportCard report={makeReport()} onDelete={() => {}} onUpdate={async () => true} />
    )
    const { container: noteContainer } = render(
      <NoteCard note={note} onDelete={() => {}} onUpdate={async () => true} />
    )
    const { container: assetContainer } = render(
      <AssetCard asset={asset} onOpen={() => {}} onReveal={() => {}} onDelete={() => {}} />
    )
    const { container: stickyContainer } = render(
      <StickyNoteCard
        note={{ ...note, id: 'sticky-1', noteType: 'plain', contentMd: 'Sticky text' }}
        onDelete={() => {}}
        onUpdate={async () => true}
      />
    )

    expect(paperContainer.querySelector('[data-card-kind="document"]')).toHaveClass('workspace-content-card--document')
    expect(reportContainer.querySelector('[data-card-kind="report"]')).toHaveClass('workspace-content-card--report')
    expect(noteContainer.querySelector('[data-card-kind="note"]')).toHaveClass('workspace-content-card--note')
    expect(assetContainer.querySelector('[data-card-kind="asset"]')).toHaveClass('workspace-content-card--asset')
    expect(stickyContainer.querySelector('[data-card-kind="sticky"]')).toHaveClass('workspace-content-card--sticky')
    for (const container of [paperContainer, reportContainer, noteContainer, assetContainer]) {
      expect(container.querySelector('.workspace-card-title')).toHaveClass('text-base')
      expect(container.querySelector('.workspace-card-title')).not.toHaveClass('text-sm')
    }
    expect(paperContainer.querySelector('[data-card-scroll]')).toHaveClass('workspace-card-scroll')
    expect(reportContainer.querySelector('[data-card-scroll]')).toHaveClass('workspace-card-scroll')
    expect(noteContainer.querySelector('[data-card-scroll]')).toHaveClass('workspace-card-scroll')
    expect(stickyContainer.querySelector('[data-card-scroll]')).toHaveClass('workspace-card-scroll')
    expect(screen.getByText('workspace.cardTypePaper')).toBeInTheDocument()
    expect(screen.getByText('workspace.cardTypeReport')).toBeInTheDocument()
    expect(screen.getByText('workspace.cardTypeNote')).toBeInTheDocument()
    expect(screen.queryByText('workspace.cardTypeSticky')).not.toBeInTheDocument()
    expect(stickyContainer.querySelector('.workspace-sticky-fold')).not.toBeInTheDocument()
  })
})

describe('WorkspacePanel tab header', () => {
  it('renders PDF files and workspaces as sibling tabs', async () => {
    mockWorkspacePanelState.panelView = 'pdf'
    mockPdfReaderState.activeDocumentId = 'doc-1'
    mockPdfReaderState.tabs = [{ id: 'doc-1', title: 'Paper', fileName: 'paper.pdf' }]

    render(<WorkspacePanel />)

    expect(await screen.findByRole('button', { name: 'PDF reader' })).toBeInTheDocument()
    expect(screen.getByText('Board').parentElement).toHaveClass('hidden')
    expect(screen.getByRole('tab', { name: 'Paper' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.queryByRole('tab', { name: 'Reading notes' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Research' }))
    await waitFor(() => {
      expect(mockWorkspacePanelState.setActiveWorkspace).toHaveBeenCalledWith('ws-1')
    })
  })

  it('keeps the board content inside the workspace panel without the AI chat bar', () => {
    render(<WorkspacePanel />)

    expect(screen.getByText('Board')).toBeInTheDocument()
    expect(screen.queryByText('Chat panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('resize-divider')).not.toBeInTheDocument()
  })

  it('keeps the workspace toolbar draggable while preserving interactive controls', () => {
    render(<WorkspacePanel />)

    const toolbar = screen.getByText('Research').closest('[data-testid="workspace-reader-tab-header"]')
    expect(toolbar).toHaveClass('drag-region')
    expect(toolbar).toHaveClass('items-stretch')
    const tabList = screen.getByRole('tablist', { name: 'workspace.readerTabs' })
    expect(tabList).toHaveClass(
      'workspace-reader-tabs-scroll',
      'items-stretch',
      'overflow-y-hidden'
    )
    const researchTab = screen.getByText('Research')
      .closest('[data-testid="workspace-reader-tab"]') as HTMLElement
    expect(researchTab).toHaveClass('h-full', 'rounded-tr-xl', 'border-r')
    expect(researchTab).not.toHaveClass('-mb-px', 'border-l')
    expect(screen.queryByRole('button', { name: 'workspace.switchWorkspace' })).not.toBeInTheDocument()
  })

  it('opens Markdown readers beside workspace tabs', () => {
    mockWorkspacePanelState.reports = [makeReport({ id: 'report-1' })]
    render(<WorkspacePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Open report card' }))

    expect(screen.getByRole('button', { name: 'workspace.markdownRead' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('tab', { name: 'Test Report' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Research' })).toHaveAttribute('aria-selected', 'false')
    expect(
      within(
        screen.getByRole('tab', { name: 'Test Report' })
          .closest('[data-testid="workspace-reader-tab"]') as HTMLElement
      ).getByRole('button', { name: 'workspace.closeReaderTab' })
    ).toBeInTheDocument()
    expect(screen.queryByText('Chat panel')).not.toBeInTheDocument()
  })

  it('opens a Markdown card requested by global search', async () => {
    mockWorkspacePanelState.reports = [makeReport({ id: 'report-1' })]
    mockWorkspacePanelState.markdownCardRequest = { kind: 'report', id: 'report-1' }
    mockWorkspacePanelState.panelView = 'markdown'

    render(<WorkspacePanel />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Test Report' })).toBeInTheDocument()
      expect(mockWorkspacePanelState.clearMarkdownCardRequest).toHaveBeenCalledOnce()
    })
  })

  it('keeps the current Markdown card when saving before a same-workspace switch fails', async () => {
    mockWorkspacePanelState.reports = [
      makeReport({ id: 'report-1', title: 'First report' }),
      makeReport({ id: 'report-2', title: 'Second report' })
    ]
    mockWorkspacePanelState.panelView = 'markdown'
    mockWorkspacePanelState.markdownCardRequest = { kind: 'report', id: 'report-1' }
    const view = render(<WorkspacePanel />)
    await screen.findByRole('tab', { name: 'First report' })
    fireEvent.click(screen.getByRole('button', { name: 'workspace.markdownEdit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'workspace.reportContentLabel' }), {
      target: { value: 'Unsaved draft' }
    })
    mockWorkspacePanelState.updateReport.mockResolvedValue(false)

    mockWorkspacePanelState.markdownCardRequest = { kind: 'report', id: 'report-2' }
    view.rerender(<WorkspacePanel />)

    await waitFor(() => {
      expect(mockWorkspacePanelState.updateReport).toHaveBeenCalledWith('report-1', {
        title: 'First report',
        contentMd: 'Unsaved draft'
      })
    })
    expect(screen.getByRole('tab', { name: 'First report' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Second report' })).not.toBeInTheDocument()
  })

  it('saves Markdown body edits before closing the workspace tab', async () => {
    mockWorkspacePanelState.reports = [makeReport({ id: 'report-1' })]
    render(<WorkspacePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Open report card' }))
    fireEvent.click(screen.getByRole('button', { name: 'workspace.markdownEdit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'workspace.reportContentLabel' }), {
      target: { value: 'Updated immediately before close' }
    })
    fireEvent.click(
      within(
        screen.getByRole('tab', { name: 'Test Report' })
          .closest('[data-testid="workspace-reader-tab"]') as HTMLElement
      ).getByRole('button', { name: 'workspace.closeReaderTab' })
    )

    await waitFor(() => {
      expect(mockWorkspacePanelState.updateReport).toHaveBeenCalledWith('report-1', {
        title: 'Test Report',
        contentMd: 'Updated immediately before close'
      })
      expect(mockWorkspacePanelState.showWorkspace).toHaveBeenCalledTimes(1)
    })
  })

  it('removes workspace switching from the header', () => {
    render(<WorkspacePanel />)

    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'workspace.switchWorkspace' })).not.toBeInTheDocument()
    expect(screen.queryByRole('listbox', { name: 'workspace.switchWorkspace' })).not.toBeInTheDocument()
  })

  it('closes the active workspace tab and activates another open workspace', async () => {
    const view = render(<WorkspacePanel />)

    mockWorkspacePanelState.activeWorkspaceId = 'ws-2'
    mockWorkspacePanelState.openWorkspaceIds = ['ws-1', 'ws-2']
    view.rerender(<WorkspacePanel />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Reading notes' })).toBeInTheDocument()
    })

    const readingNotesTab = screen.getByRole('tab', { name: 'Reading notes' })
      .closest('[data-testid="workspace-reader-tab"]') as HTMLElement
    const close = within(readingNotesTab).getByRole('button', {
      name: 'workspace.closeReaderTab'
    })
    fireEvent.click(close)

    await waitFor(() => {
      expect(mockWorkspacePanelState.setActiveWorkspace).toHaveBeenCalledWith('ws-1')
    })
  })

  it('closes the active workspace panel instead of leaving a blank tab bar while streaming', () => {
    mockWorkspacePanelState.chatStreaming = true
    mockWorkspacePanelState.openWorkspaceIds = ['ws-1', 'ws-2']

    render(<WorkspacePanel />)

    expect(screen.queryByRole('button', { name: 'workspace.switchWorkspace' })).not.toBeInTheDocument()
    const researchTab = screen.getByRole('tab', { name: 'Research' })
      .closest('[data-testid="workspace-reader-tab"]') as HTMLElement
    const close = within(researchTab).getByRole('button', {
      name: 'workspace.closeReaderTab'
    })
    expect(close).toBeEnabled()
    fireEvent.click(close)

    expect(mockWorkspacePanelState.closePanel).toHaveBeenCalledOnce()
    expect(mockWorkspacePanelState.setActiveWorkspace).not.toHaveBeenCalled()
  })

  it('creates Markdown notes and sticky notes from fixed canvas actions', () => {
    render(<WorkspacePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'workspace.createNote' }))
    fireEvent.click(screen.getByRole('button', { name: 'workspace.createStickyNote' }))

    expect(mockBoardCreateNote).toHaveBeenNthCalledWith(1, 'markdown')
    expect(mockBoardCreateNote).toHaveBeenNthCalledWith(2, 'plain')
    expect(screen.getByTestId('workspace-floating-actions')).toContainElement(
      screen.getByRole('button', { name: 'workspace.createNote' })
    )
  })

  it('opens the active workspace sandbox from fixed canvas actions', () => {
    const openSandbox = vi.spyOn(window.api.workspaces, 'openSandbox').mockResolvedValue()
    render(<WorkspacePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'workspace.openSandbox' }))

    expect(openSandbox).toHaveBeenCalledWith('ws-1')
    expect(screen.getByTestId('workspace-floating-actions')).toContainElement(
      screen.getByRole('button', { name: 'workspace.openSandbox' })
    )
  })

  it('keeps one shared fullscreen control at the far right of the tab header', () => {
    render(<WorkspacePanel />)

    const header = screen.getByTestId('workspace-reader-tab-header')
    const fullscreen = screen.getByRole('button', { name: 'workspace.enterFullscreen' })

    expect(header.lastElementChild).toBe(fullscreen)
    expect(screen.getAllByRole('button', { name: 'workspace.enterFullscreen' })).toHaveLength(1)
  })
})

describe('NoteCard', () => {
  const note: WorkspaceNote = {
    id: 'note-1',
    workspaceId: 'ws-1',
    noteType: 'markdown',
    title: 'Original',
    contentMd: 'Original content',
    createdAt: 1,
    updatedAt: 1
  }

  it('opens the note with the keyboard from its title action', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(
      <NoteCard
        note={note}
        onDelete={() => {}}
        onUpdate={async () => true}
        onOpen={onOpen}
      />
    )

    screen.getByRole('button', { name: 'Original' }).focus()
    await user.keyboard(' ')

    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('copies a Markdown note from its context menu', () => {
    const onCopy = vi.fn()
    const { container } = render(
      <NoteCard note={note} onDelete={() => {}} onUpdate={async () => true} onCopy={onCopy} />
    )

    fireEvent.contextMenu(container.querySelector('.card') as HTMLElement)
    const items = mockShowContextMenu.mock.calls[0][0] as Array<{ key: string; onClick: () => void }>
    act(() => items.find((item) => item.key === 'copy')?.onClick())
    expect(onCopy).toHaveBeenCalledOnce()
  })

  it('uses the report Markdown preview style and opens document citations the same way', async () => {
    const onOpen = vi.fn()
    mockOpenPdf.mockResolvedValue(undefined)
    const { container: noteContainer } = render(
      <NoteCard
        note={{
          ...note,
          contentMd: '[Source](refora://doc/source-doc)'
        }}
        onDelete={() => {}}
        onUpdate={async () => true}
        onOpen={onOpen}
      />
    )
    const { container: reportContainer } = render(
      <ReportCard
        report={makeReport()}
        onDelete={() => {}}
        onUpdate={async () => true}
      />
    )

    expect(noteContainer.querySelector('[data-card-scroll]')?.className).toBe(
      reportContainer.querySelector('[data-card-scroll]')?.className
    )
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))

    await waitFor(() => {
      expect(mockOpenPdf).toHaveBeenCalledWith('source-doc')
    })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('keeps the edited draft open when saving fails', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false)
    render(
      <NoteCard
        note={note}
        autoEdit
        onDelete={() => {}}
        onUpdate={onUpdate}
      />
    )

    const title = screen.getByRole('textbox', { name: 'workspace.noteTitleLabel' })
    const content = screen.getByRole('textbox', { name: 'workspace.noteContentLabel' })
    fireEvent.change(title, { target: { value: 'Edited title' } })
    fireEvent.change(content, { target: { value: '# Edited content' } })
    fireEvent.click(screen.getByRole('button', { name: 'workspace.noteSave' }))

    await waitFor(() => {
      expect(screen.getByText('workspace.noteSaveFailed')).toBeInTheDocument()
    })
    expect(title).toHaveValue('Edited title')
    expect(content).toHaveValue('# Edited content')
    expect(onUpdate).toHaveBeenCalledWith('note-1', {
      title: 'Edited title',
      contentMd: '# Edited content'
    })
  })
})

describe('StickyNoteCard', () => {
  const note: WorkspaceNote = {
    id: 'sticky-1',
    workspaceId: 'ws-1',
    noteType: 'plain',
    color: 'mint',
    title: 'Sticky note',
    contentMd: 'Original text',
    createdAt: 1,
    updatedAt: 1
  }

  it('copies the current plain-text draft from its context menu', () => {
    const onCopy = vi.fn()
    const { container } = render(
      <StickyNoteCard note={note} onDelete={() => {}} onUpdate={async () => true} onCopy={onCopy} />
    )
    const content = screen.getByRole('textbox', { name: 'workspace.stickyNoteContentLabel' })
    fireEvent.click(content)
    fireEvent.change(content, { target: { value: 'Current unsaved text' } })
    fireEvent.contextMenu(container.querySelector('.card') as HTMLElement)
    const items = mockShowContextMenu.mock.calls[0][0] as Array<{ key: string; onClick?: () => void }>
    act(() => items.find((item) => item.key === 'copy')?.onClick?.())
    expect(onCopy).toHaveBeenCalledWith('Current unsaved text')
  })

  it('renders its selected preset as a solid card color', () => {
    const { container } = render(
      <StickyNoteCard note={note} onDelete={() => {}} onUpdate={async () => true} />
    )
    const sticky = container.querySelector('[data-card-kind="sticky"]') as HTMLElement

    expect(sticky).toHaveAttribute('data-sticky-color', 'mint')
    expect(sticky).toHaveStyle({ background: '#C9E9DA' })
    expect(sticky.style.backgroundImage).toBe('none')
  })

  it('enters inline editing only after a click and exits on blur', async () => {
    const onUpdate = vi.fn().mockResolvedValue(true)
    render(
      <StickyNoteCard
        note={note}
        onDelete={() => {}}
        onUpdate={onUpdate}
      />
    )

    const content = screen.getByRole('textbox', { name: 'workspace.stickyNoteContentLabel' })
    expect(content).toHaveAttribute('readonly')
    expect(content).toHaveClass('cursor-default')
    expect(content).toHaveAttribute('data-card-drag-click', 'true')

    fireEvent.click(content)
    expect(content).not.toHaveAttribute('readonly')
    expect(content).toHaveClass('cursor-text')
    expect(content).not.toHaveAttribute('data-card-drag-click')

    fireEvent.change(content, { target: { value: 'Edited plain text' } })
    fireEvent.blur(content)

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('sticky-1', { contentMd: 'Edited plain text' })
    })
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument()
    expect(content).toHaveValue('Edited plain text')
    expect(content).toHaveAttribute('readonly')
  })

  it('enters and exits inline editing from the keyboard', () => {
    render(
      <StickyNoteCard
        note={note}
        onDelete={() => {}}
        onUpdate={async () => true}
      />
    )

    const content = screen.getByRole('textbox', { name: 'workspace.stickyNoteContentLabel' })
    content.focus()
    fireEvent.keyDown(content, { key: 'Enter' })
    expect(content).not.toHaveAttribute('readonly')

    fireEvent.keyDown(content, { key: 'Escape' })
    expect(content).toHaveAttribute('readonly')
  })

  it('keeps the inline draft visible when autosave fails', async () => {
    const onUpdate = vi.fn().mockResolvedValue(false)
    render(
      <StickyNoteCard
        note={note}
        onDelete={() => {}}
        onUpdate={onUpdate}
      />
    )

    const content = screen.getByRole('textbox', { name: 'workspace.stickyNoteContentLabel' })
    fireEvent.click(content)
    fireEvent.change(content, { target: { value: 'Unsaved text' } })
    fireEvent.blur(content)

    await waitFor(() => {
      expect(screen.getByText('workspace.stickyNoteSaveFailed')).toBeInTheDocument()
    })
    expect(content).toHaveValue('Unsaved text')
  })

  it('persists a pending inline draft when the card unmounts', async () => {
    const onUpdate = vi.fn().mockResolvedValue(true)
    const { unmount } = render(
      <StickyNoteCard
        note={note}
        onDelete={() => {}}
        onUpdate={onUpdate}
      />
    )

    const content = screen.getByRole('textbox', { name: 'workspace.stickyNoteContentLabel' })
    fireEvent.click(content)
    fireEvent.change(content, { target: { value: 'Saved on unmount' } })
    unmount()

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('sticky-1', { contentMd: 'Saved on unmount' })
    })
  })
})

describe('ResizableCard', () => {
  it('supports keyboard positioning from the card without rendering a move handle', () => {
    const onPositionChange = vi.fn()
    const onPositionCommit = vi.fn()
    render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 100, y: 200, zIndex: 2 }}
        getScale={() => 1}
        frontZIndex={5}
        onSizeChange={() => {}}
        onSizeCommit={() => {}}
        onPositionChange={onPositionChange}
        onPositionCommit={onPositionCommit}
        moveLabel="Move card"
      >
        <div>Content</div>
      </ResizableCard>
    )

    const card = screen.getByRole('group', { name: 'Move card' })
    expect(screen.queryByRole('button', { name: 'Move card' })).toBeNull()
    fireEvent.keyDown(card, { key: 'ArrowLeft' })
    fireEvent.keyDown(card, { key: 'ArrowDown', shiftKey: true })

    expect(onPositionCommit).toHaveBeenNthCalledWith(1, 'item-1', { x: 90, y: 200, zIndex: 5 })
    expect(onPositionCommit).toHaveBeenNthCalledWith(2, 'item-1', { x: 100, y: 250, zIndex: 5 })
  })

  it('exposes visible keyboard controls for resizing width and height', () => {
    const onSizeChange = vi.fn()
    const onSizeCommit = vi.fn()
    render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 0, y: 0, zIndex: 0 }}
        getScale={() => 1}
        frontZIndex={1}
        onSizeChange={onSizeChange}
        onSizeCommit={onSizeCommit}
        onPositionChange={() => {}}
        onPositionCommit={() => {}}
        resizeWidthLabel="Resize width"
        resizeHeightLabel="Resize height"
        resizeBothLabel="Resize both"
      >
        <div>Content</div>
      </ResizableCard>
    )

    const widthHandle = screen.getByRole('button', { name: 'Resize width' })
    const heightHandle = screen.getByRole('button', { name: 'Resize height' })
    expect(widthHandle).toHaveClass('focus:opacity-100', 'focus-visible:ring-2')
    expect(heightHandle).toHaveClass('focus:opacity-100', 'focus-visible:ring-2')

    fireEvent.keyDown(widthHandle, { key: 'ArrowRight' })
    fireEvent.keyDown(heightHandle, { key: 'ArrowUp', shiftKey: true })

    expect(onSizeChange).toHaveBeenNthCalledWith(1, 'item-1', { width: 310, height: 200 })
    expect(onSizeChange).toHaveBeenNthCalledWith(2, 'item-1', { width: 310, height: 150 })
    expect(onSizeCommit).toHaveBeenLastCalledWith('item-1', { width: 310, height: 150 })
  })

  it('commits the final size in world coordinates when resizing a zoomed canvas', () => {
    const onSizeChange = vi.fn()
    const onSizeCommit = vi.fn()
    const { container } = render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 0, y: 0, zIndex: 0 }}
        getScale={() => 2}
        frontZIndex={1}
        onSizeChange={onSizeChange}
        onSizeCommit={onSizeCommit}
        onPositionChange={() => {}}
        onPositionCommit={() => {}}
      >
        <div>Content</div>
      </ResizableCard>
    )
    const corner = container.querySelector('.cursor-nwse-resize') as HTMLElement

    fireEvent.pointerDown(corner, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 180, clientY: 150 })
    fireEvent.pointerUp(document, { pointerId: 1 })

    expect(onSizeChange).toHaveBeenLastCalledWith('item-1', { width: 340, height: 225 })
    expect(onSizeCommit).toHaveBeenCalledWith('item-1', { width: 340, height: 225 })
  })

  it('resizes beyond the former card bounds while keeping dimensions positive', () => {
    const onSizeChange = vi.fn()
    const onSizeCommit = vi.fn()
    const { container } = render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 0, y: 0, zIndex: 0 }}
        getScale={() => 1}
        frontZIndex={1}
        onSizeChange={onSizeChange}
        onSizeCommit={onSizeCommit}
        onPositionChange={() => {}}
        onPositionCommit={() => {}}
      >
        <div>Content</div>
      </ResizableCard>
    )
    const corner = container.querySelector('.cursor-nwse-resize') as HTMLElement

    fireEvent.pointerDown(corner, { pointerId: 21, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(document, { pointerId: 21, clientX: 900, clientY: 800 })
    fireEvent.pointerUp(document, { pointerId: 21 })

    expect(onSizeChange).toHaveBeenLastCalledWith('item-1', { width: 1200, height: 1000 })
    expect(onSizeCommit).toHaveBeenCalledWith('item-1', { width: 1200, height: 1000 })
  })

  it('previews movement immediately and commits after crossing the drag threshold', async () => {
    const onPositionChange = vi.fn()
    const onPositionCommit = vi.fn()
    const onOpen = vi.fn()
    render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: -20, y: 40, zIndex: 1 }}
        getScale={() => 0.5}
        frontZIndex={8}
        onSizeChange={() => {}}
        onSizeCommit={() => {}}
        onPositionChange={onPositionChange}
        onPositionCommit={onPositionCommit}
        moveLabel="Move card"
      >
        <div data-card-kind="note" onClick={onOpen}>Content</div>
      </ResizableCard>
    )

    const content = screen.getByText('Content')
    const setPointerCapture = vi.fn()
    content.setPointerCapture = setPointerCapture
    fireEvent.pointerDown(content, { pointerId: 2, button: 0, clientX: 100, clientY: 100 })
    expect(setPointerCapture).not.toHaveBeenCalled()
    fireEvent.pointerMove(document, { pointerId: 2, clientX: 103, clientY: 102 })
    expect(setPointerCapture).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(onPositionChange).toHaveBeenLastCalledWith('item-1', { x: -14, y: 44, zIndex: 1 })
    })
    fireEvent.pointerMove(document, { pointerId: 2, clientX: 130, clientY: 80 })
    expect(setPointerCapture).toHaveBeenCalledWith(2)
    fireEvent.pointerUp(document, { pointerId: 2 })
    fireEvent.click(content)

    expect(onPositionChange).toHaveBeenLastCalledWith('item-1', { x: 40, y: 0, zIndex: 8 })
    expect(onPositionCommit).toHaveBeenCalledWith('item-1', { x: 40, y: 0, zIndex: 8 })
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.pointerDown(content, { pointerId: 5, button: 0, clientX: 130, clientY: 80 })
    fireEvent.pointerUp(document, { pointerId: 5 })
    fireEvent.click(content)

    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('continues dragging when pointer capture fails', () => {
    const onPositionChange = vi.fn()
    const onPositionCommit = vi.fn()
    render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 10, y: 20, zIndex: 1 }}
        getScale={() => 1}
        frontZIndex={4}
        onSizeChange={() => {}}
        onSizeCommit={() => {}}
        onPositionChange={onPositionChange}
        onPositionCommit={onPositionCommit}
      >
        <div data-card-kind="note">Content without capture</div>
      </ResizableCard>
    )

    const content = screen.getByText('Content without capture')
    content.setPointerCapture = vi.fn(() => {
      throw new DOMException('Pointer is not active', 'NotFoundError')
    })

    fireEvent.pointerDown(content, { pointerId: 34, button: 0, clientX: 20, clientY: 30 })
    fireEvent.pointerMove(document, { pointerId: 34, clientX: 50, clientY: 45 })
    fireEvent.pointerUp(document, { pointerId: 34 })

    expect(onPositionChange).toHaveBeenLastCalledWith('item-1', { x: 40, y: 35, zIndex: 4 })
    expect(onPositionCommit).toHaveBeenCalledWith('item-1', { x: 40, y: 35, zIndex: 4 })
  })

  it('coalesces pointer movement into one visual update per animation frame', () => {
    const onPositionChange = vi.fn()
    const onPositionCommit = vi.fn()
    let frame: FrameRequestCallback | null = null
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback
      return 42
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 0, y: 0, zIndex: 1 }}
        getScale={() => 1}
        frontZIndex={5}
        onSizeChange={() => {}}
        onSizeCommit={() => {}}
        onPositionChange={onPositionChange}
        onPositionCommit={onPositionCommit}
      >
        <div>Frame content</div>
      </ResizableCard>
    )

    fireEvent.pointerDown(screen.getByText('Frame content'), { pointerId: 8, button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(document, { pointerId: 8, clientX: 20, clientY: 10 })
    fireEvent.pointerMove(document, { pointerId: 8, clientX: 40, clientY: 25 })
    fireEvent.pointerMove(document, { pointerId: 8, clientX: 60, clientY: 35 })

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(onPositionChange).not.toHaveBeenCalled()
    act(() => frame?.(16))
    expect(onPositionChange).toHaveBeenCalledTimes(1)
    expect(onPositionChange).toHaveBeenCalledWith('item-1', { x: 60, y: 35, zIndex: 5 })

    fireEvent.pointerUp(document, { pointerId: 8 })
    expect(onPositionCommit).toHaveBeenCalledWith('item-1', { x: 60, y: 35, zIndex: 5 })
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  })

  it('reports cancelled drag and resize interactions without committing them', () => {
    const onPositionCancel = vi.fn()
    const onPositionCommit = vi.fn()
    const onSizeCancel = vi.fn()
    const onSizeCommit = vi.fn()
    const { container } = render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 20, y: 30, zIndex: 1 }}
        getScale={() => 1}
        frontZIndex={5}
        onSizeChange={() => {}}
        onSizeCommit={onSizeCommit}
        onSizeCancel={onSizeCancel}
        onPositionChange={() => {}}
        onPositionCommit={onPositionCommit}
        onPositionCancel={onPositionCancel}
      >
        <div>Cancelable content</div>
      </ResizableCard>
    )
    const card = container.querySelector('[data-workspace-card]') as HTMLElement

    fireEvent.pointerDown(screen.getByText('Cancelable content'), {
      pointerId: 12,
      button: 0,
      clientX: 20,
      clientY: 20
    })
    fireEvent.pointerMove(document, { pointerId: 12, clientX: 80, clientY: 60 })
    fireEvent.pointerCancel(document, { pointerId: 12 })

    expect(card.style.transform).toBe('translate3d(20px, 30px, 0)')
    expect(onPositionCancel).toHaveBeenCalledWith('item-1')
    expect(onPositionCommit).not.toHaveBeenCalled()

    const corner = container.querySelector('.cursor-nwse-resize') as HTMLElement
    fireEvent.pointerDown(corner, { pointerId: 13, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(document, { pointerId: 13, clientX: 150, clientY: 140 })
    fireEvent.pointerCancel(document, { pointerId: 13 })

    expect(card.style.width).toBe('300px')
    expect(card.style.height).toBe('200px')
    expect(onSizeCancel).toHaveBeenCalledWith('item-1')
    expect(onSizeCommit).not.toHaveBeenCalled()
  })

  it('previews small movement immediately, then rolls back and opens on click', () => {
    const onPositionChange = vi.fn()
    const onPositionCommit = vi.fn()
    const onPositionCancel = vi.fn()
    const onOpen = vi.fn()
    render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 0, y: 0, zIndex: 0 }}
        getScale={() => 1}
        frontZIndex={1}
        onSizeChange={() => {}}
        onSizeCommit={() => {}}
        onPositionChange={onPositionChange}
        onPositionCommit={onPositionCommit}
        onPositionCancel={onPositionCancel}
        moveLabel="Move card"
      >
        <div data-card-kind="note" onClick={onOpen}>Content</div>
      </ResizableCard>
    )

    const card = screen.getByRole('group', { name: 'Move card' })
    const content = screen.getByText('Content')
    const captureContentPointer = vi.fn()
    content.setPointerCapture = captureContentPointer

    fireEvent.pointerDown(content, { pointerId: 3, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(document, { pointerId: 3, clientX: 14, clientY: 10 })
    fireEvent.pointerUp(document, { pointerId: 3 })
    fireEvent.click(content)

    expect(captureContentPointer).not.toHaveBeenCalled()
    expect(onPositionChange).toHaveBeenCalledWith('item-1', { x: 4, y: 0, zIndex: 0 })
    expect(onPositionCommit).not.toHaveBeenCalled()
    expect(onPositionCancel).toHaveBeenCalledWith('item-1')
    expect(card.style.transform).toBe('translate3d(0px, 0px, 0)')
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('does not start a drag from an interactive control', () => {
    const onPositionChange = vi.fn()
    render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 0, y: 0, zIndex: 0 }}
        getScale={() => 1}
        frontZIndex={1}
        onSizeChange={() => {}}
        onSizeCommit={() => {}}
        onPositionChange={onPositionChange}
        onPositionCommit={() => {}}
        moveLabel="Move card"
      >
        <button type="button">Open</button>
      </ResizableCard>
    )

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open' }), { pointerId: 4, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(document, { pointerId: 4, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(document, { pointerId: 4 })

    expect(onPositionChange).not.toHaveBeenCalled()
  })

  it('uses the card drag threshold for the clickable paper preview', () => {
    const onOpenPdf = vi.fn()
    const onPositionChange = vi.fn()
    const onPositionCommit = vi.fn()
    const paper = {
      id: 'doc-1',
      fileName: 'paper.pdf',
      fileHash: 'hash-1',
      updatedAt: 1,
      fileMissing: 0,
      title: 'Paper title'
    } as Document
    render(
      <ResizableCard
        sizeKey="item-1"
        size={{ width: 300, height: 200 }}
        position={{ x: 10, y: 20, zIndex: 1 }}
        getScale={() => 1}
        frontZIndex={4}
        onSizeChange={() => {}}
        onSizeCommit={() => {}}
        onPositionChange={onPositionChange}
        onPositionCommit={onPositionCommit}
      >
        <PaperCard
          doc={paper}
          summary={null}
          summarizing={false}
          summaryError={null}
          onSummarize={() => {}}
          onOpenPdf={onOpenPdf}
          onRemove={() => {}}
        />
      </ResizableCard>
    )
    const preview = screen.getByRole('button', { name: 'workspace.pdfPreview' })
    preview.setPointerCapture = vi.fn()

    expect(preview).toHaveClass('cursor-pointer')
    fireEvent.pointerDown(preview, { pointerId: 31, button: 0, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(document, { pointerId: 31 })
    fireEvent.click(preview)

    expect(onOpenPdf).toHaveBeenCalledOnce()
    expect(onPositionCommit).not.toHaveBeenCalled()

    fireEvent.pointerDown(preview, { pointerId: 32, button: 0, clientX: 30, clientY: 40 })
    fireEvent.pointerMove(document, { pointerId: 32, clientX: 60, clientY: 65 })
    fireEvent.pointerUp(document, { pointerId: 32 })
    fireEvent.click(preview)

    expect(onPositionChange).toHaveBeenLastCalledWith('item-1', { x: 40, y: 45, zIndex: 4 })
    expect(onPositionCommit).toHaveBeenCalledWith('item-1', { x: 40, y: 45, zIndex: 4 })
    expect(onOpenPdf).toHaveBeenCalledOnce()
  })
})
