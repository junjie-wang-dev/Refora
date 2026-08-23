import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import {
  Copy,
  CursorText,
  Highlighter,
  ListBullets,
  NoteBlank,
  Plus,
  Sparkle
} from '@phosphor-icons/react'
import { showContextMenu, type ContextMenuItem } from '@lobehub/ui'
import { useTranslation } from 'react-i18next'
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask
} from 'pdfjs-dist/types/src/display/api'
import type { TextLayer } from 'pdfjs-dist/types/src/display/text_layer'
import {
  usePdfReaderStore,
  type PdfAnnotation,
  type PdfAnnotationDraft,
  type PdfPoint,
  type PdfRect,
  type PdfTool
} from '../store/pdfReaderStore'
import { api } from '../ipc'
import { useChatDraftStore } from '../store/chatDraftStore'
import { useDocumentStore } from '../store/documentStore'
import {
  annotationSelectionRects,
  annotationIdsInSelection,
  selectionRectFromPoints
} from '../utils/pdfAnnotationSelection'
import {
  pdfCanvasLayout,
  pdfCanvasTileTransform,
  pdfVisibilityObserverOptions,
  type PdfCanvasTile
} from '../utils/pdfCanvas'
import {
  pdfTextPositionAtPoint,
  quoteSelection,
  textSelectionInReader,
  updateTextSelection,
  updateWordSelection,
  type PdfTextClick,
  type PdfTextPointer,
  type PdfTextPosition
} from '../utils/pdfTextSelection'

interface PdfRuntime {
  TextLayer: typeof import('pdfjs-dist').TextLayer
}

let runtimePromise: Promise<PdfRuntime> | null = null

function loadPdfRuntime(): Promise<PdfRuntime> {
  if (!runtimePromise) {
    runtimePromise = import('pdfjs-dist').then((pdfjs) => ({
      TextLayer: pdfjs.TextLayer
    }))
  }
  return runtimePromise
}

function annotationLabel(annotation: PdfAnnotation, t: (key: string) => string): string {
  return t(`pdfReader.tools.${annotation.kind}`)
}

function normalizedPoint(event: ReactPointerEvent, element: HTMLElement): PdfPoint {
  const bounds = element.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
  }
}

type PdfViewport = ReturnType<PDFPageProxy['getViewport']>

export interface PdfPageVisibility {
  page: number
  isVisible: boolean
  visibleArea: number
  viewportDistance: number
}

function PdfCanvasTileView({
  page,
  scrollRootRef,
  tile,
  viewport,
  pixelRatio
}: {
  page: PDFPageProxy
  scrollRootRef: RefObject<HTMLDivElement | null>
  tile: PdfCanvasTile
  viewport: PdfViewport
  pixelRatio: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const element = canvasRef.current
    const root = scrollRootRef.current
    if (!element || !root) return
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries[0]?.isIntersecting ?? false)
    }, pdfVisibilityObserverOptions(root))
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRootRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!visible) {
      renderTaskRef.current?.cancel()
      canvas.width = 1
      canvas.height = 1
      return
    }
    canvas.width = tile.pixelWidth
    canvas.height = tile.pixelHeight
    renderTaskRef.current?.cancel()
    const renderTask = page.render({
      canvas,
      viewport,
      transform: pdfCanvasTileTransform(tile, pixelRatio)
    })
    renderTaskRef.current = renderTask
    void renderTask.promise.catch((error: unknown) => {
      if (error instanceof Error && error.name === 'RenderingCancelledException') return
    })
    return () => renderTask.cancel()
  }, [page, pixelRatio, tile, viewport, visible])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute"
      style={{
        left: tile.cssX,
        top: tile.cssY,
        width: tile.cssWidth,
        height: tile.cssHeight
      }}
    />
  )
}

export default function PdfPage({
  pdf,
  pageNumber,
  scale,
  rotation,
  devicePixelRatio,
  scrollRootRef,
  documentId,
  documentTitle,
  annotations,
  tool,
  color,
  fontSize,
  strokeWidth,
  onAddAnnotation,
  onPageVisible
}: {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  rotation: number
  devicePixelRatio: number
  scrollRootRef: RefObject<HTMLDivElement | null>
  documentId: string
  documentTitle: string
  annotations: PdfAnnotation[]
  tool: PdfTool | null
  color: string
  fontSize: number
  strokeWidth: number
  onAddAnnotation: (draft: PdfAnnotationDraft) => PdfAnnotation | null
  onPageVisible: (visibility: PdfPageVisibility) => void
}) {
  const { t } = useTranslation()
  const pageElementRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const textLayerTaskRef = useRef<TextLayer | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [pageLoadError, setPageLoadError] = useState(false)
  const [pageLoadAttempt, setPageLoadAttempt] = useState(0)
  const [visible, setVisible] = useState(pageNumber <= 2)
  const [inkPoints, setInkPoints] = useState<PdfPoint[] | null>(null)
  const [selectionRect, setSelectionRect] = useState<PdfRect | null>(null)
  const [editingTextAnnotationId, setEditingTextAnnotationId] = useState<string | null>(null)
  const inkPointsRef = useRef<PdfPoint[] | null>(null)
  const selectionStartRef = useRef<PdfPoint | null>(null)
  const textSelectionStartRef = useRef<PdfTextPosition | null>(null)
  const textPointerRef = useRef<PdfTextPointer | null>(null)
  const lastTextClickRef = useRef<PdfTextClick | null>(null)
  const removeAnnotation = usePdfReaderStore((state) => state.removeAnnotation)
  const selectAnnotation = usePdfReaderStore((state) => state.selectAnnotation)
  const selectedAnnotationIds = usePdfReaderStore((state) => state.selectedAnnotationIds)
  const selectAnnotations = usePdfReaderStore((state) => state.selectAnnotations)
  const updateAnnotation = usePdfReaderStore((state) => state.updateAnnotation)
  const viewport = useMemo(
    () => page?.getViewport({ scale, rotation }) ?? null,
    [page, rotation, scale]
  )
  const size = viewport
    ? { width: viewport.width, height: viewport.height }
    : { width: 612 * scale, height: 792 * scale }
  const canvasLayout = useMemo(
    () => viewport
      ? pdfCanvasLayout(viewport.width, viewport.height, devicePixelRatio)
      : null,
    [devicePixelRatio, viewport]
  )
  const textSelectionEnabled = tool === null ||
    tool === 'highlight' ||
    tool === 'underline' ||
    tool === 'strikeout'

  useEffect(() => {
    if (!visible || page) return
    let cancelled = false
    setPageLoadError(false)
    void pdf.getPage(pageNumber).then((nextPage) => {
      if (!cancelled) setPage(nextPage)
    }).catch(() => {
      if (!cancelled) setPageLoadError(true)
    })
    return () => {
      cancelled = true
    }
  }, [page, pageLoadAttempt, pageNumber, pdf, visible])

  useEffect(() => {
    const element = pageElementRef.current
    const root = scrollRootRef.current
    if (!element || !root) return
    const observer = new IntersectionObserver((entries) => {
      const isVisible = entries[0]?.isIntersecting ?? false
      setVisible(isVisible)
    }, pdfVisibilityObserverOptions(root))
    observer.observe(element)
    return () => observer.disconnect()
  }, [onPageVisible, pageNumber, scrollRootRef])

  useEffect(() => {
    const element = pageElementRef.current
    const root = scrollRootRef.current
    if (!element || !root) return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const visibleArea = entry.isIntersecting
        ? Math.max(0, entry.intersectionRect.width) * Math.max(0, entry.intersectionRect.height)
        : 0
      const rootCenter = entry.rootBounds
        ? (entry.rootBounds.top + entry.rootBounds.bottom) / 2
        : root.getBoundingClientRect().top + root.clientHeight / 2
      const visibleCenter = (entry.intersectionRect.top + entry.intersectionRect.bottom) / 2
      onPageVisible({
        page: pageNumber,
        isVisible: entry.isIntersecting,
        visibleArea,
        viewportDistance: Math.abs(visibleCenter - rootCenter)
      })
    }, {
      root,
      threshold: Array.from({ length: 21 }, (_, index) => index / 20)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      onPageVisible({
        page: pageNumber,
        isVisible: false,
        visibleArea: 0,
        viewportDistance: Number.POSITIVE_INFINITY
      })
    }
  }, [onPageVisible, pageNumber, scrollRootRef])

  useEffect(() => {
    if (!page || !viewport || !textLayerRef.current) return
    const textContainer = textLayerRef.current
    textLayerTaskRef.current?.cancel()
    textContainer.replaceChildren()
    if (!visible) {
      return
    }
    let disposed = false
    void Promise.all([
      page.getTextContent(),
      loadPdfRuntime()
    ]).then(([textContent, runtime]) => {
      if (disposed) return
      textLayerTaskRef.current = new runtime.TextLayer({
        textContentSource: textContent,
        container: textContainer,
        viewport
      })
      return textLayerTaskRef.current.render()
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'RenderingCancelledException') return
    })
    return () => {
      disposed = true
      textLayerTaskRef.current?.cancel()
    }
  }, [page, viewport, visible])

  const addTextAnnotation = useCallback(() => {
    if (
      tool !== 'highlight' &&
      tool !== 'underline' &&
      tool !== 'strikeout'
    ) return
    const root = scrollRootRef.current
    if (!root) return
    const selection = textSelectionInReader(root)
    if (!selection) return
    selection.pages.forEach((selectedPage) => {
      onAddAnnotation({
        kind: tool,
        page: selectedPage.page,
        color,
        text: selectedPage.text,
        comment: '',
        rects: selectedPage.rects
      })
    })
    window.getSelection()?.removeAllRanges()
  }, [color, onAddAnnotation, scrollRootRef, tool])

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const root = scrollRootRef.current
    if (!root) return
    const selection = textSelectionInReader(root)
    if (!selection) return
    event.preventDefault()
    event.stopPropagation()
    const clearSelection = () => window.getSelection()?.removeAllRanges()
    const requestAiDraft = (mode: 'prefill' | 'append', prompt: string) => {
      useChatDraftStore.getState().request({
        mode,
        text: `${prompt}\n\n${quoteSelection(selection.text)}`
      })
      clearSelection()
    }
    const items: ContextMenuItem[] = [
      {
        key: 'copy',
        label: t('pdfReader.contextMenu.copy'),
        icon: <Copy className="h-3.5 w-3.5" />,
        onClick: () => {
          void api.clipboard.writeText(selection.text).then(() => {
            useDocumentStore.getState().showToast(t('pdfReader.contextMenu.copySuccess'))
          }).catch(() => {
            useDocumentStore.getState().showToast(t('pdfReader.contextMenu.copyFailed'))
          })
        }
      },
      {
        key: 'highlight',
        label: t('pdfReader.contextMenu.highlight'),
        icon: <Highlighter className="h-3.5 w-3.5" />,
        onClick: () => {
          selection.pages.forEach((selectedPage) => {
            onAddAnnotation({
              kind: 'highlight',
              page: selectedPage.page,
              color,
              text: selectedPage.text,
              comment: '',
              rects: selectedPage.rects
            })
          })
          clearSelection()
        }
      },
      { type: 'divider', key: 'ai-divider' },
      {
        key: 'ai',
        type: 'submenu',
        label: t('pdfReader.contextMenu.ai'),
        icon: <Sparkle className="h-3.5 w-3.5" />,
        children: [
          {
            key: 'ai-summary',
            label: t('pdfReader.contextMenu.summary'),
            icon: <ListBullets className="h-3.5 w-3.5" />,
            onClick: () => requestAiDraft(
              'prefill',
              t('pdfReader.contextMenu.summaryPrompt')
            )
          },
          {
            key: 'ai-explain',
            label: t('pdfReader.contextMenu.explain'),
            icon: <CursorText className="h-3.5 w-3.5" />,
            onClick: () => requestAiDraft(
              'prefill',
              t('pdfReader.contextMenu.explainPrompt')
            )
          },
          {
            key: 'ai-context',
            label: t('pdfReader.contextMenu.addToAiContext'),
            icon: <Plus className="h-3.5 w-3.5" />,
            onClick: () => requestAiDraft(
              'append',
              t('pdfReader.contextMenu.contextPrompt', {
                title: documentTitle,
                pages: selection.pages.length === 1
                  ? String(selection.pages[0].page)
                  : `${selection.pages[0].page}–${selection.pages.at(-1)?.page}`
              })
            )
          }
        ]
      }
    ]
    showContextMenu(items)
  }, [color, documentTitle, onAddAnnotation, scrollRootRef, t])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = pageElementRef.current
    if (!element || event.button !== 0) return
    const target = event.target
    if (
      textSelectionEnabled &&
      target instanceof Element &&
      target.closest('.textLayer span, .textLayer br')
    ) {
      const root = scrollRootRef.current
      const position = root
        ? pdfTextPositionAtPoint(root, event.clientX, event.clientY)
        : null
      if (position) {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        if (selectedAnnotationIds.length > 0) selectAnnotations([])
        const previousClick = lastTextClickRef.current
        const doubleClick = previousClick !== null &&
          Date.now() - previousClick.at <= 500 &&
          Math.hypot(
            event.clientX - previousClick.clientX,
            event.clientY - previousClick.clientY
          ) <= 6
        lastTextClickRef.current = null
        textPointerRef.current = {
          clientX: event.clientX,
          clientY: event.clientY,
          moved: false
        }
        textSelectionStartRef.current = position
        if (doubleClick) updateWordSelection(position)
        else updateTextSelection(position, position)
      }
      return
    }
    lastTextClickRef.current = null
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    if (tool === null) {
      if (
        target instanceof Element &&
        target.closest('.textLayer span, .textLayer br, button, textarea, [data-annotation-kind]')
      ) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const point = normalizedPoint(event, element)
      selectionStartRef.current = point
      setSelectionRect({ x: point.x, y: point.y, width: 0, height: 0 })
      return
    }
    if (tool === 'note') {
      onAddAnnotation({
        kind: 'note',
        page: pageNumber,
        color,
        text: '',
        comment: '',
        point: normalizedPoint(event, element)
      })
      return
    }
    if (tool === 'text') {
      const annotation = onAddAnnotation({
        kind: 'text',
        page: pageNumber,
        color,
        text: '',
        comment: '',
        point: normalizedPoint(event, element),
        fontSize
      })
      setEditingTextAnnotationId(annotation?.id ?? null)
      return
    }
    if (tool === 'ink') {
      event.currentTarget.setPointerCapture(event.pointerId)
      const points = [normalizedPoint(event, element)]
      inkPointsRef.current = points
      setInkPoints(points)
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = pageElementRef.current
    const textSelectionStart = textSelectionStartRef.current
    const root = scrollRootRef.current
    if (textSelectionStart && root && textSelectionEnabled) {
      const textPointer = textPointerRef.current
      if (
        textPointer &&
        Math.hypot(
          event.clientX - textPointer.clientX,
          event.clientY - textPointer.clientY
        ) > 4
      ) textPointer.moved = true
      const position = pdfTextPositionAtPoint(root, event.clientX, event.clientY)
      if (position) updateTextSelection(textSelectionStart, position)
      return
    }
    const selectionStart = selectionStartRef.current
    if (element && selectionStart && tool === null) {
      setSelectionRect(selectionRectFromPoints(
        selectionStart,
        normalizedPoint(event, element)
      ))
      return
    }
    const points = inkPointsRef.current
    if (!element || !points || tool !== 'ink') return
    const nextPoints = [...points, normalizedPoint(event, element)]
    inkPointsRef.current = nextPoints
    setInkPoints(nextPoints)
  }

  const finishInk = () => {
    const points = inkPointsRef.current
    inkPointsRef.current = null
    if (!points || points.length < 2) {
      setInkPoints(null)
      return
    }
    onAddAnnotation({
      kind: 'ink',
      page: pageNumber,
      color,
      text: '',
      comment: '',
      points,
      strokeWidth
    })
    setInkPoints(null)
  }

  const cancelInk = () => {
    inkPointsRef.current = null
    setInkPoints(null)
  }

  const finishSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = pageElementRef.current
    const start = selectionStartRef.current
    selectionStartRef.current = null
    if (!element || !start) {
      setSelectionRect(null)
      return
    }
    const end = normalizedPoint(event, element)
    const rect = selectionRectFromPoints(start, end)
    const selection = rect.width < 0.004 && rect.height < 0.004
      ? {
          x: Math.max(0, end.x - 0.01),
          y: Math.max(0, end.y - 0.01),
          width: 0.02,
          height: 0.02
        }
      : rect
    selectAnnotations(annotationIdsInSelection(annotations, selection))
    setSelectionRect(null)
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (textSelectionStartRef.current) {
      const textPointer = textPointerRef.current
      lastTextClickRef.current = textPointer && !textPointer.moved
        ? {
            at: Date.now(),
            clientX: textPointer.clientX,
            clientY: textPointer.clientY
          }
        : null
      textPointerRef.current = null
      textSelectionStartRef.current = null
      addTextAnnotation()
    } else if (tool === null) finishSelection(event)
    else if (tool === 'ink') finishInk()
  }

  const cancelPointer = () => {
    textPointerRef.current = null
    lastTextClickRef.current = null
    textSelectionStartRef.current = null
    selectionStartRef.current = null
    setSelectionRect(null)
    cancelInk()
  }

  useEffect(() => {
    textPointerRef.current = null
    lastTextClickRef.current = null
    textSelectionStartRef.current = null
    if (tool !== 'ink') {
      inkPointsRef.current = null
      setInkPoints(null)
    }
    if (tool !== null) {
      selectionStartRef.current = null
      setSelectionRect(null)
    }
  }, [tool])

  useEffect(() => {
    if (!editingTextAnnotationId) return
    const annotation = annotations.find((item) => item.id === editingTextAnnotationId)
    if (!annotation || annotation.kind !== 'text' || annotation.color === color) return
    updateAnnotation(documentId, annotation.id, { color })
  }, [
    annotations,
    color,
    documentId,
    editingTextAnnotationId,
    updateAnnotation
  ])

  useEffect(() => {
    if (!editingTextAnnotationId) return
    const frame = window.requestAnimationFrame(() => {
      pageElementRef.current
        ?.querySelector<HTMLTextAreaElement>(
          `[data-text-annotation-id="${editingTextAnnotationId}"]`
        )
        ?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [editingTextAnnotationId])

  return (
    <div
      ref={pageElementRef}
      data-page-number={pageNumber}
      className="pdf-reader-page relative shrink-0 overflow-hidden bg-white shadow-lg"
      style={{
        width: size.width,
        height: size.height,
        '--scale-factor': scale,
        '--total-scale-factor': scale
      } as CSSProperties}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={cancelPointer}
    >
      {pageLoadError && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-panel text-sm text-error" role="alert">
          <span>{t('pdfReader.pageLoadFailed', { page: pageNumber })}</span>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-hover"
            onClick={() => setPageLoadAttempt((attempt) => attempt + 1)}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {page && viewport && canvasLayout?.tiles.map((tile) => (
        <PdfCanvasTileView
          key={`${tile.pixelX}-${tile.pixelY}`}
          page={page}
          scrollRootRef={scrollRootRef}
          tile={tile}
          viewport={viewport}
          pixelRatio={canvasLayout.pixelRatio}
        />
      ))}
      <div
        ref={textLayerRef}
        className="textLayer absolute inset-0"
        style={{
          width: size.width,
          height: size.height,
          zIndex: textSelectionEnabled ? 10 : 0
        }}
      />
      <div
        data-annotation-input-layer
        className={`absolute inset-0 ${
          tool === 'note' || tool === 'text' || tool === 'ink'
            ? 'pointer-events-auto'
            : 'pointer-events-none'
        }`}
        style={{
          zIndex: tool === 'note' || tool === 'text' || tool === 'ink' ? 20 : 0,
          cursor: tool === 'note'
            ? 'crosshair'
            : tool === 'text'
              ? 'text'
              : tool === 'ink'
                ? 'cell'
                : undefined
        }}
      />
      <svg
        className={`absolute inset-0 h-full w-full ${
          tool === 'eraser' ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
        style={{ zIndex: tool === 'eraser' || tool === null ? 20 : 0 }}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-label={t('pdfReader.annotations')}
      >
        {annotations.map((annotation) => {
          if (annotation.kind === 'ink' && annotation.points) {
            return (
              <polyline
                key={annotation.id}
                data-annotation-kind="ink"
                points={annotation.points.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="none"
                stroke={annotation.color}
                strokeWidth={annotation.strokeWidth ?? 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className={
                  tool === 'eraser' || tool === null
                    ? 'pointer-events-stroke cursor-pointer'
                    : ''
                }
                style={selectedAnnotationIds.includes(annotation.id)
                  ? { filter: 'drop-shadow(0 0 2px var(--color-accent))' }
                  : undefined}
                role="button"
                tabIndex={tool === 'eraser' || tool === null ? 0 : -1}
                aria-label={annotationLabel(annotation, t)}
                aria-pressed={selectedAnnotationIds.includes(annotation.id)}
                onClick={() => {
                  if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
                  else if (tool === null) selectAnnotation(annotation.id)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
                  else if (tool === null) selectAnnotation(annotation.id)
                }}
              />
            )
          }
          return null
        })}
        {inkPoints && (
          <polyline
            data-ink-preview
            points={inkPoints.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {selectionRect && (
        <div
          data-annotation-selection
          className="pointer-events-none absolute z-40 border-2 border-accent bg-accent/10 shadow-[0_0_0_1px_rgba(255,255,255,0.9),0_2px_8px_rgba(0,0,0,0.18)]"
          style={{
            left: `${selectionRect.x * 100}%`,
            top: `${selectionRect.y * 100}%`,
            width: `${selectionRect.width * 100}%`,
            height: `${selectionRect.height * 100}%`
          }}
        />
      )}
      {annotations.flatMap((annotation) =>
        (annotation.rects ?? []).map((rect, index) => (
          <button
            key={`${annotation.id}-${index}`}
            type="button"
            tabIndex={index === 0 ? 0 : -1}
            className={`absolute z-20 border-0 p-0 ${
              tool === 'eraser' || tool === null
                ? 'pointer-events-auto cursor-pointer'
                : 'pointer-events-none'
            }`}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
              background: annotation.kind === 'highlight' ? annotation.color : 'transparent',
              opacity: annotation.kind === 'highlight' ? 0.36 : 1,
              borderBottom: annotation.kind === 'underline'
                ? `2px solid ${annotation.color}`
                : undefined,
              textDecoration: annotation.kind === 'strikeout'
                ? `line-through 2px ${annotation.color}`
                : undefined,
              boxShadow: selectedAnnotationIds.includes(annotation.id)
                ? '0 0 0 2px var(--color-accent)'
                : undefined
            }}
            aria-label={index === 0 ? annotationLabel(annotation, t) : undefined}
            aria-hidden={index === 0 ? undefined : true}
            onClick={() => {
              if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
              else if (tool === null) selectAnnotation(annotation.id)
            }}
          />
        ))
      )}
      {annotations.filter((annotation) => annotation.kind === 'note' && annotation.point).map(
        (annotation) => (
          <button
            key={annotation.id}
            type="button"
            className={`absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-black/15 text-black shadow-sm ${
              tool === 'eraser' || tool === null
                ? 'pointer-events-auto cursor-pointer'
                : 'pointer-events-none'
            } ${
              selectedAnnotationIds.includes(annotation.id) ? 'ring-2 ring-accent' : ''
            }`}
            style={{
              left: `${(annotation.point?.x ?? 0) * 100}%`,
              top: `${(annotation.point?.y ?? 0) * 100}%`,
              background: annotation.color
            }}
            aria-label={t('pdfReader.tools.note')}
            onClick={() => {
              if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
              else if (tool === null) selectAnnotation(annotation.id)
            }}
          >
            <NoteBlank className="h-3.5 w-3.5" weight="fill" />
          </button>
        )
      )}
      {annotations.filter((annotation) => annotation.kind === 'text' && annotation.point).map(
        (annotation) => {
          const point = annotation.point ?? { x: 0, y: 0 }
          const charactersPerLine = 24
          const rows = Math.max(
            2,
            Math.min(
              8,
              annotation.text.split('\n').reduce(
                (total, line) => total + Math.max(1, Math.ceil(line.length / charactersPerLine)),
                0
              )
            )
          )
          const width = Math.max(
            96,
            Math.min(220 * scale, size.width * (1 - point.x) - 8)
          )
          return (
            <textarea
              key={annotation.id}
              data-text-annotation-id={annotation.id}
              autoFocus={
                editingTextAnnotationId === annotation.id &&
                annotation.text.length === 0
              }
              value={annotation.text}
              rows={rows}
              placeholder={t('pdfReader.textPlaceholder')}
              className={`pdf-text-annotation absolute z-20 resize-none overflow-hidden border-0 bg-transparent p-0 text-black shadow-none outline-none ${
                tool === 'text'
                  ? 'pointer-events-auto'
                  : tool === null || tool === 'eraser'
                    ? 'pointer-events-auto cursor-pointer select-none'
                    : 'pointer-events-none'
              } ${
                selectedAnnotationIds.includes(annotation.id)
                  ? 'outline outline-1 outline-offset-2 outline-accent'
                  : ''
              }`}
              style={{
                left: `${point.x * 100}%`,
                top: `${point.y * 100}%`,
                width,
                color: annotation.color,
                fontSize: `${(annotation.fontSize ?? 14) * scale}px`,
                lineHeight: 1.35,
                '--pdf-text-annotation-color': annotation.color
              } as CSSProperties}
              aria-label={t('pdfReader.tools.text')}
              readOnly={tool !== 'text'}
              onPointerDown={(event) => {
                if (tool !== 'text') {
                  event.preventDefault()
                  window.getSelection()?.removeAllRanges()
                }
                event.stopPropagation()
              }}
              onClick={() => {
                if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
                else if (tool === null) selectAnnotation(annotation.id)
              }}
              onChange={(event) => updateAnnotation(
                documentId,
                annotation.id,
                { text: event.target.value }
              )}
              onBlur={() => {
                if (!annotation.text.trim()) {
                  removeAnnotation(documentId, annotation.id)
                  setEditingTextAnnotationId((current) =>
                    current === annotation.id ? null : current
                  )
                  return
                }
                setEditingTextAnnotationId((current) =>
                  current === annotation.id ? null : current
                )
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                if (!annotation.text.trim()) removeAnnotation(documentId, annotation.id)
                else event.currentTarget.blur()
              }}
            />
          )
        }
      )}
      {annotations
        .filter((annotation) => selectedAnnotationIds.includes(annotation.id))
        .flatMap((annotation) =>
          annotationSelectionRects(annotation).map((rect, index) => (
            <div
              key={`selection-${annotation.id}-${index}`}
              data-selected-annotation={annotation.id}
              aria-hidden="true"
              className="pointer-events-none absolute z-30 border-2 border-accent bg-accent/10 shadow-[0_0_0_1px_rgba(255,255,255,0.95),0_0_0_3px_color-mix(in_srgb,var(--color-accent)_38%,transparent)]"
              style={{
                left: `calc(${rect.x * 100}% - 3px)`,
                top: `calc(${rect.y * 100}% - 3px)`,
                width: `calc(${rect.width * 100}% + 6px)`,
                height: `calc(${rect.height * 100}% + 6px)`,
                minWidth: 10,
                minHeight: 10
              }}
            >
              <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full border border-white bg-accent shadow-sm" />
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full border border-white bg-accent shadow-sm" />
              <span className="absolute -bottom-1 -left-1 h-2 w-2 rounded-full border border-white bg-accent shadow-sm" />
              <span className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full border border-white bg-accent shadow-sm" />
            </div>
          ))
        )}
      <div className="pointer-events-none absolute bottom-2 right-3 rounded bg-black/45 px-1.5 py-0.5 text-[10px] text-white">
        {pageNumber}
      </div>
    </div>
  )
}
