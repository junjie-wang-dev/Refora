import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { FilePlus, GridFour, NotePencil, Palette, Stack, Sticker } from '@phosphor-icons/react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useDocumentStore } from '../../store/documentStore'
import { api } from '../../ipc'
import { markdownCardContent, paperCardMarkdown } from '../../utils/workspaceCardMarkdown'
import { EmptyState } from '../ui'
import {
  WORKSPACE_CANVAS_DEFAULT_ZOOM,
  errorMessage
} from '../../../shared/ipc-types'
import type {
  AiSummary,
  Document,
  SummaryErrorEvent,
  WorkspaceCanvasViewport,
  WorkspaceConnection,
  WorkspaceConnectionAnchor,
  WorkspaceItem,
  WorkspaceItemsChangedEvent,
  WorkspaceItemPlacement,
  WorkspaceNote,
  WorkspaceNoteType
} from '../../../shared/ipc-types'
import PaperCard from './PaperCard'
import ReportCard from './ReportCard'
import NoteCard from './NoteCard'
import StickyNoteCard from './StickyNoteCard'
import { STICKY_NOTE_COLORS } from './stickyNoteColors'
import AssetCard from './AssetCard'
import { openDocumentPdf } from '../../utils/openPdf'
import ResizableCard, {
  clampCardSize,
  type CardPosition,
  type CardSize
} from './ResizableCard'
import {
  cardAnchorPoint,
  closestCardAnchor,
  connectionCurve,
  targetAnchorForPreview,
  type ConnectionPoint
} from './connectionGeometry'

const DOC_MIME = 'application/x-refora-docids'
const VIEWPORT_SAVE_DELAY = 160
const EMPTY_NOTES: WorkspaceNote[] = []
const DEFAULT_VIEWPORT: WorkspaceCanvasViewport = {
  panX: 0,
  panY: 0,
  zoom: WORKSPACE_CANVAS_DEFAULT_ZOOM
}

interface ConnectionDraft {
  sourceItemId: string
  sourceAnchor: WorkspaceConnectionAnchor
  source: ConnectionPoint
  pointer: ConnectionPoint
}

interface MarqueeSelection {
  left: number
  top: number
  width: number
  height: number
}

interface GridPlacement {
  x: number
  y: number
}

function compactGridPlacements(
  items: WorkspaceItem[],
  sizeFor: (item: WorkspaceItem) => CardSize,
  originX: number,
  originY: number
): GridPlacement[] {
  const gap = 24
  const columnCount = Math.ceil(Math.sqrt(items.length))
  const columns = Array.from({ length: columnCount }, () => ({
    width: 0,
    height: 0
  }))
  const itemColumns: number[] = []
  const itemY: number[] = []

  items.forEach((item) => {
    const size = sizeFor(item)
    let columnIndex = 0
    for (let index = 1; index < columns.length; index += 1) {
      if (columns[index].height < columns[columnIndex].height) columnIndex = index
    }
    const column = columns[columnIndex]
    itemColumns.push(columnIndex)
    itemY.push(originY + column.height)
    column.width = Math.max(column.width, size.width)
    column.height += size.height + gap
  })

  const columnX: number[] = []
  let nextX = originX
  columns.forEach((column, index) => {
    columnX[index] = nextX
    nextX += column.width + gap
  })

  return items.map((_, index) => ({
    x: columnX[itemColumns[index]],
    y: itemY[index]
  }))
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

export interface BoardHandle {
  createNote: (noteType: WorkspaceNoteType) => void
  addFiles: () => void
}

export type WorkspaceMarkdownCard =
  | {
      kind: 'note' | 'report'
      id: string
    }
  | {
      kind: 'summary'
      doc: Document
      summary: AiSummary
    }

export type WorkspaceMarkdownCardMode = 'read' | 'edit'

interface BoardProps {
  onOpenMarkdownCard?: (card: WorkspaceMarkdownCard, mode?: WorkspaceMarkdownCardMode) => void
}

const Board = forwardRef<BoardHandle, BoardProps>(function Board({ onOpenMarkdownCard }, ref) {
  const { t } = useTranslation()
  const items = useWorkspaceStore((s) => s.items)
  const reports = useWorkspaceStore((s) => s.reports)
  const notes = useWorkspaceStore((s) => s.notes) ?? EMPTY_NOTES
  const assets = useWorkspaceStore((s) => s.assets) ?? []
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const addDocs = useWorkspaceStore((s) => s.addDocs)
  const addAssets = useWorkspaceStore((s) => s.addAssets)
  const addFiles = useWorkspaceStore((s) => s.addFiles)
  const deleteAsset = useWorkspaceStore((s) => s.deleteAsset)
  const removeItem = useWorkspaceStore((s) => s.removeItem)
  const resizeItem = useWorkspaceStore((s) => s.resizeItem)
  const moveItem = useWorkspaceStore((s) => s.moveItem)
  const createNote = useWorkspaceStore((s) => s.createNote)
  const deleteNote = useWorkspaceStore((s) => s.deleteNote)
  const updateNote = useWorkspaceStore((s) => s.updateNote)
  const deleteReport = useWorkspaceStore((s) => s.deleteReport)
  const updateReport = useWorkspaceStore((s) => s.updateReport)

  const [docs, setDocs] = useState<Map<string, Document>>(new Map())
  const [summaries, setSummaries] = useState<Map<string, AiSummary>>(new Map())
  const [loadedSummaryDocIds, setLoadedSummaryDocIds] = useState<Set<string>>(new Set())
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set())
  const [summaryErrors, setSummaryErrors] = useState<Map<string, string>>(new Map())
  const [dropActive, setDropActive] = useState(false)
  const [autoEditNoteId, setAutoEditNoteId] = useState<string | null>(null)
  const [autoEditStickyNoteId, setAutoEditStickyNoteId] = useState<string | null>(null)
  const [connections, setConnections] = useState<WorkspaceConnection[]>([])
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null)
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [animatingItemIds, setAnimatingItemIds] = useState<Set<string>>(new Set())
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelection | null>(null)
  const [spacePressed, setSpacePressed] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const activeWorkspaceIdRef = useRef(activeWorkspaceId)
  const viewportRef = useRef<WorkspaceCanvasViewport>(DEFAULT_VIEWPORT)
  const pendingViewportRef = useRef<WorkspaceCanvasViewport | null>(null)
  const viewportFrameRef = useRef<number | null>(null)
  const viewportTouchedRef = useRef(false)
  const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dropErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panCleanupRef = useRef<(() => void) | null>(null)
  const marqueeCleanupRef = useRef<(() => void) | null>(null)
  const layoutAnimationFrameRef = useRef<number | null>(null)
  const layoutAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spacePressedRef = useRef(false)
  const connectionCleanupRef = useRef<(() => void) | null>(null)
  const connectionDraftRef = useRef<ConnectionDraft | null>(null)
  const connectionPreviewPathRef = useRef<SVGPathElement>(null)
  const connectionFrameRef = useRef<number | null>(null)
  const previewPositionsRef = useRef(new Map<string, CardPosition>())
  const previewSizesRef = useRef(new Map<string, CardSize>())
  const itemMapRef = useRef(new Map<string, WorkspaceItem>())
  const connectionsRef = useRef<WorkspaceConnection[]>([])
  const connectionGroupRefs = useRef(new Map<string, SVGGElement>())
  const connectionDeleteRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => a.zIndex - b.zIndex || a.addedAt - b.addedAt),
    [items]
  )
  const reportMap = useMemo(() => new Map(reports.map((report) => [report.id, report])), [reports])
  const noteMap = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes])
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets])
  const itemMap = useMemo(() => new Map(sortedItems.map((item) => [item.id, item])), [sortedItems])
  const workspaceDocIds = useMemo(
    () => sortedItems
      .filter((item) => item.kind === 'document' && item.docId)
      .map((item) => item.docId as string),
    [sortedItems]
  )
  const allDocIds = useMemo(
    () => [...new Set([...workspaceDocIds, ...reports.flatMap((report) => report.sourceDocIds)])],
    [reports, workspaceDocIds]
  )
  const allDocIdsKey = allDocIds.join('|')
  const workspaceDocIdsKey = workspaceDocIds.join('|')
  const maxZIndex = useMemo(
    () => sortedItems.reduce((maximum, item) => Math.max(maximum, item.zIndex), -1),
    [sortedItems]
  )

  const applyViewportVisuals = useCallback((next: WorkspaceCanvasViewport) => {
    if (worldRef.current) {
      worldRef.current.style.transform = `translate3d(${next.panX}px, ${next.panY}px, 0) scale(${WORKSPACE_CANVAS_DEFAULT_ZOOM})`
    }
  }, [])

  const flushViewportVisuals = useCallback(() => {
    if (viewportFrameRef.current !== null) {
      cancelAnimationFrame(viewportFrameRef.current)
      viewportFrameRef.current = null
    }
    const next = pendingViewportRef.current
    pendingViewportRef.current = null
    if (next) applyViewportVisuals(next)
  }, [applyViewportVisuals])

  const updateViewportTransient = useCallback((next: WorkspaceCanvasViewport) => {
    const fixedViewport = { ...next, zoom: WORKSPACE_CANVAS_DEFAULT_ZOOM }
    viewportTouchedRef.current = true
    viewportRef.current = fixedViewport
    pendingViewportRef.current = fixedViewport
    if (viewportFrameRef.current !== null) return
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null
      const pending = pendingViewportRef.current
      pendingViewportRef.current = null
      if (pending) applyViewportVisuals(pending)
    })
  }, [applyViewportVisuals])

  const persistViewport = useCallback((workspaceId: string, next: WorkspaceCanvasViewport) => {
    void api.workspaceCanvas.update(workspaceId, next).catch((e) => {
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        useDocumentStore.getState().showToast(errorMessage(e, t('workspace.canvasSaveFailed')))
      }
    })
  }, [t])

  const scheduleViewportSave = useCallback((next: WorkspaceCanvasViewport) => {
    if (!activeWorkspaceId) return
    if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current)
    const workspaceId = activeWorkspaceId
    viewportSaveTimerRef.current = setTimeout(() => {
      viewportSaveTimerRef.current = null
      persistViewport(workspaceId, next)
    }, VIEWPORT_SAVE_DELAY)
  }, [activeWorkspaceId, persistViewport])

  const commitViewport = useCallback((next: WorkspaceCanvasViewport) => {
    if (viewportSaveTimerRef.current) {
      clearTimeout(viewportSaveTimerRef.current)
      viewportSaveTimerRef.current = null
    }
    updateViewportTransient(next)
    flushViewportVisuals()
    if (activeWorkspaceId) persistViewport(activeWorkspaceId, next)
  }, [activeWorkspaceId, flushViewportVisuals, persistViewport, updateViewportTransient])

  useEffect(() => {
    if (layoutAnimationFrameRef.current !== null) {
      cancelAnimationFrame(layoutAnimationFrameRef.current)
      layoutAnimationFrameRef.current = null
    }
    if (layoutAnimationTimerRef.current) {
      clearTimeout(layoutAnimationTimerRef.current)
      layoutAnimationTimerRef.current = null
    }
    setDocs(new Map())
    setSummaries(new Map())
    setSummarizing(new Set())
    setSummaryErrors(new Map())
    previewPositionsRef.current.clear()
    previewSizesRef.current.clear()
    setAutoEditNoteId(null)
    setAutoEditStickyNoteId(null)
    setConnections([])
    connectionDraftRef.current = null
    setConnectionDraft(null)
    setSelectedConnectionId(null)
    setSelectedItemIds(new Set())
    setAnimatingItemIds(new Set())
    setMarqueeSelection(null)
  }, [activeWorkspaceId])

  useEffect(() => {
    setSelectedItemIds((current) => {
      const availableIds = new Set(items.map((item) => item.id))
      const next = new Set([...current].filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [items])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isEditableTarget(event.target)) return
      event.preventDefault()
      if (spacePressedRef.current) return
      spacePressedRef.current = true
      setSpacePressed(true)
    }
    const releaseSpace = (event?: Event) => {
      if (event?.type === 'keyup' && (event as KeyboardEvent).code !== 'Space') return
      if (!spacePressedRef.current) return
      spacePressedRef.current = false
      setSpacePressed(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', releaseSpace)
    window.addEventListener('blur', releaseSpace)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', releaseSpace)
      window.removeEventListener('blur', releaseSpace)
    }
  }, [])

  useEffect(() => {
    connectionCleanupRef.current?.()
    if (!activeWorkspaceId) return
    const workspaceId = activeWorkspaceId
    let cancelled = false
    const loadConnections = () => {
      void api.workspaceConnections.list(workspaceId).then((saved) => {
        if (!cancelled && activeWorkspaceIdRef.current === workspaceId) {
          setConnections(saved)
        }
      }).catch((e) => {
        if (!cancelled) {
          useDocumentStore.getState().showToast(errorMessage(e, t('workspace.connectionLoadFailed')))
        }
      })
    }
    const handleWorkspaceItemsChanged = (payload: WorkspaceItemsChangedEvent) => {
      if (payload.workspaceId === workspaceId) loadConnections()
    }
    loadConnections()
    api.events.onWorkspaceItemsChanged(handleWorkspaceItemsChanged)
    return () => {
      cancelled = true
      api.events.off('workspace:items:changed', handleWorkspaceItemsChanged)
    }
  }, [activeWorkspaceId, t])

  useEffect(() => {
    if (viewportSaveTimerRef.current) {
      clearTimeout(viewportSaveTimerRef.current)
      viewportSaveTimerRef.current = null
    }
    viewportTouchedRef.current = false
    viewportRef.current = DEFAULT_VIEWPORT
    pendingViewportRef.current = null
    applyViewportVisuals(DEFAULT_VIEWPORT)
    if (!activeWorkspaceId) return
    const workspaceId = activeWorkspaceId
    let cancelled = false
    void api.workspaceCanvas.get(workspaceId).then((saved) => {
      if (cancelled || viewportTouchedRef.current) return
      const fixedViewport = { ...saved, zoom: WORKSPACE_CANVAS_DEFAULT_ZOOM }
      viewportRef.current = fixedViewport
      applyViewportVisuals(fixedViewport)
    }).catch((e) => {
      if (!cancelled) {
        useDocumentStore.getState().showToast(errorMessage(e, t('workspace.canvasLoadFailed')))
      }
    })
    return () => {
      cancelled = true
      if (viewportSaveTimerRef.current) {
        clearTimeout(viewportSaveTimerRef.current)
        viewportSaveTimerRef.current = null
      }
      if (viewportTouchedRef.current) persistViewport(workspaceId, viewportRef.current)
    }
  }, [activeWorkspaceId, applyViewportVisuals, persistViewport, t])

  useEffect(() => {
    return () => {
      if (dropErrorTimerRef.current) clearTimeout(dropErrorTimerRef.current)
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current)
      if (connectionFrameRef.current !== null) cancelAnimationFrame(connectionFrameRef.current)
      if (layoutAnimationFrameRef.current !== null) cancelAnimationFrame(layoutAnimationFrameRef.current)
      if (layoutAnimationTimerRef.current) clearTimeout(layoutAnimationTimerRef.current)
      panCleanupRef.current?.()
      marqueeCleanupRef.current?.()
      connectionCleanupRef.current?.()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const workspaceIds = new Set(workspaceDocIds)
    setLoadedSummaryDocIds((previous) => previous.size === 0 ? previous : new Set())
    void Promise.all(
      allDocIds.map(async (docId) => {
        try {
          const [doc, summary] = await Promise.all([
            api.documents.get(docId),
            workspaceIds.has(docId) ? api.ai.summaryGet(docId) : Promise.resolve(null)
          ])
          if (cancelled) return
          setDocs((previous) => {
            if (!doc) return previous
            const next = new Map(previous)
            next.set(docId, doc)
            return next
          })
          if (workspaceIds.has(docId)) {
            setSummaries((previous) => {
              const next = new Map(previous)
              if (summary) next.set(docId, summary)
              else next.delete(docId)
              return next
            })
            setLoadedSummaryDocIds((previous) => new Set(previous).add(docId))
          }
        } catch (e) {
          if (cancelled) return
          useDocumentStore.getState().showToast(errorMessage(e, 'Failed to load workspace document'))
          if (workspaceIds.has(docId)) {
            setSummaryErrors((previous) => new Map(previous).set(docId, 'Failed to load document'))
          }
        }
      })
    )
    return () => {
      cancelled = true
    }
  }, [allDocIdsKey, workspaceDocIdsKey])

  useEffect(() => {
    const cb = (docId: string) => {
      if (!workspaceDocIds.includes(docId)) return
      void api.ai.summaryGet(docId).then((summary) => {
        setSummaries((previous) => {
          const next = new Map(previous)
          if (summary) next.set(docId, summary)
          else next.delete(docId)
          return next
        })
        setSummarizing((previous) => {
          if (!previous.has(docId)) return previous
          const next = new Set(previous)
          next.delete(docId)
          return next
        })
      }).catch((e) => {
        useDocumentStore.getState().showToast(errorMessage(e, 'Failed to load workspace document'))
        setSummarizing((previous) => {
          if (!previous.has(docId)) return previous
          const next = new Set(previous)
          next.delete(docId)
          return next
        })
        setSummaryErrors((previous) => new Map(previous).set(docId, 'Failed to load document'))
      })
    }
    const errCb = (payload: SummaryErrorEvent) => {
      if (!workspaceDocIds.includes(payload.docId)) return
      setSummarizing((previous) => {
        if (!previous.has(payload.docId)) return previous
        const next = new Set(previous)
        next.delete(payload.docId)
        return next
      })
      setSummaryErrors((previous) => new Map(previous).set(payload.docId, payload.message))
    }
    api.events.onAiSummaryUpdated(cb)
    api.events.onAiSummaryError(errCb)
    return () => {
      api.events.off('ai:summary:updated', cb)
      api.events.off('ai:summary:error', errCb)
    }
  }, [workspaceDocIdsKey])

  const handleSummarize = useCallback((docId: string) => {
    setSummaryErrors((previous) => {
      const next = new Map(previous)
      next.delete(docId)
      return next
    })
    setSummarizing((previous) => new Set(previous).add(docId))
    api.ai.summarize(docId).catch((e) => {
      setSummarizing((previous) => {
        const next = new Set(previous)
        next.delete(docId)
        return next
      })
      setSummaryErrors((previous) => new Map(previous).set(docId, errorMessage(e, t('workspace.summaryFailed'))))
    })
  }, [t])

  itemMapRef.current = itemMap
  connectionsRef.current = connections

  const sizeFor = useCallback((item: WorkspaceItem): CardSize =>
    clampCardSize({ width: item.width, height: item.height }), [])

  const positionFor = useCallback((item: WorkspaceItem): CardPosition =>
    ({ x: item.x, y: item.y, zIndex: item.zIndex }), [])

  const boundsFor = useCallback((item: WorkspaceItem) => {
    const position = previewPositionsRef.current.get(item.id) ?? positionFor(item)
    const size = previewSizesRef.current.get(item.id) ?? sizeFor(item)
    return { x: position.x, y: position.y, width: size.width, height: size.height }
  }, [positionFor, sizeFor])

  const refreshConnectionPreview = useCallback((itemId: string) => {
    const currentItems = itemMapRef.current
    for (const connection of connectionsRef.current) {
      if (connection.sourceItemId !== itemId && connection.targetItemId !== itemId) continue
      const sourceItem = currentItems.get(connection.sourceItemId)
      const targetItem = currentItems.get(connection.targetItemId)
      if (!sourceItem || !targetItem) continue
      const sourcePosition = previewPositionsRef.current.get(sourceItem.id) ?? positionFor(sourceItem)
      const targetPosition = previewPositionsRef.current.get(targetItem.id) ?? positionFor(targetItem)
      const sourceSize = previewSizesRef.current.get(sourceItem.id) ?? sizeFor(sourceItem)
      const targetSize = previewSizesRef.current.get(targetItem.id) ?? sizeFor(targetItem)
      const source = cardAnchorPoint(
        { x: sourcePosition.x, y: sourcePosition.y, width: sourceSize.width, height: sourceSize.height },
        connection.sourceAnchor
      )
      const target = cardAnchorPoint(
        { x: targetPosition.x, y: targetPosition.y, width: targetSize.width, height: targetSize.height },
        connection.targetAnchor
      )
      const curve = connectionCurve(source, target, connection.sourceAnchor, connection.targetAnchor)
      const group = connectionGroupRefs.current.get(connection.id)
      group?.querySelectorAll('path').forEach((path) => path.setAttribute('d', curve.path))
      const deleteButton = connectionDeleteRefs.current.get(connection.id)
      if (deleteButton) {
        deleteButton.style.left = `${curve.midpoint.x}px`
        deleteButton.style.top = `${curve.midpoint.y}px`
      }
    }
  }, [positionFor, sizeFor])

  const handleCardSizeChange = useCallback((itemId: string, size: CardSize) => {
    previewSizesRef.current.set(itemId, clampCardSize(size))
    refreshConnectionPreview(itemId)
  }, [refreshConnectionPreview])

  const handleCardSizeCommit = useCallback((itemId: string, size: CardSize) => {
    const clamped = clampCardSize(size)
    void resizeItem(itemId, clamped.width, clamped.height).finally(() => {
      previewSizesRef.current.delete(itemId)
      refreshConnectionPreview(itemId)
    })
  }, [refreshConnectionPreview, resizeItem])

  const handleCardSizeCancel = useCallback((itemId: string) => {
    previewSizesRef.current.delete(itemId)
    refreshConnectionPreview(itemId)
  }, [refreshConnectionPreview])

  const handleCardPositionChange = useCallback((itemId: string, position: CardPosition) => {
    previewPositionsRef.current.set(itemId, position)
    refreshConnectionPreview(itemId)
  }, [refreshConnectionPreview])

  const handleCardPositionCommit = useCallback((itemId: string, position: CardPosition) => {
    void moveItem(itemId, position.x, position.y, position.zIndex).finally(() => {
      previewPositionsRef.current.delete(itemId)
      refreshConnectionPreview(itemId)
    })
  }, [moveItem, refreshConnectionPreview])

  const handleCardPositionCancel = useCallback((itemId: string) => {
    previewPositionsRef.current.delete(itemId)
    refreshConnectionPreview(itemId)
  }, [refreshConnectionPreview])

  const selectedItems = useMemo(
    () => sortedItems.filter((item) => selectedItemIds.has(item.id)),
    [selectedItemIds, sortedItems]
  )

  const selectedBounds = useMemo(() => {
    if (selectedItems.length === 0) return null
    return selectedItems.reduce((current, item) => {
      const position = positionFor(item)
      const size = sizeFor(item)
      return {
        minX: Math.min(current.minX, position.x),
        minY: Math.min(current.minY, position.y),
        maxX: Math.max(current.maxX, position.x + size.width),
        maxY: Math.max(current.maxY, position.y + size.height)
      }
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
  }, [positionFor, selectedItems, sizeFor])

  const selectedStickyNotes = useMemo(() => selectedItems.flatMap((item) => {
    if (item.kind !== 'note' || !item.noteId) return []
    const note = noteMap.get(item.noteId)
    return note?.noteType === 'plain' ? [note] : []
  }), [noteMap, selectedItems])

  const arrangeSelected = useCallback((mode: 'stack' | 'grid') => {
    if (selectedItems.length < 2) return
    const ordered = [...selectedItems].sort((a, b) => a.zIndex - b.zIndex || a.addedAt - b.addedAt)
    const minX = Math.min(...ordered.map((item) => item.x))
    const minY = Math.min(...ordered.map((item) => item.y))
    const nextZIndex = maxZIndex + 1
    const placements = mode === 'stack'
      ? ordered.map((item, index) => ({
          item,
          x: minX + index * 18,
          y: minY + index * 18,
          zIndex: nextZIndex + index
        }))
      : (() => {
          const gridPlacements = compactGridPlacements(ordered, sizeFor, minX, minY)
          return ordered.map((item, index) => ({
            item,
            x: gridPlacements[index].x,
            y: gridPlacements[index].y,
            zIndex: nextZIndex + index
          }))
        })()
    if (layoutAnimationFrameRef.current !== null) {
      cancelAnimationFrame(layoutAnimationFrameRef.current)
    }
    if (layoutAnimationTimerRef.current) clearTimeout(layoutAnimationTimerRef.current)
    setAnimatingItemIds(new Set(ordered.map((item) => item.id)))
    layoutAnimationFrameRef.current = requestAnimationFrame(() => {
      layoutAnimationFrameRef.current = null
      void Promise.all(placements.map(({ item, x, y, zIndex }) =>
        moveItem(item.id, x, y, zIndex)
      ))
      layoutAnimationTimerRef.current = setTimeout(() => {
        layoutAnimationTimerRef.current = null
        setAnimatingItemIds(new Set())
      }, 340)
    })
  }, [maxZIndex, moveItem, selectedItems, sizeFor])

  const handleStickyColor = useCallback((color: WorkspaceNote['color']) => {
    void Promise.all(selectedStickyNotes.map((note) => updateNote(note.id, { color })))
  }, [selectedStickyNotes, updateNote])

  const connectionPaths = useMemo(() => connections.flatMap((connection) => {
    const sourceItem = itemMap.get(connection.sourceItemId)
    const targetItem = itemMap.get(connection.targetItemId)
    if (!sourceItem || !targetItem) return []
    const source = cardAnchorPoint(boundsFor(sourceItem), connection.sourceAnchor)
    const target = cardAnchorPoint(boundsFor(targetItem), connection.targetAnchor)
    return [{ connection, ...connectionCurve(source, target, connection.sourceAnchor, connection.targetAnchor) }]
  }), [boundsFor, connections, itemMap])

  const worldPositionAt = useCallback((clientX: number, clientY: number): WorkspaceItemPlacement => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const current = viewportRef.current
    return {
      x: (clientX - rect.left - current.panX) / current.zoom,
      y: (clientY - rect.top - current.panY) / current.zoom
    }
  }, [])

  const handleDeleteConnection = useCallback(async (connectionId: string) => {
    try {
      await api.workspaceConnections.delete(connectionId)
      setConnections((previous) => previous.filter((connection) => connection.id !== connectionId))
      setSelectedConnectionId((current) => current === connectionId ? null : current)
    } catch (e) {
      useDocumentStore.getState().showToast(errorMessage(e, t('workspace.connectionDeleteFailed')))
    }
  }, [t])

  const handleConnectionStart = useCallback((
    sourceItemId: string,
    sourceAnchor: WorkspaceConnectionAnchor,
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (!activeWorkspaceId || event.button !== 0) return
    const sourceItem = itemMap.get(sourceItemId)
    if (!sourceItem) return
    event.preventDefault()
    event.stopPropagation()
    connectionCleanupRef.current?.()
    const workspaceId = activeWorkspaceId
    const source = cardAnchorPoint(boundsFor(sourceItem), sourceAnchor)
    const draft = { sourceItemId, sourceAnchor, source, pointer: source }
    setSelectedConnectionId(null)
    connectionDraftRef.current = draft
    setConnectionDraft(draft)

    const cleanup = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (connectionFrameRef.current !== null) {
        cancelAnimationFrame(connectionFrameRef.current)
        connectionFrameRef.current = null
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      connectionDraftRef.current = null
      setConnectionDraft(null)
      if (connectionCleanupRef.current === cleanup) connectionCleanupRef.current = null
    }

    const onMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault()
      const pointer = worldPositionAt(moveEvent.clientX, moveEvent.clientY)
      const current = connectionDraftRef.current
      if (!current) return
      connectionDraftRef.current = { ...current, pointer }
      if (connectionFrameRef.current !== null) return
      connectionFrameRef.current = requestAnimationFrame(() => {
        connectionFrameRef.current = null
        const latest = connectionDraftRef.current
        if (!latest || !connectionPreviewPathRef.current) return
        const targetAnchor = targetAnchorForPreview(latest.source, latest.pointer)
        const preview = connectionCurve(
          latest.source,
          latest.pointer,
          latest.sourceAnchor,
          targetAnchor
        )
        connectionPreviewPathRef.current.setAttribute('d', preview.path)
      })
    }

    const onUp = (upEvent: MouseEvent) => {
      const pointer = worldPositionAt(upEvent.clientX, upEvent.clientY)
      const elements = document.elementsFromPoint?.(upEvent.clientX, upEvent.clientY) ?? []
      const targetElement = elements
        .map((element) => element.closest<HTMLElement>('[data-workspace-card-id]'))
        .find((element): element is HTMLElement => Boolean(element))
      const targetItemId = targetElement?.dataset.workspaceCardId
      const targetItem = targetItemId ? itemMap.get(targetItemId) : undefined
      cleanup()
      if (!targetItemId || !targetItem || targetItemId === sourceItemId) return
      const targetAnchor = closestCardAnchor(pointer, boundsFor(targetItem))
      void api.workspaceConnections.create(
        workspaceId,
        sourceItemId,
        targetItemId,
        sourceAnchor,
        targetAnchor
      ).then((saved) => {
        if (activeWorkspaceIdRef.current !== workspaceId) return
        setConnections((previous) => {
          const withoutSaved = previous.filter((connection) => connection.id !== saved.id)
          return [...withoutSaved, saved]
        })
      }).catch((e) => {
        if (activeWorkspaceIdRef.current === workspaceId) {
          useDocumentStore.getState().showToast(errorMessage(e, t('workspace.connectionSaveFailed')))
        }
      })
    }

    connectionCleanupRef.current = cleanup
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'crosshair'
    document.body.style.userSelect = 'none'
  }, [activeWorkspaceId, boundsFor, itemMap, t, worldPositionAt])

  const placementAtCanvasCenter = useCallback((): WorkspaceItemPlacement => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const center = worldPositionAt(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return { x: Math.round(center.x - 150), y: Math.round(center.y - 100) }
  }, [worldPositionAt])

  const handleWheel = useCallback((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      return
    }
    const target = event.target
    if (target instanceof HTMLElement && target.closest('[data-card-scroll]')) return
    event.preventDefault()
    const current = viewportRef.current
    const next = {
      panX: current.panX - event.deltaX,
      panY: current.panY - event.deltaY,
      zoom: WORKSPACE_CANVAS_DEFAULT_ZOOM
    }
    updateViewportTransient(next)
    scheduleViewportSave(next)
  }, [scheduleViewportSave, updateViewportTransient])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const handleCanvasPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || spacePressedRef.current) return
    const target = event.target as HTMLElement
    if (target.closest('[data-selection-toolbar]')) return
    const card = target.closest<HTMLElement>('[data-workspace-card-id]')
    const itemId = card?.dataset.workspaceCardId
    if (!itemId) return
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    if (additive && selectedItemIds.has(itemId)) {
      event.preventDefault()
      canvasRef.current?.focus({ preventScroll: true })
    }
    setSelectedConnectionId(null)
    setSelectedItemIds((current) => {
      if (!additive) return current.has(itemId) ? current : new Set([itemId])
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const handleCanvasFocusCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const itemId = target.closest<HTMLElement>('[data-workspace-card-id]')?.dataset.workspaceCardId
    if (!itemId) return
    setSelectedConnectionId(null)
    setSelectedItemIds((current) => current.has(itemId) ? current : new Set([itemId]))
  }

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as HTMLElement
    const wantsPan = e.button === 1 || (e.button === 0 && spacePressedRef.current)
    if (target.closest('[data-selection-toolbar], [role="dialog"]')) return
    if (!wantsPan) {
      if (target.closest('[data-workspace-card], button, input, textarea, a')) return
      e.preventDefault()
      canvasRef.current?.focus({ preventScroll: true })
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const pointerId = e.pointerId
      const startX = e.clientX
      const startY = e.clientY
      const initialSelection = new Set(selectedItemIds)
      const additive = e.shiftKey || e.metaKey || e.ctrlKey
      let moved = false
      if (!additive) setSelectedItemIds(new Set())
      setSelectedConnectionId(null)

      const cleanup = () => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onCancel)
        document.body.style.userSelect = ''
        setMarqueeSelection(null)
        marqueeCleanupRef.current = null
      }
      const onMove = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return
        const deltaX = event.clientX - startX
        const deltaY = event.clientY - startY
        if (!moved && Math.hypot(deltaX, deltaY) < 4) return
        moved = true
        const left = Math.min(startX, event.clientX)
        const top = Math.min(startY, event.clientY)
        const right = Math.max(startX, event.clientX)
        const bottom = Math.max(startY, event.clientY)
        setMarqueeSelection({
          left: left - rect.left,
          top: top - rect.top,
          width: right - left,
          height: bottom - top
        })
        const next = additive ? new Set(initialSelection) : new Set<string>()
        canvasRef.current?.querySelectorAll<HTMLElement>('[data-workspace-card-id]').forEach((card) => {
          const cardRect = card.getBoundingClientRect()
          if (
            cardRect.right >= left
            && cardRect.left <= right
            && cardRect.bottom >= top
            && cardRect.top <= bottom
          ) {
            const itemId = card.dataset.workspaceCardId
            if (itemId) next.add(itemId)
          }
        })
        setSelectedItemIds(next)
      }
      const onUp = (event: PointerEvent) => {
        if (event.pointerId === pointerId) cleanup()
      }
      const onCancel = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return
        setSelectedItemIds(initialSelection)
        cleanup()
      }
      marqueeCleanupRef.current?.()
      marqueeCleanupRef.current = cleanup
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onCancel)
      document.body.style.userSelect = 'none'
      return
    }
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const pointerId = e.pointerId
    const start = {
      x: e.clientX,
      y: e.clientY,
      panX: viewportRef.current.panX,
      panY: viewportRef.current.panY
    }
    canvasRef.current?.classList.add('is-panning')
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      updateViewportTransient({
        panX: start.panX + event.clientX - start.x,
        panY: start.panY + event.clientY - start.y,
        zoom: WORKSPACE_CANVAS_DEFAULT_ZOOM
      })
    }
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      canvasRef.current?.classList.remove('is-panning')
      panCleanupRef.current = null
    }
    const finish = () => {
      cleanup()
      flushViewportVisuals()
      commitViewport(viewportRef.current)
    }
    const onUp = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish()
    }
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish()
    }
    panCleanupRef.current?.()
    panCleanupRef.current = cleanup
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }

  const hasDocPayload = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes(DOC_MIME)

  const hasFilePayload = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files')

  const hasSupportedPayload = (e: React.DragEvent) => hasDocPayload(e) || hasFilePayload(e)

  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasSupportedPayload(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!hasSupportedPayload(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false)
  }

  const parseDocIds = (e: React.DragEvent): string[] => {
    const raw = e.dataTransfer.getData(DOC_MIME)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
      }
    } catch {
      return []
    }
    return []
  }

  const handleDrop = async (e: React.DragEvent) => {
    if (!hasSupportedPayload(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)
    const world = worldPositionAt(e.clientX, e.clientY)
    const placement = { x: Math.round(world.x - 150), y: Math.round(world.y - 100) }
    try {
      if (hasDocPayload(e)) {
        const ids = parseDocIds(e)
        if (ids.length === 0) return
        await addDocs(ids, placement)
      } else {
        const paths = (await Promise.all(
          Array.from(e.dataTransfer.files).map((file) => api.getPathForFile(file))
        )).filter((path) => path.length > 0)
        if (paths.length === 0) return
        await addFiles(paths, placement)
      }
    } catch (error) {
      setSummaryErrors((previous) => new Map(previous).set('__drop__', errorMessage(error, t('workspace.addFailed'))))
      if (dropErrorTimerRef.current) clearTimeout(dropErrorTimerRef.current)
      dropErrorTimerRef.current = setTimeout(() => {
        setSummaryErrors((previous) => {
          const next = new Map(previous)
          next.delete('__drop__')
          return next
        })
      }, 3500)
    }
  }

  const handleOpenAsset = useCallback((assetId: string) => {
    void api.workspaceAssets.open(assetId).catch((error) => {
      useDocumentStore.getState().showToast(errorMessage(error, t('workspace.assetOpenFailed')))
    })
  }, [t])

  const handleRevealAsset = useCallback((assetId: string) => {
    void api.workspaceAssets.reveal(assetId).catch((error) => {
      useDocumentStore.getState().showToast(errorMessage(error, t('workspace.assetRevealFailed')))
    })
  }, [t])

  const runClipboardAction = useCallback((action: () => Promise<void>) => {
    void action().then(() => {
      useDocumentStore.getState().showToast(t('workspace.cardCopySuccess'))
    }).catch((error) => {
      useDocumentStore.getState().showToast(errorMessage(error, t('workspace.cardCopyFailed')))
    })
  }, [t])

  const handleCopyAsset = useCallback((assetId: string) => {
    runClipboardAction(() => api.clipboard.copyWorkspaceAsset(assetId))
  }, [runClipboardAction])

  const handleCopyMarkdown = useCallback((title: string, content: string) => {
    runClipboardAction(() => api.clipboard.copyMarkdown(title, content))
  }, [runClipboardAction])

  const handleCopyText = useCallback((text: string) => {
    runClipboardAction(() => api.clipboard.writeText(text))
  }, [runClipboardAction])

  const handleCreateNote = useCallback(async (
    noteType: WorkspaceNoteType,
    placement?: WorkspaceItemPlacement
  ) => {
    const title = noteType === 'plain'
      ? t('workspace.stickyNoteUntitled')
      : t('workspace.noteUntitled')
    const note = await createNote(title, '', noteType, placement ?? placementAtCanvasCenter())
    if (!note) return
    if (noteType === 'plain') {
      setAutoEditStickyNoteId(note.id)
    } else if (onOpenMarkdownCard) {
      onOpenMarkdownCard({ kind: 'note', id: note.id }, 'edit')
    } else {
      setAutoEditNoteId(note.id)
    }
  }, [createNote, onOpenMarkdownCard, placementAtCanvasCenter, t])

  useImperativeHandle(ref, () => ({
    createNote: (noteType) => {
      void handleCreateNote(noteType)
    },
    addFiles: () => {
      void addAssets([], placementAtCanvasCenter())
    }
  }), [addAssets, handleCreateNote, placementAtCanvasCenter])

  const handleCanvasContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-workspace-card], button, input, textarea, a, [role="dialog"]')) return
    event.preventDefault()
    event.stopPropagation()
    const world = worldPositionAt(event.clientX, event.clientY)
    const placement = { x: Math.round(world.x - 150), y: Math.round(world.y - 100) }
    const items: ContextMenuItem[] = [
      {
        key: 'add-files',
        label: t('workspace.assetAdd'),
        icon: <FilePlus className="h-3.5 w-3.5" />,
        onClick: () => void addAssets([], placement)
      },
      { type: 'divider', key: 'file-divider' },
      {
        key: 'create-sticky-note',
        label: t('workspace.createStickyNote'),
        icon: <Sticker className="h-3.5 w-3.5" />,
        onClick: () => void handleCreateNote('plain', placement)
      },
      {
        key: 'create-markdown-note',
        label: t('workspace.createNote'),
        icon: <NotePencil className="h-3.5 w-3.5" />,
        onClick: () => void handleCreateNote('markdown', placement)
      }
    ]
    showContextMenu(items)
  }, [addAssets, handleCreateNote, t, worldPositionAt])

  const getViewportScale = useCallback(() => WORKSPACE_CANVAS_DEFAULT_ZOOM, [])

  const cardProps = useCallback((item: WorkspaceItem) => ({
    sizeKey: item.id,
    size: sizeFor(item),
    position: positionFor(item),
    getScale: getViewportScale,
    canStartDrag: () => !spacePressedRef.current,
    selected: selectedItemIds.has(item.id),
    animatePosition: animatingItemIds.has(item.id),
    frontZIndex: maxZIndex + 1,
    onSizeChange: handleCardSizeChange,
    onSizeCommit: handleCardSizeCommit,
    onSizeCancel: handleCardSizeCancel,
    onPositionChange: handleCardPositionChange,
    onPositionCommit: handleCardPositionCommit,
    onPositionCancel: handleCardPositionCancel,
    onConnectionStart: handleConnectionStart,
    connectionLabel: t('workspace.connectionStart'),
    moveLabel: t('workspace.moveCard')
  }), [
    getViewportScale,
    animatingItemIds,
    handleCardPositionChange,
    handleCardPositionCancel,
    handleCardPositionCommit,
    handleCardSizeChange,
    handleCardSizeCancel,
    handleCardSizeCommit,
    handleConnectionStart,
    maxZIndex,
    positionFor,
    selectedItemIds,
    sizeFor,
    t
  ])

  const cardNodes = useMemo(() => sortedItems.map((item) => {
    if (item.kind === 'document' && item.docId) {
      const docId = item.docId
      const doc = docs.get(docId) ?? null
      const summary = summaries.get(docId) ?? null
      const summaryForReader = summary?.content ? summary : null
      return (
        <ResizableCard
          key={item.id}
          {...cardProps(item)}
          className="workspace-connection-accent--document"
        >
          <PaperCard
            doc={doc}
            summary={summary}
            summaryLoading={!loadedSummaryDocIds.has(docId)}
            summarizing={summarizing.has(docId)}
            summaryError={summaryErrors.get(docId) ?? null}
            onSummarize={() => handleSummarize(docId)}
            onOpenPdf={() => void openDocumentPdf(docId)}
            onRemove={() => void removeItem(item.id)}
            onOpenSummary={doc && summaryForReader && onOpenMarkdownCard
              ? () => onOpenMarkdownCard({ kind: 'summary', doc, summary: summaryForReader })
              : undefined}
            onCopy={doc
              ? () => handleCopyMarkdown(doc.title || doc.fileName, paperCardMarkdown(doc, summary))
              : undefined}
          />
        </ResizableCard>
      )
    }
    if (item.kind === 'report' && item.reportId) {
      const report = reportMap.get(item.reportId)
      if (!report) return null
      return (
        <ResizableCard
          key={item.id}
          {...cardProps(item)}
          className="workspace-connection-accent--report"
        >
          <ReportCard
            report={report}
            sourceDocuments={docs}
            onOpenSource={(docId) => void openDocumentPdf(docId)}
            onDelete={() => void deleteReport(report.id)}
            onUpdate={updateReport}
            onOpen={onOpenMarkdownCard
              ? () => onOpenMarkdownCard({ kind: 'report', id: report.id })
              : undefined}
            onEdit={onOpenMarkdownCard
              ? () => onOpenMarkdownCard({ kind: 'report', id: report.id }, 'edit')
              : undefined}
            onCopy={() => handleCopyMarkdown(
              report.title,
              markdownCardContent(report.title, report.contentMd)
            )}
          />
        </ResizableCard>
      )
    }
    if (item.kind === 'note' && item.noteId) {
      const note = noteMap.get(item.noteId)
      if (!note) return null
      if (note.noteType === 'plain') {
        return (
          <ResizableCard
            key={item.id}
            {...cardProps(item)}
            className="workspace-connection-accent--sticky"
          >
            <StickyNoteCard
              note={note}
              autoFocus={autoEditStickyNoteId === note.id}
              onAutoFocusHandled={() => setAutoEditStickyNoteId(null)}
              onDelete={() => void deleteNote(note.id)}
              onUpdate={updateNote}
              onCopy={handleCopyText}
            />
          </ResizableCard>
        )
      }
      return (
        <ResizableCard
          key={item.id}
          {...cardProps(item)}
          className="workspace-connection-accent--note"
        >
          <NoteCard
            note={note}
            autoEdit={autoEditNoteId === note.id}
            onAutoEditHandled={() => setAutoEditNoteId(null)}
            onDelete={() => void deleteNote(note.id)}
            onUpdate={updateNote}
            onOpen={onOpenMarkdownCard
              ? () => onOpenMarkdownCard({ kind: 'note', id: note.id })
              : undefined}
            onEdit={onOpenMarkdownCard
              ? () => onOpenMarkdownCard({ kind: 'note', id: note.id }, 'edit')
              : undefined}
            onCopy={() => handleCopyMarkdown(
              note.title,
              markdownCardContent(note.title, note.contentMd)
            )}
          />
        </ResizableCard>
      )
    }
    if (item.kind === 'asset' && item.assetId) {
      const asset = assetMap.get(item.assetId)
      if (!asset) return null
      return (
        <ResizableCard
          key={item.id}
          {...cardProps(item)}
          className="workspace-connection-accent--asset"
        >
          <AssetCard
            asset={asset}
            onOpen={() => handleOpenAsset(asset.id)}
            onReveal={() => handleRevealAsset(asset.id)}
            onDelete={() => void deleteAsset(asset.id)}
            onCopy={() => handleCopyAsset(asset.id)}
          />
        </ResizableCard>
      )
    }
    return null
  }), [
    assetMap,
    autoEditNoteId,
    autoEditStickyNoteId,
    cardProps,
    deleteAsset,
    deleteNote,
    deleteReport,
    docs,
    handleCopyAsset,
    handleCopyMarkdown,
    handleCopyText,
    handleOpenAsset,
    handleRevealAsset,
    handleSummarize,
    loadedSummaryDocIds,
    noteMap,
    onOpenMarkdownCard,
    removeItem,
    reportMap,
    sortedItems,
    summaries,
    summarizing,
    summaryErrors,
    updateNote,
    updateReport
  ])

  return (
    <div
      ref={canvasRef}
      tabIndex={-1}
      className={`board-surface relative h-full w-full min-h-0 min-w-0 select-none overflow-hidden outline-none ${spacePressed ? 'is-pan-ready cursor-grab' : 'cursor-default'} ${connectionDraft ? 'is-connecting' : ''}`}
      style={{
        outline: dropActive ? '2px dashed var(--color-accent)' : undefined,
        outlineOffset: dropActive ? '-6px' : undefined
      }}
      onPointerDownCapture={handleCanvasPointerDownCapture}
      onPointerDown={handleCanvasPointerDown}
      onFocusCapture={handleCanvasFocusCapture}
      onAuxClick={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onContextMenu={handleCanvasContextMenu}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
    >
      <div className="pointer-events-none absolute left-3 top-3 z-[200000]">
        {summaryErrors.get('__drop__') && (
          <div className="rounded-lg bg-error/10 px-3 py-1.5 text-xs text-error shadow-sm">
            {summaryErrors.get('__drop__')}
          </div>
        )}
      </div>

      {sortedItems.length === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10">
          <EmptyState
            className="h-full min-h-[200px]"
            icon={<FilePlus className="h-10 w-10" />}
            title={t('workspace.dragPapersHint')}
            description={t('workspace.createNoteHint')}
          />
        </div>
      )}

      <div
        ref={worldRef}
        className="workspace-canvas-world absolute left-0 top-0 h-px w-px origin-top-left"
        style={{ transform: `translate3d(${DEFAULT_VIEWPORT.panX}px, ${DEFAULT_VIEWPORT.panY}px, 0) scale(${DEFAULT_VIEWPORT.zoom})` }}
      >
        <svg className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-visible" aria-hidden="false">
          <defs>
            <marker id="workspace-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth">
              <path d="M 0 0 L 9 4.5 L 0 9 z" fill="var(--color-muted)" />
            </marker>
            <marker id="workspace-arrow-selected" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="strokeWidth">
              <path d="M 0 0 L 9 4.5 L 0 9 z" fill="var(--color-accent)" />
            </marker>
          </defs>
          {connectionPaths.map(({ connection, path }) => {
            const selected = selectedConnectionId === connection.id
            return (
              <g
                key={connection.id}
                ref={(element) => {
                  if (element) connectionGroupRefs.current.set(connection.id, element)
                  else connectionGroupRefs.current.delete(connection.id)
                }}
              >
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth="16"
                  style={{ pointerEvents: 'stroke' }}
                  role="button"
                  tabIndex={0}
                  aria-label={t('workspace.connectionSelect')}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelectedConnectionId(connection.id)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void handleDeleteConnection(connection.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Delete' || event.key === 'Backspace') {
                      event.preventDefault()
                      void handleDeleteConnection(connection.id)
                    }
                  }}
                />
                <path
                  d={path}
                  fill="none"
                  stroke={selected ? 'var(--color-accent)' : 'var(--color-muted)'}
                  strokeOpacity={selected ? 0.9 : 0.55}
                  strokeWidth={selected ? 2.5 : 2}
                  markerEnd={selected ? 'url(#workspace-arrow-selected)' : 'url(#workspace-arrow)'}
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            )
          })}
          {connectionDraft && (() => {
            const targetAnchor = targetAnchorForPreview(connectionDraft.source, connectionDraft.pointer)
            const preview = connectionCurve(
              connectionDraft.source,
              connectionDraft.pointer,
              connectionDraft.sourceAnchor,
              targetAnchor
            )
            return (
              <path
                ref={connectionPreviewPathRef}
                d={preview.path}
                fill="none"
                stroke="var(--color-muted)"
                strokeOpacity="0.65"
                strokeWidth="2"
                strokeDasharray="7 6"
                markerEnd="url(#workspace-arrow)"
              />
            )
          })()}
        </svg>
        {cardNodes}
        {selectedBounds && (
          <div
            data-selection-toolbar
            className="absolute z-[300000] flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-panel/95 p-1 shadow-lg backdrop-blur"
            style={{
              left: (selectedBounds.minX + selectedBounds.maxX) / 2,
              top: selectedBounds.maxY + 12
            }}
            role="toolbar"
            aria-label={t('workspace.selectionActions')}
          >
            <span
              className="flex h-7 min-w-7 items-center justify-center rounded-lg bg-background px-2 text-xs tabular-nums text-muted"
              aria-label={t('workspace.selectionCount')}
            >
              {selectedItems.length}
            </span>
            <button
              type="button"
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-foreground hover:bg-background disabled:cursor-default disabled:opacity-40"
              disabled={selectedItems.length < 2}
              onClick={() => arrangeSelected('stack')}
              aria-label={t('workspace.selectionStack')}
              title={t('workspace.selectionStack')}
            >
              <Stack className="h-3.5 w-3.5" />
              {t('workspace.selectionStack')}
            </button>
            <button
              type="button"
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-foreground hover:bg-background disabled:cursor-default disabled:opacity-40"
              disabled={selectedItems.length < 2}
              onClick={() => arrangeSelected('grid')}
              aria-label={t('workspace.selectionGrid')}
              title={t('workspace.selectionGrid')}
            >
              <GridFour className="h-3.5 w-3.5" />
              {t('workspace.selectionGrid')}
            </button>
            {selectedStickyNotes.length > 0 && (
              <>
                <div className="mx-0.5 h-5 w-px bg-border" />
                <Palette
                  className="mx-1 h-3.5 w-3.5 text-muted"
                  aria-label={t('workspace.stickyColor')}
                />
                {STICKY_NOTE_COLORS.map((option) => {
                  const active = selectedStickyNotes.every((note) => (note.color ?? 'sand') === option.id)
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`h-5 w-5 rounded-full border transition-transform hover:scale-110 ${active ? 'border-accent ring-2 ring-accent/30' : 'border-black/10'}`}
                      style={{ backgroundColor: option.value }}
                      onClick={() => handleStickyColor(option.id)}
                      aria-label={t(`workspace.stickyColor${option.label}`)}
                      title={t(`workspace.stickyColor${option.label}`)}
                    />
                  )
                })}
              </>
            )}
          </div>
        )}
        {selectedConnectionId && connectionPaths.map(({ connection, midpoint }) => (
          connection.id === selectedConnectionId && (
            <button
              key={connection.id}
              ref={(element) => {
                if (element) connectionDeleteRefs.current.set(connection.id, element)
                else connectionDeleteRefs.current.delete(connection.id)
              }}
              type="button"
              className="absolute z-[200003] flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-panel text-sm leading-none text-muted shadow-md hover:border-error hover:text-error"
              style={{ left: midpoint.x, top: midpoint.y }}
              aria-label={t('workspace.connectionDelete')}
              title={t('workspace.connectionDelete')}
              onClick={() => void handleDeleteConnection(connection.id)}
            >
              ×
            </button>
          )
        ))}
      </div>
      {marqueeSelection && (
        <div
          className="workspace-selection-marquee pointer-events-none absolute z-[250000]"
          style={marqueeSelection}
          aria-hidden
        />
      )}
    </div>
  )
})

export default Board
