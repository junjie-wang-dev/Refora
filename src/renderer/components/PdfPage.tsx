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
import type { AnnotationLayer } from 'pdfjs-dist/types/src/display/annotation_layer'
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
  pdfDeltaFromRotation,
  pdfPointForRotation,
  pdfPointFromRotation,
  pdfRectForRotation,
  selectionRectFromPoints,
  translatedAnnotationGeometry
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
import type { PdfSearchMatch } from '../hooks/usePdfSearch'

interface PdfRuntime {
  TextLayer: typeof import('pdfjs-dist').TextLayer
  AnnotationLayer: typeof import('pdfjs-dist').AnnotationLayer
}

let runtimePromise: Promise<PdfRuntime> | null = null

function loadPdfRuntime(): Promise<PdfRuntime> {
  if (!runtimePromise) {
    runtimePromise = import('pdfjs-dist').then((pdfjs) => ({
      TextLayer: pdfjs.TextLayer,
      AnnotationLayer: pdfjs.AnnotationLayer
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

function setTextHighlights(
  task: TextLayer,
  matches: Array<{ match: PdfSearchMatch; selected: boolean }>
): void {
  if (!Array.isArray(task.textDivs) || !Array.isArray(task.textContentItemsStr)) return
  const ranges = new Map<number, Array<{ start: number; end: number; selected: boolean }>>()
  matches.forEach(({ match, selected }) => {
    match.fragments.forEach((fragment) => {
      const itemRanges = ranges.get(fragment.itemIndex) ?? []
      itemRanges.push({ start: fragment.start, end: fragment.end, selected })
      ranges.set(fragment.itemIndex, itemRanges)
    })
  })
  task.textDivs.forEach((textDiv, itemIndex) => {
    const text = task.textContentItemsStr[itemIndex] ?? ''
    textDiv.replaceChildren()
    const itemRanges = (ranges.get(itemIndex) ?? []).sort((left, right) =>
      left.start - right.start || left.end - right.end
    )
    let offset = 0
    itemRanges.forEach((range) => {
      if (range.start > offset) textDiv.append(text.slice(offset, range.start))
      const highlight = document.createElement('span')
      highlight.className = `highlight appended${range.selected ? ' selected' : ''}`
      highlight.append(text.slice(Math.max(offset, range.start), range.end))
      textDiv.append(highlight)
      offset = Math.max(offset, range.end)
    })
    if (offset < text.length) textDiv.append(text.slice(offset))
  })
}

function cancelScheduledFrame(frameRef: { current: number | null }): void {
  if (frameRef.current === null) return
  window.cancelAnimationFrame(frameRef.current)
  frameRef.current = null
}

function estimatedTextAnnotationSize(
  text: string,
  annotationFontSize: number,
  point: PdfPoint,
  pageWidth: number,
  pageHeight: number
): { width: number; height: number } {
  const lineHeight = annotationFontSize * 1.35
  const lineWidths = (text || 'Text').split('\n').map((line) =>
    Array.from(line || ' ').reduce((width, character) =>
      width + annotationFontSize * (character.charCodeAt(0) > 255 ? 0.95 : 0.58),
    0)
  )
  const availableWidth = Math.max(32, pageWidth * (1 - point.x) - 6)
  const widthPixels = Math.min(
    availableWidth,
    Math.max(48, Math.min(320, Math.max(...lineWidths) + 6))
  )
  const rows = lineWidths.reduce(
    (total, width) => total + Math.max(1, Math.ceil(width / widthPixels)),
    0
  )
  return {
    width: widthPixels / pageWidth,
    height: Math.max(lineHeight + 2, rows * lineHeight + 2) / pageHeight
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
  pixelRatio,
  onRenderError
}: {
  page: PDFPageProxy
  scrollRootRef: RefObject<HTMLDivElement | null>
  tile: PdfCanvasTile
  viewport: PdfViewport
  pixelRatio: number
  onRenderError: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([null, null])
  const renderTaskRef = useRef<RenderTask | null>(null)
  const frontCanvasRef = useRef(0)
  const [visible, setVisible] = useState(false)
  const [frontCanvas, setFrontCanvas] = useState(0)

  useEffect(() => {
    const element = containerRef.current
    const root = scrollRootRef.current
    if (!element || !root) return
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries[0]?.isIntersecting ?? false)
    }, pdfVisibilityObserverOptions(root))
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRootRef])

  useEffect(() => {
    const canvases = canvasRefs.current
    if (!canvases[0] || !canvases[1]) return
    if (!visible) {
      renderTaskRef.current?.cancel()
      canvases.forEach((canvas) => {
        if (!canvas) return
        canvas.width = 1
        canvas.height = 1
      })
      return
    }
    const nextFront = frontCanvasRef.current === 0 ? 1 : 0
    const canvas = canvases[nextFront]
    if (!canvas) return
    canvas.width = tile.pixelWidth
    canvas.height = tile.pixelHeight
    renderTaskRef.current?.cancel()
    let renderTask: RenderTask
    try {
      renderTask = page.render({
        canvas,
        viewport,
        transform: pdfCanvasTileTransform(tile, pixelRatio),
        background: '#ffffff'
      })
    } catch {
      onRenderError()
      return
    }
    renderTaskRef.current = renderTask
    void renderTask.promise.then(() => {
      if (renderTaskRef.current !== renderTask) return
      const previousFront = frontCanvasRef.current
      frontCanvasRef.current = nextFront
      setFrontCanvas(nextFront)
      window.requestAnimationFrame(() => {
        if (frontCanvasRef.current !== nextFront) return
        const previousCanvas = canvasRefs.current[previousFront]
        if (!previousCanvas) return
        previousCanvas.width = 1
        previousCanvas.height = 1
      })
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'RenderingCancelledException') return
      onRenderError()
    })
    return () => renderTask.cancel()
  }, [onRenderError, page, pixelRatio, tile, viewport, visible])

  return (
    <div
      ref={containerRef}
      data-pdf-canvas-tile
      className="absolute bg-white"
      style={{
        left: tile.cssX,
        top: tile.cssY,
        width: tile.cssWidth,
        height: tile.cssHeight
      }}
    >
      {[0, 1].map((index) => (
        <canvas
          key={index}
          ref={(element) => {
            canvasRefs.current[index] = element
          }}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full bg-white"
          style={{ visibility: frontCanvas === index ? 'visible' : 'hidden' }}
        />
      ))}
    </div>
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
  searchMatches,
  onAddAnnotation,
  onPageVisible,
  onNavigateToPage
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
  searchMatches: Array<{ match: PdfSearchMatch; selected: boolean }>
  onAddAnnotation: (draft: PdfAnnotationDraft) => PdfAnnotation | null
  onPageVisible: (visibility: PdfPageVisibility) => void
  onNavigateToPage: (page: number) => void
}) {
  const { t } = useTranslation()
  const pageElementRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const textLayerTaskRef = useRef<TextLayer | null>(null)
  const annotationLayerRef = useRef<HTMLDivElement>(null)
  const annotationLayerTaskRef = useRef<AnnotationLayer | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [pageLoadError, setPageLoadError] = useState(false)
  const [pageLoadAttempt, setPageLoadAttempt] = useState(0)
  const [inkPoints, setInkPoints] = useState<PdfPoint[] | null>(null)
  const [selectionRect, setSelectionRect] = useState<PdfRect | null>(null)
  const [editingTextAnnotationId, setEditingTextAnnotationId] = useState<string | null>(null)
  const [textLayerVersion, setTextLayerVersion] = useState(0)
  const inkPointsRef = useRef<PdfPoint[] | null>(null)
  const inkFrameRef = useRef<number | null>(null)
  const selectionStartRef = useRef<PdfPoint | null>(null)
  const selectionFrameRef = useRef<number | null>(null)
  const pendingSelectionRectRef = useRef<PdfRect | null>(null)
  const textSelectionStartRef = useRef<PdfTextPosition | null>(null)
  const textPointerRef = useRef<PdfTextPointer | null>(null)
  const lastTextClickRef = useRef<PdfTextClick | null>(null)
  const annotationDragRef = useRef<{
    pointerId: number
    start: PdfPoint
    annotations: PdfAnnotation[]
    moved: boolean
  } | null>(null)
  const suppressAnnotationClickRef = useRef(false)
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
  const baseSize = useMemo(() => {
    const baseViewport = page?.getViewport({ scale: 1, rotation: 0 })
    return baseViewport
      ? { width: baseViewport.width, height: baseViewport.height }
      : { width: 612, height: 792 }
  }, [page])
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
  const textAnnotationRect = useCallback((annotation: PdfAnnotation): PdfRect => {
    const point = annotation.point ?? { x: 0, y: 0 }
    const annotationSize = annotation.size ?? estimatedTextAnnotationSize(
      annotation.text,
      annotation.fontSize ?? 14,
      point,
      baseSize.width,
      baseSize.height
    )
    return { ...point, ...annotationSize }
  }, [baseSize.height, baseSize.width])
  const handleRenderError = useCallback(() => setPageLoadError(true), [])

  useEffect(() => {
    let cancelled = false
    setPageLoadError(false)
    setPage(null)
    const load = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const nextPage = await pdf.getPage(pageNumber)
          if (!cancelled) setPage(nextPage)
          return
        } catch {
          if (cancelled) return
          if (attempt < 2) {
            await new Promise((resolve) => window.setTimeout(resolve, 80 * (attempt + 1)))
          }
        }
      }
      if (!cancelled) setPageLoadError(true)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [pageLoadAttempt, pageNumber, pdf])

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
    let disposed = false
    const stagingContainer = document.createElement('div')
    stagingContainer.className = 'textLayer'
    void Promise.all([
      page.getTextContent(),
      loadPdfRuntime()
    ]).then(([textContent, runtime]) => {
      if (disposed) return
      textLayerTaskRef.current = new runtime.TextLayer({
        textContentSource: textContent,
        container: stagingContainer,
        viewport
      })
      return textLayerTaskRef.current.render()
    }).then(() => {
      if (disposed || !textLayerTaskRef.current) return
      textContainer.style.cssText = stagingContainer.style.cssText
      const mainRotation = stagingContainer.getAttribute('data-main-rotation')
      if (mainRotation) textContainer.setAttribute('data-main-rotation', mainRotation)
      else textContainer.removeAttribute('data-main-rotation')
      textContainer.replaceChildren(...stagingContainer.childNodes)
      setTextLayerVersion((version) => version + 1)
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'RenderingCancelledException') return
    })
    return () => {
      disposed = true
      textLayerTaskRef.current?.cancel()
    }
  }, [page, viewport])

  useEffect(() => {
    if (!textLayerTaskRef.current || textLayerVersion === 0) return
    setTextHighlights(textLayerTaskRef.current, searchMatches)
    textLayerRef.current
      ?.querySelector<HTMLElement>('.highlight.selected')
      ?.scrollIntoView?.({ block: 'center', inline: 'nearest' })
  }, [searchMatches, textLayerVersion])

  const goToDestination = useCallback(async (destination: string | unknown[]) => {
    const explicitDestination = typeof destination === 'string'
      ? await pdf.getDestination(destination)
      : destination
    if (!Array.isArray(explicitDestination)) return
    const reference = explicitDestination[0]
    let destinationPage: number | null = null
    if (Number.isInteger(reference)) destinationPage = Number(reference) + 1
    else if (reference && typeof reference === 'object') {
      const pageReference = reference as Parameters<PDFDocumentProxy['getPageIndex']>[0]
      destinationPage = pdf.cachedPageNumber(pageReference)
      if (!destinationPage) destinationPage = await pdf.getPageIndex(pageReference) + 1
    }
    if (destinationPage) onNavigateToPage(destinationPage)
  }, [onNavigateToPage, pdf])

  useEffect(() => {
    if (!page || !viewport || !annotationLayerRef.current) return
    const container = annotationLayerRef.current
    const stagingContainer = document.createElement('div')
    stagingContainer.className = 'annotationLayer'
    let disposed = false
    const linkService = {
      addLinkAttributes: (link: HTMLAnchorElement, url: string) => {
        link.href = url
        link.title = url
        link.target = '_blank'
        link.rel = 'noopener noreferrer nofollow'
      },
      getDestinationHash: () => '#',
      getAnchorUrl: (anchor: string) => anchor || '#',
      goToDestination: (destination: string | unknown[]) => goToDestination(destination),
      executeNamedAction: (action: string) => {
        if (action === 'NextPage') onNavigateToPage(pageNumber + 1)
        else if (action === 'PrevPage') onNavigateToPage(pageNumber - 1)
        else if (action === 'FirstPage') onNavigateToPage(1)
        else if (action === 'LastPage') onNavigateToPage(pdf.numPages)
      },
      executeSetOCGState: () => undefined,
      getAttachmentContent: (id: string) => pdf.getAttachmentContent(id),
      eventBus: null
    }
    void Promise.all([page.getAnnotations({ intent: 'display' }), loadPdfRuntime()])
      .then(async ([nativeAnnotations, runtime]) => {
        if (disposed) return
        const layer = new runtime.AnnotationLayer({
          div: stagingContainer,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          page,
          viewport: viewport.clone({ dontFlip: true }),
          structTreeLayer: null,
          commentManager: null,
          linkService,
          annotationStorage: pdf.annotationStorage
        } as ConstructorParameters<typeof runtime.AnnotationLayer>[0])
        annotationLayerTaskRef.current = layer
        await layer.render({
          annotations: nativeAnnotations,
          viewport: viewport.clone({ dontFlip: true }),
          div: stagingContainer,
          page,
          linkService,
          renderForms: false,
          enableScripting: false
        } as unknown as Parameters<AnnotationLayer['render']>[0])
        if (disposed) return
        container.style.cssText = stagingContainer.style.cssText
        const mainRotation = stagingContainer.getAttribute('data-main-rotation')
        if (mainRotation) container.setAttribute('data-main-rotation', mainRotation)
        else container.removeAttribute('data-main-rotation')
        container.replaceChildren(...stagingContainer.childNodes)
      }).catch(() => undefined)
    return () => {
      disposed = true
      annotationLayerTaskRef.current?.destroy()
    }
  }, [goToDestination, onNavigateToPage, page, pageNumber, pdf, viewport])

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

  const flushInkPreview = () => {
    inkFrameRef.current = null
    const points = inkPointsRef.current
    setInkPoints(points ? [...points] : null)
  }

  const flushSelectionPreview = () => {
    selectionFrameRef.current = null
    const rect = pendingSelectionRectRef.current
    pendingSelectionRectRef.current = null
    if (!rect) return
    setSelectionRect(rect)
  }

  const startAnnotationDrag = (
    event: ReactPointerEvent<Element>,
    annotation: PdfAnnotation
  ) => {
    if (tool !== null || event.button !== 0 || !pageElementRef.current) return
    event.preventDefault()
    event.stopPropagation()
    window.getSelection()?.removeAllRanges()
    const ids = selectedAnnotationIds.includes(annotation.id)
      ? selectedAnnotationIds
      : [annotation.id]
    const draggedAnnotations = annotations.filter((item) => ids.includes(item.id))
    if (!selectedAnnotationIds.includes(annotation.id)) selectAnnotation(annotation.id)
    pageElementRef.current.setPointerCapture(event.pointerId)
    annotationDragRef.current = {
      pointerId: event.pointerId,
      start: normalizedPoint(event as ReactPointerEvent<HTMLDivElement>, pageElementRef.current),
      annotations: draggedAnnotations,
      moved: false
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = pageElementRef.current
    if (!element || event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('.annotationLayer')) return
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
        target.closest(
          '.textLayer span, .textLayer br, .annotationLayer, button, textarea, [data-annotation-kind]'
        )
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
        point: pdfPointFromRotation(normalizedPoint(event, element), rotation)
      })
      return
    }
    if (tool === 'text') {
      const point = pdfPointFromRotation(normalizedPoint(event, element), rotation)
      const annotation = onAddAnnotation({
        kind: 'text',
        page: pageNumber,
        color,
        text: '',
        comment: '',
        point,
        size: { width: 0.16, height: 0.04 },
        fontSize
      })
      setEditingTextAnnotationId(annotation?.id ?? null)
      return
    }
    if (tool === 'ink') {
      event.currentTarget.setPointerCapture(event.pointerId)
      inkPointsRef.current = [pdfPointFromRotation(
        normalizedPoint(event, element),
        rotation
      )]
      if (inkFrameRef.current === null) {
        inkFrameRef.current = window.requestAnimationFrame(flushInkPreview)
      }
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = pageElementRef.current
    const annotationDrag = annotationDragRef.current
    if (element && annotationDrag?.pointerId === event.pointerId) {
      const point = normalizedPoint(event, element)
      const displayDelta = {
        x: point.x - annotationDrag.start.x,
        y: point.y - annotationDrag.start.y
      }
      if (
        Math.hypot(
          displayDelta.x * element.clientWidth,
          displayDelta.y * element.clientHeight
        ) > 3
      ) annotationDrag.moved = true
      const delta = pdfDeltaFromRotation(displayDelta, rotation)
      annotationDrag.annotations.forEach((annotation) => {
        updateAnnotation(
          documentId,
          annotation.id,
          translatedAnnotationGeometry(annotation, delta)
        )
      })
      return
    }
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
      pendingSelectionRectRef.current = selectionRectFromPoints(
        selectionStart,
        normalizedPoint(event, element)
      )
      if (selectionFrameRef.current === null) {
        selectionFrameRef.current = window.requestAnimationFrame(flushSelectionPreview)
      }
      return
    }
    const points = inkPointsRef.current
    if (!element || !points || tool !== 'ink') return
    points.push(pdfPointFromRotation(normalizedPoint(event, element), rotation))
    if (inkFrameRef.current === null) {
      inkFrameRef.current = window.requestAnimationFrame(flushInkPreview)
    }
  }

  const finishInk = () => {
    cancelScheduledFrame(inkFrameRef)
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
    cancelScheduledFrame(inkFrameRef)
    inkPointsRef.current = null
    setInkPoints(null)
  }

  const finishSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    cancelScheduledFrame(selectionFrameRef)
    pendingSelectionRectRef.current = null
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
    selectAnnotations(annotationIdsInSelection(annotations, selection, rotation))
    setSelectionRect(null)
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const annotationDrag = annotationDragRef.current
    if (annotationDrag?.pointerId === event.pointerId) {
      annotationDragRef.current = null
      if (annotationDrag.moved) {
        suppressAnnotationClickRef.current = true
        window.setTimeout(() => {
          suppressAnnotationClickRef.current = false
        }, 0)
      }
    } else if (textSelectionStartRef.current) {
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
    annotationDragRef.current = null
    textPointerRef.current = null
    lastTextClickRef.current = null
    textSelectionStartRef.current = null
    selectionStartRef.current = null
    cancelScheduledFrame(selectionFrameRef)
    pendingSelectionRectRef.current = null
    setSelectionRect(null)
    cancelInk()
  }

  useEffect(() => {
    textPointerRef.current = null
    lastTextClickRef.current = null
    textSelectionStartRef.current = null
    if (tool !== 'ink') {
      cancelScheduledFrame(inkFrameRef)
      inkPointsRef.current = null
      setInkPoints(null)
    }
    if (tool !== null) {
      cancelScheduledFrame(selectionFrameRef)
      pendingSelectionRectRef.current = null
      selectionStartRef.current = null
      setSelectionRect(null)
    }
  }, [tool])

  useEffect(() => () => {
    cancelScheduledFrame(inkFrameRef)
    cancelScheduledFrame(selectionFrameRef)
  }, [])

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

  const handleAnnotationClick = (annotation: PdfAnnotation) => {
    if (suppressAnnotationClickRef.current) return
    if (tool === 'eraser') removeAnnotation(documentId, annotation.id)
    else if (tool === null) selectAnnotation(annotation.id)
  }

  return (
    <div
      ref={pageElementRef}
      data-page-number={pageNumber}
      data-page-rotation={rotation}
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
          onRenderError={handleRenderError}
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
        ref={annotationLayerRef}
        className={`annotationLayer absolute inset-0 ${tool === null ? '' : 'disabled'}`}
        style={{
          width: size.width,
          height: size.height,
          zIndex: 15
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
                points={annotation.points.map((point) => {
                  const displayPoint = pdfPointForRotation(point, rotation)
                  return `${displayPoint.x},${displayPoint.y}`
                }).join(' ')}
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
                onPointerDown={(event) => startAnnotationDrag(event, annotation)}
                onClick={() => handleAnnotationClick(annotation)}
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
            points={inkPoints.map((point) => {
              const displayPoint = pdfPointForRotation(point, rotation)
              return `${displayPoint.x},${displayPoint.y}`
            }).join(' ')}
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
        (annotation.rects ?? []).map((rect, index) => {
          const displayRect = pdfRectForRotation(rect, rotation)
          return (
            <button
              key={`${annotation.id}-${index}`}
              type="button"
              tabIndex={index === 0 ? 0 : -1}
              className={`absolute z-20 border-0 p-0 ${
                tool === 'eraser' || tool === null
                  ? 'pointer-events-auto cursor-move'
                  : 'pointer-events-none'
              }`}
              style={{
                left: `${displayRect.x * 100}%`,
                top: `${displayRect.y * 100}%`,
                width: `${displayRect.width * 100}%`,
                height: `${displayRect.height * 100}%`,
                background: annotation.kind === 'highlight'
                  ? annotation.color
                  : annotation.kind === 'strikeout'
                    ? `linear-gradient(to bottom, transparent calc(50% - 1px), ${annotation.color} calc(50% - 1px), ${annotation.color} calc(50% + 1px), transparent calc(50% + 1px))`
                    : 'transparent',
                opacity: annotation.kind === 'highlight' ? 0.36 : 1,
                borderBottom: annotation.kind === 'underline'
                  ? `2px solid ${annotation.color}`
                  : undefined,
                boxShadow: selectedAnnotationIds.includes(annotation.id)
                  ? '0 0 0 2px var(--color-accent)'
                  : undefined
              }}
              aria-label={index === 0 ? annotationLabel(annotation, t) : undefined}
              aria-hidden={index === 0 ? undefined : true}
              onPointerDown={(event) => startAnnotationDrag(event, annotation)}
              onClick={() => handleAnnotationClick(annotation)}
            />
          )
        })
      )}
      {annotations.filter((annotation) => annotation.kind === 'note' && annotation.point).map(
        (annotation) => {
          const point = pdfPointForRotation(annotation.point ?? { x: 0, y: 0 }, rotation)
          return (
            <button
            key={annotation.id}
            type="button"
            className={`absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-black/15 text-black shadow-sm ${
              tool === 'eraser' || tool === null
                ? 'pointer-events-auto cursor-move'
                : 'pointer-events-none'
            } ${
              selectedAnnotationIds.includes(annotation.id) ? 'ring-2 ring-accent' : ''
            }`}
            style={{
              left: `${point.x * 100}%`,
              top: `${point.y * 100}%`,
              background: annotation.color
            }}
            aria-label={t('pdfReader.tools.note')}
            onPointerDown={(event) => startAnnotationDrag(event, annotation)}
            onClick={() => handleAnnotationClick(annotation)}
          >
            <NoteBlank className="h-3.5 w-3.5" weight="fill" />
          </button>
          )
        }
      )}
      {annotations.filter((annotation) => annotation.kind === 'text' && annotation.point).map(
        (annotation) => {
          const canonicalRect = textAnnotationRect(annotation)
          const displayRect = pdfRectForRotation(canonicalRect, rotation)
          return (
            <textarea
              key={annotation.id}
              data-text-annotation-id={annotation.id}
              autoFocus={
                editingTextAnnotationId === annotation.id &&
                annotation.text.length === 0
              }
              value={annotation.text}
              placeholder={t('pdfReader.textPlaceholder')}
              className={`pdf-text-annotation absolute z-20 resize-none overflow-hidden border-0 bg-transparent p-0 text-black shadow-none outline-none ${
                tool === 'text'
                  ? 'pointer-events-auto'
                  : tool === null || tool === 'eraser'
                    ? 'pointer-events-auto cursor-move select-none'
                    : 'pointer-events-none'
              } ${
                selectedAnnotationIds.includes(annotation.id)
                  ? 'outline outline-1 outline-offset-2 outline-accent'
                  : ''
              }`}
              style={{
                left: `${displayRect.x * 100}%`,
                top: `${displayRect.y * 100}%`,
                width: `${displayRect.width * 100}%`,
                height: `${displayRect.height * 100}%`,
                color: annotation.color,
                fontSize: `${(annotation.fontSize ?? 14) * scale}px`,
                lineHeight: 1.35,
                '--pdf-text-annotation-color': annotation.color
              } as CSSProperties}
              aria-label={t('pdfReader.tools.text')}
              readOnly={tool !== 'text'}
              onPointerDown={(event) => {
                if (tool === null) {
                  startAnnotationDrag(event, annotation)
                  return
                }
                if (tool !== 'text') {
                  event.preventDefault()
                  window.getSelection()?.removeAllRanges()
                }
                event.stopPropagation()
              }}
              onClick={() => handleAnnotationClick(annotation)}
              onChange={(event) => {
                const nextText = event.target.value
                const point = annotation.point ?? { x: 0, y: 0 }
                updateAnnotation(documentId, annotation.id, {
                  text: nextText,
                  size: estimatedTextAnnotationSize(
                    nextText,
                    annotation.fontSize ?? 14,
                    point,
                    baseSize.width,
                    baseSize.height
                  )
                })
              }}
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
          (annotation.kind === 'text'
            ? [textAnnotationRect(annotation)]
            : annotationSelectionRects(annotation)
          ).map((rect, index) => {
            const displayRect = pdfRectForRotation(rect, rotation)
            return (
              <div
              key={`selection-${annotation.id}-${index}`}
              data-selected-annotation={annotation.id}
              aria-hidden="true"
              className="pointer-events-none absolute z-30 border-2 border-accent bg-accent/10 shadow-[0_0_0_1px_rgba(255,255,255,0.95),0_0_0_3px_color-mix(in_srgb,var(--color-accent)_38%,transparent)]"
              style={{
                left: `calc(${displayRect.x * 100}% - 3px)`,
                top: `calc(${displayRect.y * 100}% - 3px)`,
                width: `calc(${displayRect.width * 100}% + 6px)`,
                height: `calc(${displayRect.height * 100}% + 6px)`,
                minWidth: 10,
                minHeight: 10
              }}
            >
              <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full border border-white bg-accent shadow-sm" />
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full border border-white bg-accent shadow-sm" />
              <span className="absolute -bottom-1 -left-1 h-2 w-2 rounded-full border border-white bg-accent shadow-sm" />
              <span className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full border border-white bg-accent shadow-sm" />
            </div>
            )
          })
        )}
      <div className="pointer-events-none absolute bottom-2 right-3 rounded bg-black/45 px-1.5 py-0.5 text-[10px] text-white">
        {pageNumber}
      </div>
    </div>
  )
}
