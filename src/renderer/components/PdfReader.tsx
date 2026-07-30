import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowLeft,
  ArrowSquareOut,
  ArrowsOutSimple,
  CaretLeft,
  CaretRight,
  CheckCircle,
  CursorClick,
  CursorText,
  Eraser,
  Highlighter,
  ListBullets,
  MagnifyingGlass,
  Minus,
  NoteBlank,
  PencilSimple,
  Plus,
  Textbox,
  TextStrikethrough,
  TextUnderline,
  Trash,
  WarningCircle,
  X
} from '@phosphor-icons/react'
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
import { openDocumentPdf } from '../utils/openPdf'
import {
  annotationSelectionRects,
  annotationIdsInSelection,
  selectionRectFromPoints
} from '../utils/pdfAnnotationSelection'
import 'pdfjs-dist/web/pdf_viewer.css'

const COLORS = ['#f2c94c', '#6fcf97', '#56ccf2', '#bb6bd9', '#eb5757']
const MIN_SCALE = 0.5
const MAX_SCALE = 3

interface PdfRuntime {
  getDocument: typeof import('pdfjs-dist').getDocument
  TextLayer: typeof import('pdfjs-dist').TextLayer
}

let runtimePromise: Promise<PdfRuntime> | null = null

function loadPdfRuntime(): Promise<PdfRuntime> {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return {
        getDocument: pdfjs.getDocument,
        TextLayer: pdfjs.TextLayer
      }
    })
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

function PdfPage({
  pdf,
  pageNumber,
  scale,
  rotation,
  documentId,
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
  documentId: string
  annotations: PdfAnnotation[]
  tool: PdfTool | null
  color: string
  fontSize: number
  strokeWidth: number
  onAddAnnotation: (draft: PdfAnnotationDraft) => PdfAnnotation | null
  onPageVisible: (page: number) => void
}) {
  const { t } = useTranslation()
  const pageElementRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const textLayerTaskRef = useRef<TextLayer | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [size, setSize] = useState({ width: 612 * scale, height: 792 * scale })
  const [visible, setVisible] = useState(pageNumber <= 2)
  const [inkPoints, setInkPoints] = useState<PdfPoint[] | null>(null)
  const [selectionRect, setSelectionRect] = useState<PdfRect | null>(null)
  const [editingTextAnnotationId, setEditingTextAnnotationId] = useState<string | null>(null)
  const inkPointsRef = useRef<PdfPoint[] | null>(null)
  const selectionStartRef = useRef<PdfPoint | null>(null)
  const removeAnnotation = usePdfReaderStore((state) => state.removeAnnotation)
  const selectAnnotation = usePdfReaderStore((state) => state.selectAnnotation)
  const selectedAnnotationIds = usePdfReaderStore((state) => state.selectedAnnotationIds)
  const selectAnnotations = usePdfReaderStore((state) => state.selectAnnotations)
  const updateAnnotation = usePdfReaderStore((state) => state.updateAnnotation)

  useEffect(() => {
    let cancelled = false
    void pdf.getPage(pageNumber).then((nextPage) => {
      if (!cancelled) setPage(nextPage)
    })
    return () => {
      cancelled = true
    }
  }, [pageNumber, pdf])

  useEffect(() => {
    const element = pageElementRef.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return
      setVisible(true)
      onPageVisible(pageNumber)
    }, { rootMargin: '700px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [onPageVisible, pageNumber])

  useEffect(() => {
    if (!page) return
    const viewport = page.getViewport({ scale, rotation })
    setSize({ width: viewport.width, height: viewport.height })
    if (!visible || !canvasRef.current || !textLayerRef.current) return
    const canvas = canvasRef.current
    const textContainer = textLayerRef.current
    const outputScale = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(viewport.width * outputScale)
    canvas.height = Math.floor(viewport.height * outputScale)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`
    renderTaskRef.current?.cancel()
    textLayerTaskRef.current?.cancel()
    textContainer.replaceChildren()
    renderTaskRef.current = page.render({
      canvas,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
    })
    let disposed = false
    void Promise.all([
      renderTaskRef.current.promise,
      page.getTextContent(),
      loadPdfRuntime()
    ]).then(([, textContent, runtime]) => {
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
      renderTaskRef.current?.cancel()
      textLayerTaskRef.current?.cancel()
    }
  }, [page, rotation, scale, visible])

  const addTextAnnotation = useCallback(() => {
    if (
      tool !== 'highlight' &&
      tool !== 'underline' &&
      tool !== 'strikeout'
    ) return
    const element = pageElementRef.current
    const selection = window.getSelection()
    if (!element || !selection || selection.isCollapsed || selection.rangeCount === 0) return
    const bounds = element.getBoundingClientRect()
    const rects = Array.from(selection.getRangeAt(0).getClientRects())
      .filter((rect) =>
        rect.right > bounds.left &&
        rect.left < bounds.right &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom
      )
      .map((rect) => ({
        x: Math.max(0, rect.left - bounds.left) / bounds.width,
        y: Math.max(0, rect.top - bounds.top) / bounds.height,
        width: Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left),
        height: Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top)
      }))
      .map((rect) => ({
        ...rect,
        width: rect.width / bounds.width,
        height: rect.height / bounds.height
      }))
      .filter((rect) => rect.width > 0 && rect.height > 0)
    if (rects.length === 0) return
    onAddAnnotation({
      kind: tool,
      page: pageNumber,
      color,
      text: selection.toString().trim(),
      comment: '',
      rects
    })
    selection.removeAllRanges()
  }, [color, onAddAnnotation, pageNumber, tool])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = pageElementRef.current
    if (!element) return
    if (tool === 'select') {
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
    const selectionStart = selectionStartRef.current
    if (element && selectionStart && tool === 'select') {
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
    if (tool === 'select') finishSelection(event)
    else if (tool === 'ink') finishInk()
  }

  const cancelPointer = () => {
    selectionStartRef.current = null
    setSelectionRect(null)
    cancelInk()
  }

  useEffect(() => {
    if (tool !== 'ink') {
      inkPointsRef.current = null
      setInkPoints(null)
    }
    if (tool !== 'select') {
      selectionStartRef.current = null
      setSelectionRect(null)
    }
  }, [tool])

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
      onMouseUp={addTextAnnotation}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div
        ref={textLayerRef}
        className="textLayer absolute inset-0"
        style={{ width: size.width, height: size.height }}
      />
      <div
        data-annotation-input-layer
        className={`absolute inset-0 ${
          tool === 'select' || tool === 'note' || tool === 'text' || tool === 'ink'
            ? 'pointer-events-auto'
            : 'pointer-events-none'
        }`}
        style={{
          cursor: tool === 'note'
            ? 'crosshair'
            : tool === 'text'
              ? 'text'
              : tool === 'ink'
                ? 'cell'
                : tool === 'select'
                  ? 'crosshair'
                  : undefined
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={cancelPointer}
      />
      <svg
        className={`absolute inset-0 h-full w-full ${
          tool === 'eraser' ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
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
                  tool === 'eraser' || tool === 'select'
                    ? 'pointer-events-stroke cursor-pointer'
                    : ''
                }
                style={selectedAnnotationIds.includes(annotation.id)
                  ? { filter: 'drop-shadow(0 0 2px var(--color-accent))' }
                  : undefined}
                onClick={() => {
                  if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
                  else if (tool === 'select') selectAnnotation(annotation.id)
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
            className={`absolute border-0 p-0 ${
              tool === 'eraser'
                ? 'pointer-events-auto cursor-pointer'
                : tool === 'select'
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
            aria-label={annotationLabel(annotation, t)}
            onClick={() => {
              if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
              else if (tool === 'select') selectAnnotation(annotation.id)
            }}
          />
        ))
      )}
      {annotations.filter((annotation) => annotation.kind === 'note' && annotation.point).map(
        (annotation) => (
          <button
            key={annotation.id}
            type="button"
            className={`absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-black/15 text-black shadow-sm ${
              tool === 'eraser' || tool === 'select' ? 'pointer-events-auto' : 'pointer-events-none'
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
              else if (tool === 'select') selectAnnotation(annotation.id)
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
              autoFocus={
                editingTextAnnotationId === annotation.id &&
                annotation.text.length === 0
              }
              value={annotation.text}
              rows={rows}
              placeholder={t('pdfReader.textPlaceholder')}
              className={`absolute z-20 resize-none overflow-hidden border-0 bg-transparent p-0 text-black shadow-none outline-none ${
                tool === 'text' || tool === 'select' || tool === 'eraser'
                  ? 'pointer-events-auto'
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
                lineHeight: 1.35
              }}
              aria-label={t('pdfReader.tools.text')}
              readOnly={tool !== 'text'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
                else if (tool === 'select') selectAnnotation(annotation.id)
              }}
              onChange={(event) => updateAnnotation(
                documentId,
                annotation.id,
                { text: event.target.value }
              )}
              onBlur={() => setEditingTextAnnotationId((current) =>
                current === annotation.id ? null : current
              )}
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

function AnnotationSidebar({
  annotations,
  documentId,
  overlay,
  onClose,
  onNavigate
}: {
  annotations: PdfAnnotation[]
  documentId: string
  overlay: boolean
  onClose: () => void
  onNavigate: (page: number, annotationId: string) => void
}) {
  const { t } = useTranslation()
  const selectedIds = usePdfReaderStore((state) => state.selectedAnnotationIds)
  const pendingCommentFocusId = usePdfReaderStore((state) => state.pendingCommentFocusId)
  const saveStatus = usePdfReaderStore(
    (state) => state.saveStatus[documentId] ?? 'idle'
  )
  const updateAnnotation = usePdfReaderStore((state) => state.updateAnnotation)
  const removeAnnotation = usePdfReaderStore((state) => state.removeAnnotation)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleAnnotations = annotations
    .filter((annotation) => {
      if (!normalizedQuery) return true
      return [
        annotation.text,
        annotation.comment,
        annotationLabel(annotation, t),
        String(annotation.page)
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
    })
    .sort((first, second) =>
      first.page - second.page || first.createdAt - second.createdAt
    )

  useEffect(() => {
    if (!pendingCommentFocusId) return
    const frame = window.requestAnimationFrame(() => {
      const textarea = Array.from(
        listRef.current?.querySelectorAll<HTMLTextAreaElement>(
          '[data-comment-annotation-id]'
        ) ?? []
      ).find((element) => element.dataset.commentAnnotationId === pendingCommentFocusId)
      textarea?.focus()
      textarea?.scrollIntoView({ block: 'nearest' })
      usePdfReaderStore.getState().consumeCommentFocus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [annotations, pendingCommentFocusId])

  useEffect(() => {
    if (pendingCommentFocusId) return
    const selectedId = selectedIds.at(-1)
    if (!selectedId) return
    const frame = window.requestAnimationFrame(() => {
      const card = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>('[data-annotation-card]') ?? []
      ).find((element) => element.dataset.annotationCard === selectedId)
      card?.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pendingCommentFocusId, selectedIds])

  return (
    <aside
      data-annotation-sidebar
      data-overlay={overlay || undefined}
      aria-label={t('pdfReader.annotations')}
      className={`flex w-72 shrink-0 flex-col border-l border-border bg-panel ${
      overlay
        ? 'absolute inset-y-0 right-0 z-40 max-w-[calc(100%-3rem)] shadow-[-12px_0_32px_rgba(0,0,0,0.22)]'
        : ''
      }`}
    >
      <div className="flex h-11 items-center gap-2 border-b border-border px-3">
        <ListBullets className="h-4 w-4 text-muted" />
        <span className="text-xs font-medium">{t('pdfReader.annotations')}</span>
        <span className="rounded-full bg-panel-2 px-2 py-0.5 text-label text-muted">
          {annotations.length}
        </span>
        <button
          type="button"
          disabled={saveStatus !== 'error'}
          aria-live="polite"
          className={`ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-label ${
            saveStatus === 'error' ? 'text-error' : 'text-muted'
          } disabled:cursor-default`}
          title={t(`pdfReader.saveStatus.${saveStatus}`)}
          onClick={() => usePdfReaderStore.getState().retrySave(documentId)}
        >
          {saveStatus === 'saved' && <CheckCircle className="h-3.5 w-3.5" weight="fill" />}
          {saveStatus === 'error' && <WarningCircle className="h-3.5 w-3.5" weight="fill" />}
          <span>
            {saveStatus === 'error'
              ? t('pdfReader.retrySave')
              : t(`pdfReader.saveStatus.${saveStatus}`)}
          </span>
        </button>
        {overlay && (
          <button
            type="button"
            className="rounded-md p-1 text-muted hover:bg-hover hover:text-foreground"
            aria-label={t('pdfReader.closeAnnotations')}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="border-b border-border p-2">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute left-2 top-1.5 h-4 w-4 text-muted" />
          <input
            value={query}
            aria-label={t('pdfReader.searchAnnotations')}
            placeholder={t('pdfReader.searchAnnotations')}
            className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground outline-none focus:border-accent"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {annotations.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-12 text-center text-xs text-muted">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-panel-2 text-accent">
              <Highlighter className="h-5 w-5" />
            </div>
            <span className="font-medium text-foreground">
              {t('pdfReader.noAnnotationsTitle')}
            </span>
            <span className="mt-1.5 leading-relaxed">
              {t('pdfReader.noAnnotations')}
            </span>
            <span className="mt-3 rounded-md bg-panel-2 px-2 py-1 text-label">
              {t('pdfReader.annotationHint')}
            </span>
          </div>
        ) : visibleAnnotations.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted">
            {t('pdfReader.noAnnotationResults')}
          </div>
        ) : visibleAnnotations.map((annotation) => (
          <div
            key={annotation.id}
            data-annotation-card={annotation.id}
            className={`mb-2 rounded-lg border p-2.5 ${
              selectedIds.includes(annotation.id)
                ? 'border-accent bg-active'
                : 'border-border bg-background'
            }`}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left"
              onClick={() => onNavigate(annotation.page, annotation.id)}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: annotation.color }}
              />
              <span className="text-label font-medium text-foreground">
                {annotationLabel(annotation, t)}
              </span>
              <span className="ml-auto text-label text-muted">
                {t('pdfReader.pageShort', { page: annotation.page })}
              </span>
            </button>
            {annotation.text && (
              <button
                type="button"
                className="mt-2 line-clamp-3 w-full border-l-2 pl-2 text-left text-label leading-relaxed text-muted"
                style={{ borderColor: annotation.color }}
                onClick={() => onNavigate(annotation.page, annotation.id)}
              >
                {annotation.text}
              </button>
            )}
            <textarea
              value={annotation.comment}
              rows={selectedIds.includes(annotation.id) ? 3 : 1}
              data-comment-annotation-id={annotation.id}
              placeholder={t('pdfReader.addComment')}
              className="mt-2 w-full resize-none rounded-md border border-border bg-panel-2 px-2 py-1.5 text-label text-foreground outline-none focus:border-accent"
              onFocus={() => {
                usePdfReaderStore.getState().setTool('select')
                usePdfReaderStore.getState().selectAnnotation(annotation.id)
              }}
              onChange={(event) => updateAnnotation(
                documentId,
                annotation.id,
                { comment: event.target.value }
              )}
            />
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                className="rounded p-1 text-muted hover:bg-hover hover:text-error"
                aria-label={t('common.delete')}
                onClick={() => removeAnnotation(documentId, annotation.id)}
              >
                <Trash className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

const TOOL_ICONS = {
  select: CursorClick,
  highlight: Highlighter,
  underline: TextUnderline,
  strikeout: TextStrikethrough,
  note: NoteBlank,
  text: Textbox,
  ink: PencilSimple,
  eraser: Eraser
} satisfies Record<PdfTool, typeof CursorClick>

const TOOL_SHORTCUTS: Record<PdfTool, string> = {
  select: 'A',
  highlight: 'H',
  underline: 'U',
  strikeout: 'S',
  note: 'N',
  text: 'T',
  ink: 'P',
  eraser: 'E'
}

function ReaderButton({
  label,
  shortcut,
  active = false,
  disabled = false,
  onClick,
  children
}: {
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      data-shortcut={shortcut}
      aria-pressed={active || undefined}
      disabled={disabled}
      className={`flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-muted transition-colors hover:bg-hover hover:text-foreground disabled:opacity-35 ${
        active ? 'bg-active text-accent' : ''
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

interface PdfReaderProps {
  onBack?: () => void
  embedded?: boolean
}

export default function PdfReader({ onBack, embedded = false }: PdfReaderProps) {
  const { t } = useTranslation()
  const tabs = usePdfReaderStore((state) => state.tabs)
  const activeDocumentId = usePdfReaderStore((state) => state.activeDocumentId)
  const annotationMap = usePdfReaderStore((state) => state.annotations)
  const tool = usePdfReaderStore((state) => state.tool)
  const color = usePdfReaderStore((state) => state.color)
  const fontSize = usePdfReaderStore((state) => state.fontSize)
  const strokeWidth = usePdfReaderStore((state) => state.strokeWidth)
  const sidebarOpen = usePdfReaderStore((state) => state.sidebarOpen)
  const selectedAnnotationIds = usePdfReaderStore((state) => state.selectedAnnotationIds)
  const lastDeletion = usePdfReaderStore((state) => state.lastDeletion)
  const activeDocument = tabs.find((tab) => tab.id === activeDocumentId) ?? null
  const annotations = activeDocumentId ? annotationMap[activeDocumentId] ?? [] : []
  const selectedAnnotations = annotations.filter((annotation) =>
    selectedAnnotationIds.includes(annotation.id)
  )
  const selectedTextAnnotations = selectedAnnotations.filter(
    (annotation) => annotation.kind === 'text'
  )
  const selectedInkAnnotations = selectedAnnotations.filter(
    (annotation) => annotation.kind === 'ink'
  )
  const displayedFontSize = selectedTextAnnotations[0]?.fontSize ?? fontSize
  const displayedStrokeWidth = selectedInkAnnotations[0]?.strokeWidth ?? strokeWidth
  const displayedColor = selectedAnnotations[0]?.color ?? color
  const showAnnotationStyleControls = selectedAnnotations.length > 0 || (
    tool !== null && tool !== 'select' && tool !== 'eraser'
  )
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [scale, setScale] = useState(1.15)
  const [rotation, setRotation] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchPages, setSearchPages] = useState<number[]>([])
  const [searchIndex, setSearchIndex] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [compactLayout, setCompactLayout] = useState(false)
  const readerRootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = readerRootRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth
      setCompactLayout(width < 760)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!compactLayout || !usePdfReaderStore.getState().sidebarOpen) return
    usePdfReaderStore.getState().toggleSidebar()
  }, [activeDocumentId, compactLayout])

  useEffect(() => {
    if (
      !compactLayout ||
      tool === null ||
      tool === 'select' ||
      !usePdfReaderStore.getState().sidebarOpen
    ) return
    usePdfReaderStore.getState().toggleSidebar()
  }, [compactLayout, tool])

  useEffect(() => {
    if (!activeDocument) {
      setPdf(null)
      return
    }
    let cancelled = false
    let document: PDFDocumentProxy | null = null
    setLoadingError(null)
    setPdf(null)
    setCurrentPage(1)
    setPageInput('1')
    setSearchPages([])
    void Promise.all([
      loadPdfRuntime(),
      api.documents.readPdf(activeDocument.id)
    ]).then(([runtime, data]) => {
      const task = runtime.getDocument({ data })
      return task.promise
    }).then((nextDocument) => {
      document = nextDocument
      if (!cancelled) setPdf(nextDocument)
    }).catch(() => {
      if (!cancelled) setLoadingError(t('pdfReader.loadFailed'))
    })
    return () => {
      cancelled = true
      void document?.cleanup()
    }
  }, [activeDocument?.id, activeDocument?.updatedAt, t])

  const navigateToPage = useCallback((page: number, annotationId?: string) => {
    const safePage = Math.max(1, Math.min(pdf?.numPages ?? 1, page))
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-page-number="${safePage}"]`
    )
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setCurrentPage(safePage)
    setPageInput(String(safePage))
    if (annotationId) {
      usePdfReaderStore.getState().setTool('select')
      usePdfReaderStore.getState().selectAnnotation(annotationId)
    }
  }, [pdf?.numPages])

  const handleVisiblePage = useCallback((page: number) => {
    setCurrentPage((current) => {
      if (Math.abs(page - current) > 1 && page !== 1) return current
      setPageInput(String(page))
      return page
    })
  }, [])

  const addAnnotation = useCallback((draft: PdfAnnotationDraft) => {
    if (!activeDocumentId) return null
    const annotation = usePdfReaderStore.getState().addAnnotation(activeDocumentId, draft)
    if (
      compactLayout &&
      draft.kind !== 'note' &&
      usePdfReaderStore.getState().sidebarOpen
    ) {
      usePdfReaderStore.getState().toggleSidebar()
    }
    return annotation
  }, [activeDocumentId, compactLayout])

  const runSearch = useCallback(async () => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!pdf || !query) {
      setSearchPages([])
      return
    }
    setSearching(true)
    const pages: number[] = []
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        const text = content.items
          .map((item) => 'str' in item ? item.str : '')
          .join(' ')
          .toLocaleLowerCase()
        if (text.includes(query)) pages.push(pageNumber)
      }
      setSearchPages(pages)
      setSearchIndex(0)
      if (pages[0]) navigateToPage(pages[0])
    } finally {
      setSearching(false)
    }
  }, [navigateToPage, pdf, searchQuery])

  const cycleSearch = (direction: number) => {
    if (searchPages.length === 0) return
    const index = (searchIndex + direction + searchPages.length) % searchPages.length
    setSearchIndex(index)
    navigateToPage(searchPages[index])
  }

  const fitWidth = async () => {
    if (!pdf || !scrollRef.current) return
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1, rotation })
    const available = Math.max(320, scrollRef.current.clientWidth - 64)
    setScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, available / viewport.width)))
  }

  const changeFontSize = (delta: number) => {
    if (!activeDocumentId) return
    const current = selectedTextAnnotations[0]?.fontSize ?? fontSize
    const next = Math.max(8, Math.min(72, current + delta))
    usePdfReaderStore.getState().setFontSize(next)
    selectedTextAnnotations.forEach((annotation) => {
      usePdfReaderStore.getState().updateAnnotation(
        activeDocumentId,
        annotation.id,
        { fontSize: next }
      )
    })
  }

  const changeStrokeWidth = (delta: number) => {
    if (!activeDocumentId) return
    const current = selectedInkAnnotations[0]?.strokeWidth ?? strokeWidth
    const next = Math.max(1, Math.min(12, current + delta))
    usePdfReaderStore.getState().setStrokeWidth(next)
    selectedInkAnnotations.forEach((annotation) => {
      usePdfReaderStore.getState().updateAnnotation(
        activeDocumentId,
        annotation.id,
        { strokeWidth: next }
      )
    })
  }

  const changeColor = (nextColor: string) => {
    usePdfReaderStore.getState().setColor(nextColor)
    if (!activeDocumentId) return
    selectedAnnotations.forEach((annotation) => {
      usePdfReaderStore.getState().updateAnnotation(
        activeDocumentId,
        annotation.id,
        { color: nextColor }
      )
    })
  }

  const removeSelectedAnnotations = () => {
    if (!activeDocumentId || selectedAnnotationIds.length === 0) return
    usePdfReaderStore.getState().removeAnnotations(
      activeDocumentId,
      selectedAnnotationIds
    )
  }

  useEffect(() => {
    if (!lastDeletion) return
    const timeout = window.setTimeout(() => {
      usePdfReaderStore.getState().clearLastDeletion()
    }, 6000)
    return () => window.clearTimeout(timeout)
  }, [lastDeletion])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === 'z' &&
        usePdfReaderStore.getState().lastDeletion
      ) {
        event.preventDefault()
        usePdfReaderStore.getState().undoLastDeletion()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (
        (event.key === 'Backspace' || event.key === 'Delete') &&
        usePdfReaderStore.getState().selectedAnnotationIds.length > 0
      ) {
        event.preventDefault()
        const state = usePdfReaderStore.getState()
        if (state.activeDocumentId) {
          state.removeAnnotations(state.activeDocumentId, state.selectedAnnotationIds)
        }
        return
      }
      if (event.key === 'Escape') {
        usePdfReaderStore.getState().setTool(null)
        return
      }
      const shortcuts: Partial<Record<string, PdfTool | null>> = {
        v: null,
        a: 'select',
        h: 'highlight',
        u: 'underline',
        s: 'strikeout',
        n: 'note',
        t: 'text',
        p: 'ink',
        e: 'eraser'
      }
      const nextTool = shortcuts[event.key.toLocaleLowerCase()]
      if (nextTool === undefined) return
      event.preventDefault()
      usePdfReaderStore.getState().setTool(nextTool)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  if (!activeDocument) return null

  const handleCloseTab = (documentId: string) => {
    const closesLastTab = tabs.length === 1
    usePdfReaderStore.getState().close(documentId)
    if (closesLastTab) onBack?.()
  }

  const pageControls = (
    <>
      <ReaderButton
        label={t('pdfReader.previousPage')}
        disabled={currentPage <= 1}
        onClick={() => navigateToPage(currentPage - 1)}
      >
        <CaretLeft className="h-4 w-4" />
      </ReaderButton>
      <form
        className="flex items-center gap-1 text-label text-muted"
        onSubmit={(event) => {
          event.preventDefault()
          navigateToPage(Number(pageInput) || 1)
        }}
      >
        <input
          value={pageInput}
          inputMode="numeric"
          aria-label={t('pdfReader.pageNumber')}
          className="h-7 w-10 rounded-md border border-border bg-panel px-1 text-center text-xs text-foreground"
          onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ''))}
          onBlur={() => setPageInput(String(currentPage))}
        />
        <span className="whitespace-nowrap">/ {pdf?.numPages ?? '—'}</span>
      </form>
      <ReaderButton
        label={t('pdfReader.nextPage')}
        disabled={!pdf || currentPage >= pdf.numPages}
        onClick={() => navigateToPage(currentPage + 1)}
      >
        <CaretRight className="h-4 w-4" />
      </ReaderButton>
      <span className="mx-1 h-5 w-px shrink-0 bg-border" />
      <ReaderButton
        label={t('pdfReader.zoomOut')}
        disabled={scale <= MIN_SCALE}
        onClick={() => setScale((value) => Math.max(MIN_SCALE, value - 0.15))}
      >
        <Minus className="h-4 w-4" />
      </ReaderButton>
      <span className="min-w-11 text-center text-label text-muted">
        {Math.round(scale * 100)}%
      </span>
      <ReaderButton
        label={t('pdfReader.zoomIn')}
        disabled={scale >= MAX_SCALE}
        onClick={() => setScale((value) => Math.min(MAX_SCALE, value + 0.15))}
      >
        <Plus className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton
        label={t('pdfReader.rotate')}
        onClick={() => setRotation((value) => (value + 90) % 360)}
      >
        <ArrowClockwise className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton
        label={t('pdfReader.fitWidth')}
        disabled={!pdf}
        onClick={() => void fitWidth()}
      >
        <ArrowsOutSimple className="h-4 w-4" />
      </ReaderButton>
    </>
  )

  const annotationControls = (
    <>
      <div
        className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-panel p-0.5"
        aria-label={t('pdfReader.annotationTools')}
      >
        <ReaderButton
          label={t('pdfReader.tools.read')}
          shortcut="V"
          active={tool === null}
          onClick={() => usePdfReaderStore.getState().setTool(null)}
        >
          <CursorText className="h-4 w-4" />
        </ReaderButton>
        {(Object.keys(TOOL_ICONS) as PdfTool[]).map((item) => {
          const Icon = TOOL_ICONS[item]
          return (
            <ReaderButton
              key={item}
              label={t(`pdfReader.tools.${item}`)}
              shortcut={TOOL_SHORTCUTS[item]}
              active={tool === item}
              onClick={() => usePdfReaderStore.getState().setTool(item)}
            >
              <Icon className="h-4 w-4" />
            </ReaderButton>
          )
        })}
      </div>
      {compactLayout && (
        <span
          data-active-pdf-tool
          className="shrink-0 rounded-md bg-active px-2 py-1 text-label font-medium text-accent"
        >
          {t(tool === null ? 'pdfReader.tools.read' : `pdfReader.tools.${tool}`)}
        </span>
      )}
      {(tool === 'text' || selectedTextAnnotations.length > 0) && (
        <div className="ml-1 flex shrink-0 items-center gap-0.5 rounded-md bg-panel px-0.5">
          <ReaderButton
            label={t('pdfReader.decreaseFontSize')}
            disabled={displayedFontSize <= 8}
            onClick={() => changeFontSize(-2)}
          >
            <Minus className="h-3 w-3" />
          </ReaderButton>
          <span
            className="min-w-9 text-center text-label text-muted"
            aria-label={t('pdfReader.fontSize')}
          >
            {displayedFontSize}px
          </span>
          <ReaderButton
            label={t('pdfReader.increaseFontSize')}
            disabled={displayedFontSize >= 72}
            onClick={() => changeFontSize(2)}
          >
            <Plus className="h-3 w-3" />
          </ReaderButton>
        </div>
      )}
      {(tool === 'ink' || selectedInkAnnotations.length > 0) && (
        <div className="ml-1 flex shrink-0 items-center gap-0.5 rounded-md bg-panel px-0.5">
          <ReaderButton
            label={t('pdfReader.decreaseStrokeWidth')}
            disabled={displayedStrokeWidth <= 1}
            onClick={() => changeStrokeWidth(-1)}
          >
            <Minus className="h-3 w-3" />
          </ReaderButton>
          <span
            className="min-w-8 text-center text-label text-muted"
            aria-label={t('pdfReader.strokeWidth')}
          >
            {displayedStrokeWidth}px
          </span>
          <ReaderButton
            label={t('pdfReader.increaseStrokeWidth')}
            disabled={displayedStrokeWidth >= 12}
            onClick={() => changeStrokeWidth(1)}
          >
            <Plus className="h-3 w-3" />
          </ReaderButton>
        </div>
      )}
      {selectedAnnotationIds.length > 0 && (
        <div className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-active pl-2 pr-0.5">
          <span className="text-label font-medium text-accent">
            {t('pdfReader.selectedCount', { count: selectedAnnotationIds.length })}
          </span>
          <ReaderButton
            label={t('pdfReader.deleteSelected', {
              count: selectedAnnotationIds.length
            })}
            onClick={removeSelectedAnnotations}
          >
            <Trash className="h-4 w-4 text-error" />
          </ReaderButton>
        </div>
      )}
      {showAnnotationStyleControls && (
        <div
          className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-panel px-1.5 py-1"
          aria-label={t('pdfReader.colors')}
        >
          {COLORS.map((item) => (
            <button
              key={item}
              type="button"
              aria-label={t('pdfReader.annotationColor')}
              className={`h-4 w-4 rounded-full border-2 transition-transform hover:scale-110 ${
                displayedColor === item
                  ? 'border-foreground ring-1 ring-background'
                  : 'border-transparent'
              }`}
              style={{ background: item }}
              onClick={() => changeColor(item)}
            />
          ))}
        </div>
      )}
    </>
  )

  const searchControls = (
    <form
      className={`flex items-center gap-1 ${
        compactLayout ? 'w-full' : 'min-w-40 flex-1'
      }`}
      onSubmit={(event) => {
        event.preventDefault()
        void runSearch()
      }}
    >
      <div className={`relative flex-1 ${compactLayout ? '' : 'min-w-28 max-w-52'}`}>
        <MagnifyingGlass className="pointer-events-none absolute left-2 top-1.5 h-4 w-4 text-muted" />
        <input
          value={searchQuery}
          autoFocus={compactLayout && searchOpen}
          placeholder={t('pdfReader.search')}
          className="h-7 w-full rounded-md border border-border bg-panel pl-7 pr-2 text-xs text-foreground outline-none focus:border-accent"
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !compactLayout) return
            setSearchOpen(false)
            event.currentTarget.blur()
          }}
        />
      </div>
      <span className="min-w-10 text-center text-label text-muted">
        {searching
          ? '…'
          : searchPages.length > 0
            ? `${searchIndex + 1}/${searchPages.length}`
            : ''}
      </span>
      <ReaderButton
        label={t('pdfReader.previousResult')}
        disabled={searchPages.length === 0}
        onClick={() => cycleSearch(-1)}
      >
        <CaretLeft className="h-3.5 w-3.5" />
      </ReaderButton>
      <ReaderButton
        label={t('pdfReader.nextResult')}
        disabled={searchPages.length === 0}
        onClick={() => cycleSearch(1)}
      >
        <CaretRight className="h-3.5 w-3.5" />
      </ReaderButton>
    </form>
  )

  const utilityControls = (
    <>
      <ReaderButton
        label={t('pdfReader.openInSystem')}
        onClick={() => void openDocumentPdf(activeDocument.id, { forceSystem: true })}
      >
        <ArrowSquareOut className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton
        label={t('pdfReader.toggleAnnotations')}
        active={sidebarOpen}
        onClick={() => usePdfReaderStore.getState().toggleSidebar()}
      >
        <ListBullets className="h-4 w-4" />
      </ReaderButton>
    </>
  )

  return (
    <div
      ref={readerRootRef}
      className="relative z-40 flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
    >
      {!embedded && <div className="flex h-9 shrink-0 items-end border-b border-border bg-panel px-2">
        <ReaderButton
          label={t('pdfReader.closeReader')}
          onClick={() => {
            if (onBack) onBack()
            else usePdfReaderStore.getState().closeAll()
          }}
        >
          <ArrowLeft className="h-4 w-4" />
        </ReaderButton>
        <div className="ml-2 flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`group flex h-8 min-w-36 max-w-64 items-center gap-2 rounded-t-lg border border-b-0 px-3 text-left text-xs ${
                tab.id === activeDocumentId
                  ? 'border-border bg-background text-foreground'
                  : 'border-transparent bg-transparent text-muted hover:bg-hover'
              }`}
              onClick={() => usePdfReaderStore.getState().activate(tab.id)}
            >
              <span className="min-w-0 flex-1 truncate">{tab.title || tab.fileName}</span>
              <span
                role="button"
                tabIndex={0}
                className="rounded p-0.5 opacity-50 hover:bg-hover group-hover:opacity-100"
                aria-label={t('pdfReader.closeTab')}
                onClick={(event) => {
                  event.stopPropagation()
                  handleCloseTab(tab.id)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.stopPropagation()
                    handleCloseTab(tab.id)
                  }
                }}
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
      </div>}
      <div
        data-pdf-reader-toolbar
        data-compact={compactLayout || undefined}
        className="shrink-0 border-b border-border bg-background"
      >
        {compactLayout ? (
          <>
            <div className="pdf-reader-toolbar-scroll flex h-10 items-center gap-1 overflow-x-auto px-2 py-1">
              {pageControls}
              <span className="mx-1 h-5 w-px shrink-0 bg-border" />
              <ReaderButton
                label={t('pdfReader.search')}
                active={searchOpen}
                onClick={() => setSearchOpen((open) => !open)}
              >
                <MagnifyingGlass className="h-4 w-4" />
              </ReaderButton>
              {utilityControls}
            </div>
            <div className="pdf-reader-toolbar-scroll flex min-h-10 items-center gap-1 overflow-x-auto border-t border-border/70 px-2 py-1">
              {annotationControls}
            </div>
            {searchOpen && (
              <div className="flex h-10 items-center border-t border-border/70 px-2 py-1">
                {searchControls}
              </div>
            )}
          </>
        ) : (
          <div className="flex min-h-11 flex-wrap items-center gap-1 px-2 py-1">
            {pageControls}
            <span className="mx-1 h-5 w-px shrink-0 bg-border" />
            {annotationControls}
            <span className="mx-1 h-5 w-px shrink-0 bg-border" />
            {searchControls}
            {utilityControls}
          </div>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-panel-2"
        >
          {loadingError ? (
            <div className="flex h-full items-center justify-center text-sm text-error">
              {loadingError}
            </div>
          ) : !pdf ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {t('pdfReader.loading')}
            </div>
          ) : (
            <div className="flex min-w-max flex-col items-center gap-5 p-6">
              {Array.from({ length: pdf.numPages }, (_, index) => (
                <PdfPage
                  key={`${activeDocument.id}-${index + 1}`}
                  pdf={pdf}
                  pageNumber={index + 1}
                  scale={scale}
                  rotation={rotation}
                  documentId={activeDocument.id}
                  annotations={annotations.filter((annotation) => annotation.page === index + 1)}
                  tool={tool}
                  color={color}
                  fontSize={fontSize}
                  strokeWidth={strokeWidth}
                  onAddAnnotation={addAnnotation}
                  onPageVisible={handleVisiblePage}
                />
              ))}
            </div>
          )}
        </div>
        {sidebarOpen && (
          <AnnotationSidebar
            annotations={annotations}
            documentId={activeDocument.id}
            overlay={compactLayout}
            onClose={() => usePdfReaderStore.getState().toggleSidebar()}
            onNavigate={navigateToPage}
          />
        )}
      </div>
      {lastDeletion?.documentId === activeDocument.id && (
        <div
          role="status"
          className="absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-foreground px-3 py-2 text-xs text-background shadow-xl"
        >
          <span>
            {t('pdfReader.deletedAnnotations', {
              count: lastDeletion.annotations.length
            })}
          </span>
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-1 font-medium text-accent hover:bg-background/10"
            onClick={() => usePdfReaderStore.getState().undoLastDeletion()}
          >
            <ArrowCounterClockwise className="h-3.5 w-3.5" />
            {t('pdfReader.undo')}
          </button>
        </div>
      )}
    </div>
  )
}
