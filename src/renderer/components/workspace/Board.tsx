import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { FilePlus, NotePencil, Sticker } from '@phosphor-icons/react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useDocumentStore } from '../../store/documentStore'
import { api } from '../../ipc'
import { registerRendererFlushTask, trackRendererPersistence } from '../../persistence'
import { EmptyState } from '../ui'
import {
  WORKSPACE_CANVAS_DEFAULT_ZOOM,
  errorMessage
} from '../../../shared/ipc-types'
import type {
  AiSummary,
  Document,
  WorkspaceCanvasViewport,
  WorkspaceConnection,
  WorkspaceConnectionAnchor,
  WorkspaceItem,
  WorkspaceItemsChangedEvent,
  WorkspaceItemPlacement,
  WorkspaceNote,
  WorkspaceNoteType
} from '../../../shared/ipc-types'
import {
  clampCardSize,
  type CardPosition,
  type CardSize
} from './ResizableCard'
import {
  cardAnchorPoint,
  closestCardAnchor,
  connectionCurve,
  targetAnchorForPreview
} from './connectionGeometry'
import BoardCanvasWorld, { type BoardConnectionDraft } from './BoardCanvasWorld'
import WorkspaceCards from './WorkspaceCards'
import { compactGridPlacements, DEFAULT_VIEWPORT, VIEWPORT_SAVE_DELAY } from './boardLayout'
import {
  hasFilePayload,
  hasWorkspaceDocumentPayload,
  hasWorkspaceDropPayload,
  workspaceDocumentIds
} from './boardDrop'
import useBoardSpacePan from './useBoardSpacePan'
import { useBoardDocuments } from '../../hooks/useBoardDocuments'

const EMPTY_NOTES: WorkspaceNote[] = []

interface MarqueeSelection {
  left: number
  top: number
  width: number
  height: number
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
  const panelView = useWorkspaceStore((s) => s.panelView)
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
  const documents = useDocumentStore((s) => s.documents)
  const searchResults = useDocumentStore((s) => s.searchResults)

  const [dropError, setDropError] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [autoEditNoteId, setAutoEditNoteId] = useState<string | null>(null)
  const [autoEditStickyNoteId, setAutoEditStickyNoteId] = useState<string | null>(null)
  const [connections, setConnections] = useState<WorkspaceConnection[]>([])
  const [connectionDraft, setConnectionDraft] = useState<BoardConnectionDraft | null>(null)
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [animatingItemIds, setAnimatingItemIds] = useState<Set<string>>(new Set())
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelection | null>(null)
  const { spacePressed, spacePressedRef } = useBoardSpacePan(panelView === 'workspace')
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const activeWorkspaceIdRef = useRef(activeWorkspaceId)
  const viewportRef = useRef<WorkspaceCanvasViewport>(DEFAULT_VIEWPORT)
  const pendingViewportRef = useRef<WorkspaceCanvasViewport | null>(null)
  const viewportFrameRef = useRef<number | null>(null)
  const viewportTouchedRef = useRef(false)
  const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewportSaveTaskRef = useRef<Promise<void> | null>(null)
  const dropErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panCleanupRef = useRef<(() => void) | null>(null)
  const marqueeCleanupRef = useRef<(() => void) | null>(null)
  const layoutAnimationFrameRef = useRef<number | null>(null)
  const layoutAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectionCleanupRef = useRef<(() => void) | null>(null)
  const connectionDraftRef = useRef<BoardConnectionDraft | null>(null)
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
  const {
    docs,
    summaries,
    loadedSummaryDocIds,
    summarizing,
    summaryErrors,
    summarize: handleSummarize
  } = useBoardDocuments({
    activeWorkspaceId,
    allDocIds,
    workspaceDocIds,
    documents,
    searchResults
  })
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
    const previousTask = viewportSaveTaskRef.current
    const request = () => api.workspaceCanvas.update(workspaceId, next).then(() => undefined)
    const orderedRequest = previousTask
      ? previousTask.then(request, request)
      : request()
    const task = trackRendererPersistence(orderedRequest).catch((e) => {
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        useDocumentStore.getState().showToast(errorMessage(e, t('workspace.canvasSaveFailed')))
      }
      throw e
    })
    viewportSaveTaskRef.current = task
    void task.finally(() => {
      if (viewportSaveTaskRef.current === task) viewportSaveTaskRef.current = null
    }).catch(() => undefined)
    return task
  }, [t])

  const scheduleViewportSave = useCallback((next: WorkspaceCanvasViewport) => {
    if (!activeWorkspaceId) return
    if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current)
    const workspaceId = activeWorkspaceId
    viewportSaveTimerRef.current = setTimeout(() => {
      viewportSaveTimerRef.current = null
      void persistViewport(workspaceId, next).catch(() => undefined)
    }, VIEWPORT_SAVE_DELAY)
  }, [activeWorkspaceId, persistViewport])

  const commitViewport = useCallback((next: WorkspaceCanvasViewport) => {
    if (viewportSaveTimerRef.current) {
      clearTimeout(viewportSaveTimerRef.current)
      viewportSaveTimerRef.current = null
    }
    updateViewportTransient(next)
    flushViewportVisuals()
    if (activeWorkspaceId) void persistViewport(activeWorkspaceId, next).catch(() => undefined)
  }, [activeWorkspaceId, flushViewportVisuals, persistViewport, updateViewportTransient])

  const flushViewportSave = useCallback(async () => {
    if (viewportSaveTimerRef.current) {
      clearTimeout(viewportSaveTimerRef.current)
      viewportSaveTimerRef.current = null
    }
    if (viewportSaveTaskRef.current) await viewportSaveTaskRef.current.catch(() => undefined)
    if (activeWorkspaceId && viewportTouchedRef.current) {
      await persistViewport(activeWorkspaceId, viewportRef.current)
    }
  }, [activeWorkspaceId, persistViewport])

  useEffect(() => registerRendererFlushTask(flushViewportSave), [flushViewportSave])

  useEffect(() => {
    if (layoutAnimationFrameRef.current !== null) {
      cancelAnimationFrame(layoutAnimationFrameRef.current)
      layoutAnimationFrameRef.current = null
    }
    if (layoutAnimationTimerRef.current) {
      clearTimeout(layoutAnimationTimerRef.current)
      layoutAnimationTimerRef.current = null
    }
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
    connectionCleanupRef.current?.()
    if (!activeWorkspaceId) return
    const workspaceId = activeWorkspaceId
    let cancelled = false
    let requestVersion = 0
    const loadConnections = () => {
      const currentRequestVersion = ++requestVersion
      void api.workspaceConnections.list(workspaceId).then((saved) => {
        if (
          !cancelled &&
          currentRequestVersion === requestVersion &&
          activeWorkspaceIdRef.current === workspaceId
        ) {
          setConnections(saved)
        }
      }).catch((e) => {
        if (!cancelled && currentRequestVersion === requestVersion) {
          useDocumentStore.getState().showToast(errorMessage(e, t('workspace.connectionLoadFailed')))
        }
      })
    }
    const handleWorkspaceItemsChanged = (payload: WorkspaceItemsChangedEvent) => {
      if (payload.workspaceId === workspaceId) loadConnections()
    }
    loadConnections()
    const dispose = api.events.onWorkspaceItemsChanged(handleWorkspaceItemsChanged)
    return () => {
      cancelled = true
      dispose()
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
      if (viewportTouchedRef.current) {
        void persistViewport(workspaceId, viewportRef.current).catch(() => undefined)
      }
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
      let rectCache: Array<{ id: string; left: number; top: number; right: number; bottom: number }> = []
      let rectCacheItems = itemMapRef.current
      let marqueeFrame: number | null = null
      let pendingMarquee: MarqueeSelection | null = null
      let pendingMarqueeSelection: Set<string> | null = null
      if (!additive) setSelectedItemIds(new Set())
      setSelectedConnectionId(null)

      const measureCards = () => {
        rectCacheItems = itemMapRef.current
        rectCache = []
        canvasRef.current?.querySelectorAll<HTMLElement>('[data-workspace-card-id]').forEach((card) => {
          const itemId = card.dataset.workspaceCardId
          if (!itemId) return
          const cardRect = card.getBoundingClientRect()
          rectCache.push({
            id: itemId,
            left: cardRect.left,
            top: cardRect.top,
            right: cardRect.right,
            bottom: cardRect.bottom
          })
        })
      }
      measureCards()

      const cleanup = () => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onCancel)
        document.body.style.userSelect = ''
        if (marqueeFrame !== null) {
          cancelAnimationFrame(marqueeFrame)
          marqueeFrame = null
        }
        pendingMarquee = null
        pendingMarqueeSelection = null
        rectCache = []
        setMarqueeSelection(null)
        marqueeCleanupRef.current = null
      }
      const onMove = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return
        const deltaX = event.clientX - startX
        const deltaY = event.clientY - startY
        if (!moved && Math.hypot(deltaX, deltaY) < 4) return
        moved = true
        if (rectCacheItems !== itemMapRef.current) measureCards()
        const left = Math.min(startX, event.clientX)
        const top = Math.min(startY, event.clientY)
        const right = Math.max(startX, event.clientX)
        const bottom = Math.max(startY, event.clientY)
        const next = additive ? new Set(initialSelection) : new Set<string>()
        for (const cardRect of rectCache) {
          if (
            cardRect.right >= left
            && cardRect.left <= right
            && cardRect.bottom >= top
            && cardRect.top <= bottom
          ) {
            next.add(cardRect.id)
          }
        }
        pendingMarquee = {
          left: left - rect.left,
          top: top - rect.top,
          width: right - left,
          height: bottom - top
        }
        pendingMarqueeSelection = next
        if (marqueeFrame === null) {
          marqueeFrame = requestAnimationFrame(() => {
            marqueeFrame = null
            if (pendingMarquee) setMarqueeSelection(pendingMarquee)
            if (pendingMarqueeSelection) setSelectedItemIds(pendingMarqueeSelection)
          })
        }
      }
      const onUp = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return
        if (pendingMarqueeSelection) setSelectedItemIds(pendingMarqueeSelection)
        cleanup()
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

  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasWorkspaceDropPayload(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!hasWorkspaceDropPayload(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    if (!hasWorkspaceDropPayload(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    setDropActive(false)
    const world = worldPositionAt(e.clientX, e.clientY)
    const placement = { x: Math.round(world.x - 150), y: Math.round(world.y - 100) }
    try {
      if (hasWorkspaceDocumentPayload(e.dataTransfer)) {
        const ids = workspaceDocumentIds(e.dataTransfer)
        if (ids.length === 0) return
        await addDocs(ids, placement)
      } else if (hasFilePayload(e.dataTransfer)) {
        const paths = (await Promise.all(
          Array.from(e.dataTransfer.files).map((file) => api.getPathForFile(file))
        )).filter((path) => path.length > 0)
        if (paths.length === 0) return
        await addFiles(paths, placement)
      }
    } catch (error) {
      setDropError(errorMessage(error, t('workspace.addFailed')))
      if (dropErrorTimerRef.current) clearTimeout(dropErrorTimerRef.current)
      dropErrorTimerRef.current = setTimeout(() => {
        setDropError(null)
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

  const handleRemoveItem = useCallback((itemId: string) => {
    void removeItem(itemId)
  }, [removeItem])

  const handleDeleteReport = useCallback((reportId: string) => {
    void deleteReport(reportId)
  }, [deleteReport])

  const handleDeleteNote = useCallback((noteId: string) => {
    void deleteNote(noteId)
  }, [deleteNote])

  const handleDeleteAsset = useCallback((assetId: string) => {
    void deleteAsset(assetId)
  }, [deleteAsset])

  const handleAutoEditNoteHandled = useCallback(() => setAutoEditNoteId(null), [])
  const handleAutoEditStickyNoteHandled = useCallback(
    () => setAutoEditStickyNoteId(null),
    []
  )

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

  const cardShell = useMemo<ComponentProps<typeof WorkspaceCards>['shell']>(() => ({
    canStartDrag: () => !spacePressedRef.current,
    frontZIndex: maxZIndex + 1,
    onSizeChange: handleCardSizeChange,
    onSizeCommit: handleCardSizeCommit,
    onSizeCancel: handleCardSizeCancel,
    onPositionChange: handleCardPositionChange,
    onPositionCommit: handleCardPositionCommit,
    onPositionCancel: handleCardPositionCancel,
    onConnectionStart: handleConnectionStart,
    connectionLabel: t('workspace.connectionStart'),
    moveLabel: t('workspace.moveCard'),
    resizeWidthLabel: t('workspace.resizeCardWidth'),
    resizeHeightLabel: t('workspace.resizeCardHeight'),
    resizeBothLabel: t('workspace.resizeCard')
  }), [
    handleCardPositionCancel,
    handleCardPositionChange,
    handleCardPositionCommit,
    handleCardSizeCancel,
    handleCardSizeChange,
    handleCardSizeCommit,
    handleConnectionStart,
    maxZIndex,
    t
  ])

  const cardNodes = (
    <WorkspaceCards
      items={sortedItems}
      documents={docs}
      summaries={summaries}
      reports={reportMap}
      notes={noteMap}
      assets={assetMap}
      loadedSummaryDocIds={loadedSummaryDocIds}
      summarizing={summarizing}
      summaryErrors={summaryErrors}
      autoEditNoteId={autoEditNoteId}
      autoEditStickyNoteId={autoEditStickyNoteId}
      shell={cardShell}
      selectedItemIds={selectedItemIds}
      animatingItemIds={animatingItemIds}
      onSummarize={handleSummarize}
      onRemoveItem={handleRemoveItem}
      onDeleteReport={handleDeleteReport}
      onUpdateReport={updateReport}
      onDeleteNote={handleDeleteNote}
      onUpdateNote={updateNote}
      onDeleteAsset={handleDeleteAsset}
      onOpenAsset={handleOpenAsset}
      onRevealAsset={handleRevealAsset}
      onCopyAsset={handleCopyAsset}
      onCopyMarkdown={handleCopyMarkdown}
      onCopyText={handleCopyText}
      onAutoEditNoteHandled={handleAutoEditNoteHandled}
      onAutoEditStickyNoteHandled={handleAutoEditStickyNoteHandled}
      onOpenMarkdownCard={onOpenMarkdownCard}
    />
  )

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
        {dropError && (
          <div className="rounded-lg bg-error/10 px-3 py-1.5 text-xs text-error shadow-sm">
            {dropError}
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

      <BoardCanvasWorld
        worldRef={worldRef}
        connectionPaths={connectionPaths}
        connectionDraft={connectionDraft}
        connectionPreviewPathRef={connectionPreviewPathRef}
        connectionGroupRefs={connectionGroupRefs}
        connectionDeleteRefs={connectionDeleteRefs}
        selectedConnectionId={selectedConnectionId}
        selectedBounds={selectedBounds}
        selectedItemCount={selectedItems.length}
        selectedStickyNotes={selectedStickyNotes}
        onSelectConnection={setSelectedConnectionId}
        onDeleteConnection={(connectionId) => void handleDeleteConnection(connectionId)}
        onArrangeSelected={arrangeSelected}
        onStickyColor={handleStickyColor}
      >
        {cardNodes}
      </BoardCanvasWorld>
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
