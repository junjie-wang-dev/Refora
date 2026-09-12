import { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Code, FilePlus, FolderOpen, NotePencil, Sticker } from '@phosphor-icons/react'
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
import { usePdfReaderStore } from '../../store/pdfReaderStore'
import { useDocumentStore } from '../../store/documentStore'
import type { WorkspaceItemPlacement } from '../../../shared/ipc-types'
import WorkspaceLatexDialog from './WorkspaceLatexDialog'
import type { LatexProject, LatexRequest } from '../../../shared/latex-types'
import type { WorkspaceLatexViewHandle } from '../latex/WorkspaceLatexView'
import { errorMessage } from '../../../shared/ipc-types'

const WorkspaceLatexView = lazy(() => import('../latex/WorkspaceLatexView'))

const PdfReader = lazy(() => import('../PdfReader'))

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
  const openWorkspaceIds = useWorkspaceStore((s) => s.openWorkspaceIds)
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
  const requestActiveWorkspace = useWorkspaceStore((s) => s.requestActiveWorkspace)
  const closeWorkspaceTab = useWorkspaceStore((s) => s.closeWorkspaceTab)
  const clearMarkdownCardRequest = useWorkspaceStore((s) => s.clearMarkdownCardRequest)
  const updateNote = useWorkspaceStore((s) => s.updateNote)
  const updateReport = useWorkspaceStore((s) => s.updateReport)
  const fetchLatexProjects = useWorkspaceStore((s) => s.fetchLatexProjects)
  const pdfTabs = usePdfReaderStore((s) => s.tabs)
  const activePdfDocumentId = usePdfReaderStore((s) => s.activeDocumentId)

  const [activeMarkdownCard, setActiveMarkdownCard] = useState<ActiveMarkdownCard | null>(null)
  const [latexTabs, setLatexTabs] = useState<Array<{ project: LatexProject; path: string | null }>>([])
  const [activeLatexId, setActiveLatexId] = useState<string | null>(null)
  const [latexPlacement, setLatexPlacement] = useState<WorkspaceItemPlacement | null>(null)
  const latexViews = useRef(new Map<string, WorkspaceLatexViewHandle>())
  const latexContextQueue = useRef<Promise<void>>(Promise.resolve())
  const selectedLatex = latexTabs.find((tab) => tab.project.id === activeLatexId)
  const [markdownTabs, setMarkdownTabs] = useState<ActiveMarkdownCard[]>([])
  const boardRef = useRef<BoardHandle | null>(null)
  const markdownViewRef = useRef<WorkspaceMarkdownViewHandle | null>(null)

  useEffect(() => {
    setActiveMarkdownCard(null)
    setMarkdownTabs([])
    setLatexTabs([])
    setActiveLatexId(null)
    setLatexPlacement(null)
  }, [activeWorkspaceId])

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
    void window.api.workspaces.openSandbox(activeWorkspaceId).catch((error) => {
      useDocumentStore.getState().showToast(
        errorMessage(error, t('workspace.openSandboxFailed'))
      )
    })
  }, [activeWorkspaceId, t])

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

  const saveActiveContent = useCallback(async () => {
    if (panelView === 'latex' && activeLatexId) return latexViews.current.get(activeLatexId)?.requestClose() ?? true
    if (panelView !== 'markdown') return true
    return markdownViewRef.current?.requestClose() ?? true
  }, [panelView, activeLatexId])

  const openLatexProject = useCallback(async (project: LatexProject) => {
    await fetchLatexProjects?.()
    setLatexTabs((tabs) => tabs.some((tab) => tab.project.id === project.id) ? tabs : [...tabs, { project, path: null }])
    setActiveLatexId(project.id)
    setLatexPlacement(null)
    useWorkspaceStore.setState((state) => ({ panelView: 'latex', openWorkspaceIds: activeWorkspaceId && !state.openWorkspaceIds.includes(activeWorkspaceId) ? [...state.openWorkspaceIds, activeWorkspaceId] : state.openWorkspaceIds }))
  }, [fetchLatexProjects, activeWorkspaceId])

  const returnToWorkspace = useCallback(() => {
    showWorkspace()
    void fetchLatexProjects?.()
  }, [showWorkspace, fetchLatexProjects])

  const updateLatexFile = useCallback((projectId: string, path: string) => {
    setLatexTabs((tabs) => tabs.map((tab) => tab.project.id === projectId && tab.path !== path ? { ...tab, path } : tab))
  }, [])

  const closeLatexProject = useCallback(async (id: string) => {
    if (latexViews.current.has(id) && !await latexViews.current.get(id)!.requestClose()) return
    const remaining = latexTabs.filter((tab) => tab.project.id !== id)
    setLatexTabs(remaining)
    if (activeLatexId !== id) return
    const next = remaining.at(-1)
    setActiveLatexId(next?.project.id ?? null)
    if (!next && panelView === 'latex') returnToWorkspace()
  }, [activeLatexId, latexTabs, panelView, returnToWorkspace])

  useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false
    const request: LatexRequest = panelView === 'latex' && selectedLatex?.path
      ? { action: 'activate', projectId: selectedLatex.project.id, path: selectedLatex.path }
      : { action: 'activate' }
    latexContextQueue.current = latexContextQueue.current.then(async () => {
      if (!cancelled) await window.api.latex.execute(activeWorkspaceId, request)
    }).catch((reason) => { useDocumentStore.getState().showToast(errorMessage(reason)) })
    return () => { cancelled = true }
  }, [activeWorkspaceId, panelView, selectedLatex?.project.id, selectedLatex?.path])

  useEffect(() => () => {
    if (activeWorkspaceId) latexContextQueue.current = latexContextQueue.current.then(async () => {
      await window.api.latex.execute(activeWorkspaceId, { action: 'activate' })
    }).catch(() => undefined)
  }, [activeWorkspaceId])

  useEffect(() => {
    if (!markdownCardRequest) return
    let cancelled = false
    void saveActiveContent().then((saved) => {
      if (cancelled) return
      clearMarkdownCardRequest()
      if (!saved) return
      const card: ActiveMarkdownCard = { ...markdownCardRequest, mode: 'read' }
      setActiveMarkdownCard(card)
      setMarkdownTabs((current) => current.some(
        (item) => isSameMarkdownCard(item, card)
      ) ? current : [...current, card])
    })
    return () => {
      cancelled = true
    }
  }, [clearMarkdownCardRequest, markdownCardRequest, saveActiveContent])

  const handleSelectWorkspace = useCallback(async (workspaceId: string) => {
    await requestActiveWorkspace(workspaceId)
  }, [requestActiveWorkspace])

  const handleSelectMarkdown = useCallback(async (card: ActiveMarkdownCard) => {
    if (!(await saveActiveContent())) return
    setActiveMarkdownCard(card)
    showMarkdown()
  }, [saveActiveContent, showMarkdown])

  const handleCloseMarkdown = useCallback(async (card: ActiveMarkdownCard) => {
    const isActive = isSameMarkdownCard(activeMarkdownCard, card)
    if (isActive && !(await saveActiveContent())) return
    setMarkdownTabs((current) => current.filter(
      (item) => !isSameMarkdownCard(item, card)
    ))
    if (isActive) {
      setActiveMarkdownCard(null)
      showWorkspace()
    }
  }, [activeMarkdownCard, saveActiveContent, showWorkspace])

  const handleSelectPdf = useCallback(async (documentId: string) => {
    if (!(await saveActiveContent())) return
    usePdfReaderStore.getState().activate(documentId)
    useWorkspaceStore.getState().openPdfReader()
  }, [saveActiveContent])

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
    closeWorkspaceTab(workspaceId)
    if (panelView !== 'workspace' || activeWorkspaceId !== workspaceId) return
    const nextWorkspace = workspaces.find(
      (workspace) => workspace.id !== workspaceId && openWorkspaceIds.includes(workspace.id)
    )
    if (nextWorkspace) {
      setActiveWorkspace(nextWorkspace.id)
    } else if (activeMarkdownCard) {
      showMarkdown()
    } else if (latexTabs.length) {
      setActiveLatexId(latexTabs.find((tab) => tab.project.id === activeLatexId)?.project.id ?? latexTabs.at(-1)!.project.id)
      useWorkspaceStore.setState({ panelView: 'latex' })
    } else if (pdfTabs[0]) {
      usePdfReaderStore.getState().activate(pdfTabs[0].id)
      useWorkspaceStore.getState().openPdfReader()
    } else {
      closePanel()
    }
  }, [
    activeMarkdownCard,
    activeLatexId,
    latexTabs,
    activeWorkspaceId,
    closePanel,
    closeWorkspaceTab,
    openWorkspaceIds,
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
      (workspace) => openWorkspaceIds.includes(workspace.id)
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
    ...latexTabs.map((tab) => ({
      id: `latex:${tab.project.id}`,
      title: tab.project.title,
      kind: 'latex' as const,
      active: panelView === 'latex' && activeLatexId === tab.project.id,
      onSelect: () => { void saveActiveContent().then((saved) => { if (saved) void openLatexProject(tab.project) }) },
      onClose: () => { void closeLatexProject(tab.project.id) }
    })),
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
          <Board
            ref={boardRef}
            onOpenMarkdownCard={handleOpenMarkdownCard}
            onOpenLatex={(project) => void openLatexProject(project)}
            onCreateLatex={setLatexPlacement}
            toolbarActions={<>
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
              <button type="button" className="sidebar-header-btn" disabled={!activeWorkspaceId} title={t('latex.open')} aria-label={t('latex.open')} onClick={() => boardRef.current?.createLatex()}><Code className="h-4 w-4" /></button>
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
            </>}
          />
        </div>
        {markdownView ? (
          <div className={panelView === 'markdown' ? 'h-full' : 'hidden'}>
            {markdownView}
          </div>
        ) : null}
        {latexPlacement && activeWorkspaceId && <WorkspaceLatexDialog workspaceId={activeWorkspaceId} placement={latexPlacement} onClose={() => setLatexPlacement(null)} onOpen={openLatexProject} onCreated={(project) => { const item = useWorkspaceStore.getState().items.find((item) => item.latexId === project.id); if (item) boardRef.current?.revealItem(item) }} />}
        {activeWorkspaceId && latexTabs.map((tab) => <div key={tab.project.id} className={panelView === 'latex' && activeLatexId === tab.project.id ? 'h-full' : 'hidden'}><Suspense fallback={<div className="h-full bg-background" />}><WorkspaceLatexView ref={(handle) => { if (handle) latexViews.current.set(tab.project.id, handle); else latexViews.current.delete(tab.project.id) }} workspaceId={activeWorkspaceId} initialProject={tab.project} onBackToWorkspace={returnToWorkspace} workspaceName={workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? ''} active={panelView === 'latex' && activeLatexId === tab.project.id} manageActiveContext={false} onOpenProject={openLatexProject} onFileChange={updateLatexFile} /></Suspense></div>)}
        {activePdfDocumentId ? (
          <div className={panelView === 'pdf' ? 'h-full' : 'hidden'}>
            <Suspense fallback={<div className="h-full bg-background" />}>
              <PdfReader embedded active={panelView === 'pdf'} />
            </Suspense>
          </div>
        ) : null}
      </div>
    </div>
  )
}
