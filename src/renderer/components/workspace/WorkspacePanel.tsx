import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FolderOpen, NotePencil, Sticker } from '@phosphor-icons/react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import Board, {
  type BoardHandle,
  type WorkspaceMarkdownCard,
  type WorkspaceMarkdownCardMode
} from './Board'
import WorkspaceMarkdownView, {
  type WorkspaceMarkdownViewHandle
} from './WorkspaceMarkdownView'
import WorkspaceReaderTabs, { type WorkspaceReaderTab } from './WorkspaceReaderTabs'
import { aiSummaryMarkdown } from '../../utils/workspaceCardMarkdown'
import PdfReader from '../PdfReader'
import { usePdfReaderStore } from '../../store/pdfReaderStore'

type ActiveMarkdownCard = WorkspaceMarkdownCard & { mode: WorkspaceMarkdownCardMode }

function markdownCardId(card: ActiveMarkdownCard): string {
  return card.kind === 'summary' ? card.doc.id : card.id
}

function isSameMarkdownCard(
  first: ActiveMarkdownCard | null,
  second: ActiveMarkdownCard
): boolean {
  return first?.kind === second.kind && (
    first ? markdownCardId(first) === markdownCardId(second) : false
  )
}

function markdownTabId(card: ActiveMarkdownCard): string {
  return `markdown:${card.kind}:${markdownCardId(card)}`
}

export default function WorkspacePanel() {
  const { t } = useTranslation()
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const panelView = useWorkspaceStore((s) => s.panelView)
  const fullscreen = useWorkspaceStore((s) => s.fullscreen)
  const reports = useWorkspaceStore((s) => s.reports)
  const notes = useWorkspaceStore((s) => s.notes)
  const markdownCardRequest = useWorkspaceStore((s) => s.markdownCardRequest)
  const toggleFullscreen = useWorkspaceStore((s) => s.toggleFullscreen)
  const closePanel = useWorkspaceStore((s) => s.closePanel)
  const showWorkspace = useWorkspaceStore((s) => s.showWorkspace)
  const showMarkdown = useWorkspaceStore((s) => s.showMarkdown)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const clearMarkdownCardRequest = useWorkspaceStore((s) => s.clearMarkdownCardRequest)
  const updateNote = useWorkspaceStore((s) => s.updateNote)
  const updateReport = useWorkspaceStore((s) => s.updateReport)
  const pdfTabs = usePdfReaderStore((s) => s.tabs)
  const activePdfDocumentId = usePdfReaderStore((s) => s.activeDocumentId)

  const [activeMarkdownCard, setActiveMarkdownCard] = useState<ActiveMarkdownCard | null>(null)
  const [markdownTabs, setMarkdownTabs] = useState<ActiveMarkdownCard[]>([])
  const [closedWorkspaceIds, setClosedWorkspaceIds] = useState<Set<string>>(() => new Set())
  const boardRef = useRef<BoardHandle | null>(null)
  const markdownViewRef = useRef<WorkspaceMarkdownViewHandle | null>(null)

  useEffect(() => {
    setActiveMarkdownCard(null)
    setMarkdownTabs([])
  }, [activeWorkspaceId])

  useEffect(() => {
    if (panelView !== 'workspace' || !activeWorkspaceId) return
    setClosedWorkspaceIds((current) => {
      if (!current.has(activeWorkspaceId)) return current
      const next = new Set(current)
      next.delete(activeWorkspaceId)
      return next
    })
  }, [activeWorkspaceId, panelView])

  useEffect(() => {
    if (!markdownCardRequest) return
    const card: ActiveMarkdownCard = { ...markdownCardRequest, mode: 'read' }
    setActiveMarkdownCard(card)
    setMarkdownTabs((current) => current.some(
      (item) => isSameMarkdownCard(item, card)
    ) ? current : [...current, card])
    clearMarkdownCardRequest()
  }, [clearMarkdownCardRequest, markdownCardRequest])

  const handleOpenMarkdownCard = useCallback((
    card: WorkspaceMarkdownCard,
    mode: WorkspaceMarkdownCardMode = 'read'
  ) => {
    const next = { ...card, mode }
    setActiveMarkdownCard(next)
    setMarkdownTabs((current) => current.some(
      (item) => isSameMarkdownCard(item, next)
    ) ? current : [...current, next])
    showMarkdown()
  }, [showMarkdown])

  const handleBackToBoard = useCallback(() => {
    showWorkspace()
  }, [showWorkspace])

  const handleOpenSandbox = useCallback(() => {
    if (!activeWorkspaceId) return
    void window.api.workspaces.openSandbox(activeWorkspaceId).catch(() => undefined)
  }, [activeWorkspaceId])

  const activeNote = activeMarkdownCard?.kind === 'note'
    ? notes.find((note) => note.id === activeMarkdownCard.id) ?? null
    : null
  const activeReport = activeMarkdownCard?.kind === 'report'
    ? reports.find((report) => report.id === activeMarkdownCard.id) ?? null
    : null
  const activeSummary = activeMarkdownCard?.kind === 'summary'
    ? activeMarkdownCard
    : null

  const activeMarkdownTabId = activeMarkdownCard
    ? markdownTabId(activeMarkdownCard)
    : null

  const saveActiveMarkdown = useCallback(async () => {
    if (panelView !== 'markdown') return true
    return markdownViewRef.current?.requestClose() ?? true
  }, [panelView])

  const handleSelectWorkspace = useCallback(async (workspaceId: string) => {
    if (!(await saveActiveMarkdown())) return
    setActiveWorkspace(workspaceId)
  }, [saveActiveMarkdown, setActiveWorkspace])

  const handleSelectMarkdown = useCallback(async (card: ActiveMarkdownCard) => {
    if (!(await saveActiveMarkdown())) return
    setActiveMarkdownCard(card)
    showMarkdown()
  }, [saveActiveMarkdown, showMarkdown])

  const handleCloseMarkdown = useCallback(async (card: ActiveMarkdownCard) => {
    const isActive = isSameMarkdownCard(activeMarkdownCard, card)
    if (isActive && !(await saveActiveMarkdown())) return
    setMarkdownTabs((current) => current.filter(
      (item) => !isSameMarkdownCard(item, card)
    ))
    if (isActive) {
      setActiveMarkdownCard(null)
      showWorkspace()
    }
  }, [activeMarkdownCard, saveActiveMarkdown, showWorkspace])

  const handleSelectPdf = useCallback(async (documentId: string) => {
    if (!(await saveActiveMarkdown())) return
    usePdfReaderStore.getState().activate(documentId)
    useWorkspaceStore.getState().openPdfReader()
  }, [saveActiveMarkdown])

  const handleClosePdf = useCallback((documentId: string) => {
    const isActive = panelView === 'pdf' && activePdfDocumentId === documentId
    const hasRemainingPdf = pdfTabs.some((tab) => tab.id !== documentId)
    usePdfReaderStore.getState().close(documentId)
    if (isActive && !hasRemainingPdf) {
      if (activeWorkspaceId) showWorkspace()
      else closePanel()
    }
  }, [
    activePdfDocumentId,
    activeWorkspaceId,
    closePanel,
    panelView,
    pdfTabs,
    showWorkspace
  ])

  const handleCloseWorkspace = useCallback((workspaceId: string) => {
    setClosedWorkspaceIds((current) => new Set(current).add(workspaceId))
    if (panelView !== 'workspace' || activeWorkspaceId !== workspaceId) return
    const nextWorkspace = workspaces.find(
      (workspace) => workspace.id !== workspaceId && !closedWorkspaceIds.has(workspace.id)
    )
    if (nextWorkspace) {
      setActiveWorkspace(nextWorkspace.id)
    } else if (activeMarkdownCard) {
      showMarkdown()
    } else if (pdfTabs[0]) {
      usePdfReaderStore.getState().activate(pdfTabs[0].id)
      useWorkspaceStore.getState().openPdfReader()
    } else {
      closePanel()
    }
  }, [
    activeMarkdownCard,
    activeWorkspaceId,
    closePanel,
    closedWorkspaceIds,
    panelView,
    pdfTabs,
    setActiveWorkspace,
    showMarkdown,
    workspaces
  ])

  let markdownView = null
  if (activeNote) {
    markdownView = (
      <WorkspaceMarkdownView
        ref={markdownViewRef}
        key={`note:${activeNote.id}`}
        kind="note"
        id={activeNote.id}
        title={activeNote.title}
        contentMd={activeNote.contentMd}
        timestamp={activeNote.updatedAt}
        initialMode={activeMarkdownCard?.mode}
        fullscreen={fullscreen}
        embedded
        onBack={handleBackToBoard}
        onClose={() => {
          if (activeMarkdownCard) void handleCloseMarkdown(activeMarkdownCard)
        }}
        onUpdate={updateNote}
      />
    )
  } else if (activeReport) {
    markdownView = (
      <WorkspaceMarkdownView
        ref={markdownViewRef}
        key={`report:${activeReport.id}`}
        kind="report"
        id={activeReport.id}
        title={activeReport.title}
        contentMd={activeReport.contentMd}
        timestamp={activeReport.createdAt}
        initialMode={activeMarkdownCard?.mode}
        fullscreen={fullscreen}
        embedded
        onBack={handleBackToBoard}
        onClose={() => {
          if (activeMarkdownCard) void handleCloseMarkdown(activeMarkdownCard)
        }}
        onUpdate={updateReport}
      />
    )
  } else if (activeSummary) {
    markdownView = (
      <WorkspaceMarkdownView
        ref={markdownViewRef}
        key={'summary:' + activeSummary.doc.id + ':' + activeSummary.summary.updatedAt}
        kind="summary"
        id={activeSummary.doc.id}
        title={activeSummary.doc.title || activeSummary.doc.fileName}
        contentMd={aiSummaryMarkdown(activeSummary.summary)}
        timestamp={activeSummary.summary.updatedAt}
        fullscreen={fullscreen}
        embedded
        onBack={handleBackToBoard}
        onClose={() => {
          if (activeMarkdownCard) void handleCloseMarkdown(activeMarkdownCard)
        }}
      />
    )
  }

  const readerTabs: WorkspaceReaderTab[] = [
    ...workspaces.filter(
      (workspace) => !closedWorkspaceIds.has(workspace.id)
    ).map((workspace) => ({
      id: `workspace:${workspace.id}`,
      title: workspace.name,
      kind: 'workspace' as const,
      active: panelView === 'workspace' && activeWorkspaceId === workspace.id,
      onSelect: () => void handleSelectWorkspace(workspace.id),
      onClose: () => handleCloseWorkspace(workspace.id)
    })),
    ...markdownTabs.map((card) => {
      const note = card.kind === 'note'
        ? notes.find((item) => item.id === card.id)
        : null
      const report = card.kind === 'report'
        ? reports.find((item) => item.id === card.id)
        : null
      const title = card.kind === 'summary'
        ? card.doc.title || card.doc.fileName
        : note?.title ?? report?.title ?? t(
          card.kind === 'note' ? 'workspace.cardTypeNote' : 'workspace.cardTypeReport'
        )
      return {
        id: markdownTabId(card),
        title,
        kind: 'markdown' as const,
        active: panelView === 'markdown' &&
          activeMarkdownTabId === markdownTabId(card),
        onSelect: () => void handleSelectMarkdown(card),
        onClose: () => void handleCloseMarkdown(card)
      }
    }),
    ...pdfTabs.map((document) => ({
      id: `pdf:${document.id}`,
      title: document.title || document.fileName,
      kind: 'pdf' as const,
      active: panelView === 'pdf' && activePdfDocumentId === document.id,
      onSelect: () => void handleSelectPdf(document.id),
      onClose: () => handleClosePdf(document.id)
    }))
  ]

  return (
    <div
      className={`flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background ${
        fullscreen ? 'workspace-fullscreen' : ''
      }`}
    >
      <WorkspaceReaderTabs
        tabs={readerTabs}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
      />
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className={`relative ${panelView === 'workspace' ? 'h-full' : 'hidden'}`}>
          <Board ref={boardRef} onOpenMarkdownCard={handleOpenMarkdownCard} />
          {panelView === 'workspace' ? (
            <div
              className="absolute bottom-5 right-5 z-50 flex items-center gap-1 rounded-xl border border-border bg-background/95 p-1.5 shadow-xl backdrop-blur"
              data-testid="workspace-floating-actions"
            >
              <button
                type="button"
                className="sidebar-header-btn"
                onClick={() => boardRef.current?.addFiles()}
                disabled={!activeWorkspaceId}
                title={t('workspace.assetAdd')}
                aria-label={t('workspace.assetAdd')}
              >
                <FilePlus className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="sidebar-header-btn"
                onClick={() => boardRef.current?.createNote('markdown')}
                disabled={!activeWorkspaceId}
                title={t('workspace.createNote')}
                aria-label={t('workspace.createNote')}
              >
                <NotePencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="sidebar-header-btn"
                onClick={() => boardRef.current?.createNote('plain')}
                disabled={!activeWorkspaceId}
                title={t('workspace.createStickyNote')}
                aria-label={t('workspace.createStickyNote')}
              >
                <Sticker className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="sidebar-header-btn"
                onClick={handleOpenSandbox}
                disabled={!activeWorkspaceId}
                title={t('workspace.openSandbox')}
                aria-label={t('workspace.openSandbox')}
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            </div>
          ) : null}
        </div>
        {markdownView ? (
          <div className={panelView === 'markdown' ? 'h-full' : 'hidden'}>
            {markdownView}
          </div>
        ) : null}
        {activePdfDocumentId ? (
          <div className={panelView === 'pdf' ? 'h-full' : 'hidden'}>
            <PdfReader embedded />
          </div>
        ) : null}
      </div>
    </div>
  )
}
