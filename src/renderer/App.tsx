import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import clsx from 'clsx'
import { ThemeProvider, ContextMenuHost } from '@lobehub/ui'
import { theme as antdTheme } from 'antd'
import { ChatCircleText, IconContext } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import Sidebar from './components/Sidebar'
import DocumentList from './components/DocumentList'
import DetailPanel from './components/DetailPanel'
import GlobalSearch from './components/GlobalSearch'
import WorkspacePanel from './components/workspace/WorkspacePanel'
import ChatPanel from './components/workspace/ChatPanel'
import ResizeDivider from './components/ResizeDivider'
import ConfirmDialog from './components/ConfirmDialog'
import StructuredDocumentPanel from './components/StructuredDocumentPanel'
import FirstRunWizard from './components/FirstRunWizard'
import { Toast } from './components/ui'
import { useAppShortcuts } from './hooks/useAppShortcuts'
import { useTheme, AppThemeProvider } from './hooks/useTheme'
import { getAntdTokenOverrides } from './theme/tokens'
import { useDocumentStore } from './store/documentStore'
import { useWorkspaceStore } from './store/workspaceStore'
import { useOcrReaderStore } from './store/ocrReaderStore'
import { useChatDraftStore } from './store/chatDraftStore'
import { usePdfReaderStore } from './store/pdfReaderStore'
import { api } from './ipc'
import type { ListColumnState } from '../shared/ipc-types'

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 400
const DETAIL_MIN = 320
const DETAIL_MAX = 640
const WORKSPACE_RESIZE_MIN = 300
const WORKSPACE_MAX = 1200
const DOC_LIST_MIN = 280
const DOC_LIST_COMPACT_MIN = 240
const DOC_LIST_COMPACT_MAX = 480
const DOC_LIST_COMPACT_DEFAULT = 320
const DOC_LIST_COLLAPSE_THRESHOLD = 320
const DOC_LIST_EXPAND_THRESHOLD = 360
const SIDEBAR_DEFAULT = 224
const DETAIL_DEFAULT = 384
const WORKSPACE_DEFAULT = 800
const CHAT_MIN = 380
const CHAT_DEFAULT = 560

function canExpandDocumentList(
  listWidth: number,
  workspaceWidth: number,
  detailPanelOpen: boolean
): boolean {
  return listWidth >= DOC_LIST_EXPAND_THRESHOLD &&
    listWidth + workspaceWidth >
      WORKSPACE_RESIZE_MIN + DOC_LIST_COLLAPSE_THRESHOLD + (detailPanelOpen ? 1 : 0)
}

function getExpandedDocumentListMaxWidth(
  availableWidth: number,
  detailPanelOpen: boolean
): number {
  return Math.max(
    DOC_LIST_MIN,
    availableWidth - WORKSPACE_RESIZE_MIN - (detailPanelOpen ? 1 : 0)
  )
}

function getCompactDocumentListMaxWidth(availableWidth: number): number {
  return Math.max(
    DOC_LIST_COMPACT_MIN,
    Math.min(DOC_LIST_COMPACT_MAX, availableWidth - WORKSPACE_RESIZE_MIN)
  )
}

interface AppProps {
  listColumnState: ListColumnState | null
  sidebarCollapsed: boolean
  firstRun: boolean
}

export default function App(props: AppProps) {
  return (
    <AppThemeProvider>
      <AppInner {...props} />
    </AppThemeProvider>
  )
}

function AppInner({ listColumnState, sidebarCollapsed: initialSidebarCollapsed, firstRun }: AppProps) {
  const { t } = useTranslation()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed)
  const [showWizard, setShowWizard] = useState(firstRun)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(
    () => useWorkspaceStore.getState().activeWorkspaceId !== null
  )
  const [documentListOpen, setDocumentListOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [detailWidth, setDetailWidth] = useState(DETAIL_DEFAULT)
  const [workspaceWidth, setWorkspaceWidth] = useState(WORKSPACE_DEFAULT)
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT)
  const [documentListCompactWidth, setDocumentListCompactWidth] = useState(DOC_LIST_COMPACT_DEFAULT)
  const [documentListCompact, setDocumentListCompact] = useState(false)
  const [documentListResizeOrigin, setDocumentListResizeOrigin] = useState<boolean | null>(null)
  const documentListCompactWidthRef = useRef(DOC_LIST_COMPACT_DEFAULT)
  const documentListDragWidthRef = useRef(DOC_LIST_COMPACT_DEFAULT)
  const documentListCompactRef = useRef(false)
  const documentListResizeOriginRef = useRef<boolean | null>(null)
  const compactAvailableWidthRef = useRef(0)
  const detailWidthRef = useRef(DETAIL_DEFAULT)
  const workspaceWidthRef = useRef(WORKSPACE_DEFAULT)
  const expandedDocumentListWidthRef = useRef(0)
  const panelResizingRef = useRef(false)
  const documentListPanelRef = useRef<HTMLDivElement>(null)
  const detailPanelRef = useRef<HTMLDivElement>(null)
  const workspacePanelRef = useRef<HTMLDivElement>(null)
  const { mode: themeMode, resolvedTheme } = useTheme()
  useAppShortcuts()

  const themeConfig = useMemo(
    () => ({
      token: getAntdTokenOverrides(resolvedTheme),
      algorithm:
        resolvedTheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    }),
    [resolvedTheme]
  )

  const focusedDocId = useDocumentStore((s) => s.focusedDocId)
  const selectedIds = useDocumentStore((s) => s.selectedIds)
  const listMode = useDocumentStore((s) => s.listMode)
  const workspacePanelOpen = useWorkspaceStore((s) => s.panelOpen)
  const workspaceFullscreen = useWorkspaceStore((s) => s.fullscreen)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const chatStreaming = useWorkspaceStore((s) => s.chatStreaming)
  const pendingChatDraft = useChatDraftStore((s) => s.pending)
  const ocrReaderOpen = useOcrReaderStore((s) => s.documentId !== null)
  const previousActiveWorkspaceIdRef = useRef(activeWorkspaceId)

  const setDocumentListMode = useCallback((compact: boolean) => {
    if (documentListCompactRef.current === compact) return
    documentListCompactRef.current = compact
    setDocumentListCompact(compact)
  }, [])

  useEffect(() => {
    if (previousActiveWorkspaceIdRef.current === null && activeWorkspaceId !== null) {
      setChatOpen(true)
    }
    previousActiveWorkspaceIdRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  useEffect(() => {
    if (pendingChatDraft) setChatOpen(true)
  }, [pendingChatDraft])

  useEffect(() => {
    documentListResizeOriginRef.current = null
    setDocumentListResizeOrigin(null)
    documentListDragWidthRef.current = documentListCompactWidthRef.current
    documentListCompactRef.current = workspacePanelOpen
    setDocumentListCompact(workspacePanelOpen)
    if (!workspacePanelOpen) setDocumentListOpen(true)
  }, [workspacePanelOpen])

  useEffect(() => {
    setDocumentListOpen(true)
  }, [listMode])

  useEffect(() => {
    if (focusedDocId || selectedIds.length >= 2) {
      setRightPanelOpen(true)
    }
  }, [focusedDocId, selectedIds])

  useEffect(() => {
    if (!focusedDocId && selectedIds.length === 0) {
      setRightPanelOpen(false)
    }
  }, [focusedDocId, selectedIds])

  useEffect(() => {
    const store = useDocumentStore.getState()
    store.init(listColumnState)
    return () => {
      store.destroy()
    }
  }, [])

  useEffect(() => () => useOcrReaderStore.getState().close(), [])

  useEffect(() => {
    const reset = () => usePdfReaderStore.getState().resetForLibrarySwitch()
    api.events.onLibrarySwitched(reset)
    return () => api.events.off('library:switched', reset)
  }, [])

  useEffect(() => {
    const store = useWorkspaceStore.getState()
    store.init()
    return () => {
      store.destroy()
    }
  }, [])

  useEffect(() => {
    void Promise.all([
      api.settings.get<number>('sidebarWidth', SIDEBAR_DEFAULT),
      api.settings.get<number>('detailWidth', DETAIL_DEFAULT),
      api.settings.get<number>('workspaceWidth', WORKSPACE_DEFAULT),
      api.settings.get<number>('workspaceChatWidth', CHAT_DEFAULT),
      api.settings.get<number>('documentListCompactWidth', DOC_LIST_COMPACT_DEFAULT),
    ]).then(([s, d, w, c, compactWidth]) => {
      setSidebarWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, s)))
      const nextDetailWidth = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, d))
      detailWidthRef.current = nextDetailWidth
      setDetailWidth(nextDetailWidth)
      const nextWorkspaceWidth = Math.max(WORKSPACE_RESIZE_MIN, Math.min(WORKSPACE_MAX, w))
      workspaceWidthRef.current = nextWorkspaceWidth
      setWorkspaceWidth(nextWorkspaceWidth)
      setChatWidth(Math.max(CHAT_MIN, c))
      const nextCompactWidth = Math.max(
        DOC_LIST_COMPACT_MIN,
        Math.min(DOC_LIST_COMPACT_MAX, compactWidth)
      )
      documentListCompactWidthRef.current = nextCompactWidth
      documentListDragWidthRef.current = nextCompactWidth
      setDocumentListCompactWidth(nextCompactWidth)
    })
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void api.settings.set('sidebarWidth', sidebarWidth)
    }, 500)
    return () => clearTimeout(timer)
  }, [sidebarWidth])

  useEffect(() => {
    const timer = setTimeout(() => {
      void api.settings.set('detailWidth', detailWidth)
    }, 500)
    return () => clearTimeout(timer)
  }, [detailWidth])

  useEffect(() => {
    const timer = setTimeout(() => {
      void api.settings.set('workspaceWidth', workspaceWidth)
    }, 500)
    return () => clearTimeout(timer)
  }, [workspaceWidth])

  useEffect(() => {
    const timer = setTimeout(() => {
      void api.settings.set('workspaceChatWidth', chatWidth)
    }, 500)
    return () => clearTimeout(timer)
  }, [chatWidth])

  useEffect(() => {
    const timer = setTimeout(() => {
      void api.settings.set('documentListCompactWidth', documentListCompactWidth)
    }, 500)
    return () => clearTimeout(timer)
  }, [documentListCompactWidth])

  const collapseDocumentListAtWidth = useCallback((width: number) => {
    if (!Number.isFinite(width) || width <= 0 || width > DOC_LIST_COLLAPSE_THRESHOLD) return
    const nextCompactWidth = Math.max(
      DOC_LIST_COMPACT_MIN,
      Math.min(DOC_LIST_COMPACT_MAX, width)
    )
    documentListCompactWidthRef.current = nextCompactWidth
    documentListDragWidthRef.current = nextCompactWidth
    setDocumentListCompactWidth(nextCompactWidth)
    setDocumentListMode(true)
  }, [setDocumentListMode])

  useEffect(() => {
    const element = documentListPanelRef.current
    if (!workspacePanelOpen || !documentListOpen || documentListCompact || !element) return
    const update = () => {
      if (panelResizingRef.current) return
      collapseDocumentListAtWidth(element.getBoundingClientRect().width)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [collapseDocumentListAtWidth, documentListCompact, documentListOpen, workspacePanelOpen])

  const handleToggleSidebar = () => {
    setSidebarCollapsed((v) => {
      const next = !v
      void api.settings.set('sidebarCollapsed', next ? '1' : '0')
      return next
    })
  }

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w + delta)))
  }, [])

  const handleDetailResizeStart = useCallback(() => {
    panelResizingRef.current = true
    const measuredWidth = detailPanelRef.current?.getBoundingClientRect().width
    if (measuredWidth) detailWidthRef.current = measuredWidth
  }, [])

  const handleDetailResize = useCallback((delta: number) => {
    const nextWidth = Math.max(
      DETAIL_MIN,
      Math.min(DETAIL_MAX, detailWidthRef.current - delta)
    )
    detailWidthRef.current = nextWidth
    if (detailPanelRef.current) {
      detailPanelRef.current.style.width = `${nextWidth}px`
    }
  }, [])

  const handleDetailResizeEnd = useCallback(() => {
    panelResizingRef.current = false
    setDetailWidth(detailWidthRef.current)
    if (!workspacePanelOpen || documentListCompact) return
    collapseDocumentListAtWidth(
      documentListPanelRef.current?.getBoundingClientRect().width ?? 0
    )
  }, [collapseDocumentListAtWidth, documentListCompact, workspacePanelOpen])

  const handleChatResize = useCallback((delta: number) => {
    setChatWidth((width) => Math.max(CHAT_MIN, width - delta))
  }, [])

  const handleDocumentWorkspaceResizeStart = useCallback(() => {
    panelResizingRef.current = true
    const resizeOriginCompact = documentListCompactRef.current
    documentListResizeOriginRef.current = resizeOriginCompact
    setDocumentListResizeOrigin(resizeOriginCompact)
    if (resizeOriginCompact) {
      const measuredWidth = documentListPanelRef.current?.getBoundingClientRect().width
      documentListDragWidthRef.current = measuredWidth || documentListCompactWidthRef.current
      compactAvailableWidthRef.current = documentListDragWidthRef.current +
        (workspacePanelRef.current?.getBoundingClientRect().width ?? 0)
      return
    }

    const measuredWorkspaceWidth = workspacePanelRef.current?.getBoundingClientRect().width
    if (measuredWorkspaceWidth) workspaceWidthRef.current = measuredWorkspaceWidth
    expandedDocumentListWidthRef.current =
      documentListPanelRef.current?.getBoundingClientRect().width ?? 0
  }, [])

  const handleDocumentWorkspaceResize = useCallback((delta: number) => {
    if (documentListResizeOriginRef.current ?? documentListCompactRef.current) {
      const requestedWidth = documentListDragWidthRef.current + delta
      const canUseExpandedWidth = !documentListCompactRef.current || canExpandDocumentList(
        requestedWidth,
        compactAvailableWidthRef.current - requestedWidth,
        rightPanelOpen
      )
      const maxWidth = canUseExpandedWidth
        ? getExpandedDocumentListMaxWidth(compactAvailableWidthRef.current, rightPanelOpen)
        : getCompactDocumentListMaxWidth(compactAvailableWidthRef.current)
      const nextWidth = Math.max(
        DOC_LIST_COMPACT_MIN,
        Math.min(maxWidth, requestedWidth)
      )
      documentListDragWidthRef.current = nextWidth
      if (documentListPanelRef.current) {
        documentListPanelRef.current.style.width = `${nextWidth}px`
      }
      const nextWorkspaceWidth = compactAvailableWidthRef.current - nextWidth
      if (
        documentListCompactRef.current &&
        canExpandDocumentList(nextWidth, nextWorkspaceWidth, rightPanelOpen)
      ) {
        documentListCompactWidthRef.current = DOC_LIST_EXPAND_THRESHOLD
        setDocumentListMode(false)
      } else if (
        !documentListCompactRef.current &&
        nextWidth <= DOC_LIST_COLLAPSE_THRESHOLD
      ) {
        documentListCompactWidthRef.current = nextWidth
        setDocumentListMode(true)
      } else if (documentListCompactRef.current) {
        documentListCompactWidthRef.current = nextWidth
      }
      return
    }

    const currentWorkspaceWidth = workspaceWidthRef.current
    const nextWorkspaceWidth = Math.max(
      WORKSPACE_RESIZE_MIN,
      Math.min(WORKSPACE_MAX, currentWorkspaceWidth - delta)
    )
    workspaceWidthRef.current = nextWorkspaceWidth
    expandedDocumentListWidthRef.current = Math.max(
      DOC_LIST_MIN,
      expandedDocumentListWidthRef.current + delta
    )
    if (workspacePanelRef.current) {
      workspacePanelRef.current.style.width = `${nextWorkspaceWidth}px`
    }
    if (
      !documentListCompactRef.current &&
      expandedDocumentListWidthRef.current <= DOC_LIST_COLLAPSE_THRESHOLD
    ) {
      setDocumentListMode(true)
    } else if (
      documentListCompactRef.current &&
      expandedDocumentListWidthRef.current >= DOC_LIST_EXPAND_THRESHOLD
    ) {
      setDocumentListMode(false)
    }
  }, [rightPanelOpen, setDocumentListMode])

  const handleDocumentWorkspaceResizeEnd = useCallback(() => {
    panelResizingRef.current = false
    const resizeOriginCompact =
      documentListResizeOriginRef.current ?? documentListCompactRef.current
    documentListResizeOriginRef.current = null
    setDocumentListResizeOrigin(null)
    if (resizeOriginCompact) {
      const nextDocumentListWidth = documentListDragWidthRef.current
      if (documentListCompactRef.current) {
        const nextCompactWidth = Math.max(
          DOC_LIST_COMPACT_MIN,
          Math.min(
            getCompactDocumentListMaxWidth(compactAvailableWidthRef.current),
            nextDocumentListWidth
          )
        )
        documentListCompactWidthRef.current = nextCompactWidth
        documentListDragWidthRef.current = nextCompactWidth
        setDocumentListCompactWidth(nextCompactWidth)
        return
      }

      setDocumentListCompactWidth(documentListCompactWidthRef.current)

      const nextWorkspaceWidth = Math.max(
        WORKSPACE_RESIZE_MIN,
        Math.min(
          WORKSPACE_MAX,
          compactAvailableWidthRef.current - (rightPanelOpen ? 1 : 0) - nextDocumentListWidth
        )
      )
      workspaceWidthRef.current = nextWorkspaceWidth
      expandedDocumentListWidthRef.current = Math.max(
        DOC_LIST_MIN,
        compactAvailableWidthRef.current - (rightPanelOpen ? 1 : 0) - nextWorkspaceWidth
      )
      setWorkspaceWidth(nextWorkspaceWidth)
      return
    }

    setWorkspaceWidth(workspaceWidthRef.current)
    const finalDocumentListWidth = Math.max(DOC_LIST_MIN, expandedDocumentListWidthRef.current)
    expandedDocumentListWidthRef.current = finalDocumentListWidth
    if (finalDocumentListWidth <= DOC_LIST_COLLAPSE_THRESHOLD) {
      setDocumentListMode(true)
    } else if (
      documentListCompactRef.current &&
      finalDocumentListWidth >= DOC_LIST_EXPAND_THRESHOLD
    ) {
      setDocumentListMode(false)
    }
    if (documentListCompactRef.current) {
      documentListCompactWidthRef.current = Math.max(
        DOC_LIST_COMPACT_MIN,
        Math.min(DOC_LIST_COMPACT_MAX, finalDocumentListWidth)
      )
      documentListDragWidthRef.current = documentListCompactWidthRef.current
      setDocumentListCompactWidth(documentListCompactWidthRef.current)
    }
  }, [rightPanelOpen, setDocumentListMode])

  const sidebarStyle = sidebarCollapsed
    ? { width: '0px' }
    : { width: `${sidebarWidth}px` }
  const documentListLayoutCompact =
    documentListResizeOrigin ?? documentListCompact
  const chatVisible = chatOpen
  const chatToggleLabel = chatVisible
    ? t('workspace.chat.closePanel')
    : t('workspace.chat.openPanel')
  const workspaceNeedsLeadingBorder = rightPanelOpen || (documentListOpen && !documentListLayoutCompact)
  const chatPane = chatVisible ? (
    <>
      <ResizeDivider onResize={handleChatResize} orientation="vertical" variant="line" />
      <div
        style={{ width: `min(${chatWidth}px, 95%)` }}
        className="relative z-20 min-h-0 min-w-0 shrink-0 overflow-hidden bg-background"
        data-testid="app-chat-panel"
      >
        <ChatPanel onClose={() => setChatOpen(false)} />
      </div>
    </>
  ) : null

  return (
    <IconContext.Provider value={{ weight: 'regular' }}>
    <ThemeProvider
      appearance={resolvedTheme}
      themeMode={themeMode === 'system' ? 'auto' : themeMode}
      theme={themeConfig}
      enableGlobalStyle={false}
      enableCustomFonts={false}
    >
      <ContextMenuHost />
      <div className="app-root relative isolate flex h-screen w-screen overflow-hidden bg-background text-foreground">
        {showWizard && <FirstRunWizard onDone={() => setShowWizard(false)} />}
        {!workspaceFullscreen && !sidebarCollapsed && (
          <div style={sidebarStyle} className="relative z-30 shrink-0" data-testid="app-sidebar-layer">
            <div className="sidebar-vibrancy-frame" aria-hidden="true">
              <div className="sidebar-vibrancy-frame__mask" />
            </div>
            <div className="relative z-10 h-full min-h-0" style={{ padding: 'var(--sidebar-inset) 0 var(--sidebar-inset) var(--sidebar-inset)' }}>
              <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={handleToggleSidebar} />
            </div>
          </div>
        )}
        {!workspaceFullscreen && !sidebarCollapsed && (
          <ResizeDivider onResize={handleSidebarResize} variant="gap" />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="app-main-layer">
          {!showWizard && (
            <div
              className="drag-region relative h-12 w-full shrink-0 bg-background"
              data-testid="app-top-bar"
            >
              {!workspaceFullscreen && sidebarCollapsed && (
                <Sidebar collapsed onToggleCollapse={handleToggleSidebar} />
              )}
              <GlobalSearch
                documentListOpen={documentListOpen}
                onOpenChat={() => setChatOpen(true)}
              />
              <div className="no-drag absolute right-3 top-2.5 z-[60] flex items-center">
                <button
                  type="button"
                  className={clsx(
                    'flex h-7 w-7 items-center justify-center rounded-lg transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
                    chatVisible
                      ? 'bg-active text-accent hover:bg-hover'
                      : 'text-muted hover:bg-hover hover:text-foreground'
                  )}
                  onClick={() => setChatOpen((open) => !open)}
                  disabled={chatStreaming && chatVisible}
                  title={chatToggleLabel}
                  aria-label={chatToggleLabel}
                  aria-pressed={chatVisible}
                >
                  <ChatCircleText className="h-4 w-4" />
                </button>
              </div>
              <div
                className="pointer-events-none absolute bottom-0 left-0 right-0 h-px"
                style={{ background: 'linear-gradient(to right, var(--color-background), var(--color-border) 100px)' }}
                data-testid="app-top-bar-separator"
              />
            </div>
          )}
          <div
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
            data-testid="app-panel-layer"
          >
            {ocrReaderOpen ? (
              <div className="relative z-40 flex h-full min-h-0 w-full min-w-0 overflow-hidden">
                <StructuredDocumentPanel />
                {chatPane}
              </div>
            ) : workspaceFullscreen ? (
              <div className="relative z-40 flex h-full min-h-0 w-full min-w-0 overflow-hidden">
                <div className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="app-workspace-panel">
                  <WorkspacePanel />
                </div>
                {chatPane}
              </div>
            ) : (
              <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
                <div
                  className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
                  data-testid="app-primary-panels"
                >
                  {documentListOpen && (
                    <div
                      ref={documentListPanelRef}
                      className={clsx(
                        'relative z-10 flex min-h-0 min-w-0 flex-col overflow-hidden',
                        workspacePanelOpen && documentListLayoutCompact ? 'shrink-0' : 'flex-1'
                      )}
                      style={
                        workspacePanelOpen && documentListLayoutCompact
                          ? { width: `${documentListCompactWidth}px`, minWidth: DOC_LIST_COMPACT_MIN }
                          : { minWidth: DOC_LIST_MIN }
                      }
                      data-testid="app-document-list-panel"
                    >
                      <DocumentList
                        compact={workspacePanelOpen && documentListCompact}
                        onDocumentFocus={() => setRightPanelOpen(true)}
                        onClose={workspacePanelOpen && documentListCompact
                          ? () => setDocumentListOpen(false)
                          : undefined}
                      />
                    </div>
                  )}
                  {documentListOpen && (rightPanelOpen || (workspacePanelOpen && documentListLayoutCompact)) && (
                    <ResizeDivider
                      onResize={
                        workspacePanelOpen && documentListLayoutCompact
                          ? handleDocumentWorkspaceResize
                          : handleDetailResize
                      }
                      onResizeStart={
                        workspacePanelOpen && documentListLayoutCompact
                          ? handleDocumentWorkspaceResizeStart
                          : handleDetailResizeStart
                      }
                      onResizeEnd={
                        workspacePanelOpen && documentListLayoutCompact
                          ? handleDocumentWorkspaceResizeEnd
                          : handleDetailResizeEnd
                      }
                      variant="line"
                    />
                  )}
                  <div
                    ref={detailPanelRef}
                    className={clsx(
                      'relative z-20 min-w-0 overflow-hidden',
                      !rightPanelOpen && 'w-0'
                    )}
                    style={rightPanelOpen ? { width: `${detailWidth}px`, minWidth: 0 } : { width: 0 }}
                  >
                    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
                      <DetailPanel onClose={() => setRightPanelOpen(false)} />
                    </div>
                  </div>
                  {workspacePanelOpen && !documentListLayoutCompact && (
                    <ResizeDivider
                      onResize={handleDocumentWorkspaceResize}
                      onResizeStart={handleDocumentWorkspaceResizeStart}
                      onResizeEnd={handleDocumentWorkspaceResizeEnd}
                      variant="soft"
                    />
                  )}
                  {workspacePanelOpen && (
                    <div
                      ref={workspacePanelRef}
                      style={documentListLayoutCompact ? undefined : { width: `${workspaceWidth}px` }}
                      className={clsx(
                        'relative z-20 min-h-0 min-w-0 overflow-hidden',
                        workspaceNeedsLeadingBorder && 'border-l border-border/50',
                        documentListLayoutCompact ? 'flex-1' : 'shrink-0'
                      )}
                      data-testid="app-workspace-panel"
                    >
                      <WorkspacePanel />
                    </div>
                  )}
                </div>
                {chatPane}
              </div>
            )}
          </div>
        </div>
        <ConfirmDialog />
        <Toast />
      </div>
    </ThemeProvider>
    </IconContext.Provider>
  )
}
