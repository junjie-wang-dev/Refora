import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  ArrowsOutSimple,
  CaretLeft,
  CaretRight,
  CheckCircle,
  Cursor,
  CursorText,
  Eraser,
  Highlighter,
  ListBullets,
  MagnifyingGlass,
  Minus,
  NoteBlank,
  PencilSimple,
  Plus,
  SidebarSimple,
  Textbox,
  TextStrikethrough,
  TextUnderline,
  Trash,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import { flushSync } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy
} from 'pdfjs-dist/types/src/display/api'
import { MAX_PDF_RANGE_BYTES } from '../../shared/pdf-range'
import {
  usePdfReaderStore,
  type PdfAnnotationDraft,
  type PdfTool
} from '../store/pdfReaderStore'
import { api } from '../ipc'
import { openDocumentPdf } from '../utils/openPdf'
import PdfAnnotationSidebar from './PdfAnnotationSidebar'
import PdfPage, { type PdfPageVisibility } from './PdfPage'
import { usePdfSearch, type PdfSearchMatch } from '../hooks/usePdfSearch'
import PdfNavigationSidebar from './PdfNavigationSidebar'
import { DEFAULT_PDF_VIEW, usePdfViewStore, type PdfReadingPosition, type PdfReadingView } from '../store/pdfViewStore'
import { capturePdfPosition, resolvePdfDestination } from '../utils/pdfNavigation'
import { pdfPointForRotation, pdfPointFromRotation, pdfRectForRotation } from '../utils/pdfAnnotationSelection'
import 'pdfjs-dist/web/pdf_viewer.css'

const COLORS = ['#f2c94c', '#6fcf97', '#56ccf2', '#bb6bd9', '#eb5757']
const MIN_SCALE = 0.25
const MAX_SCALE = 5
const PDF_RANGE_CHUNK_SIZE = 256 * 1024
const PDF_PAGE_WIDTH = 612
const PDF_PAGE_HEIGHT = 792
const PDF_PAGE_GAP = 20
const PDF_PAGE_PADDING = 24
const PDF_PAGE_OVERSCAN = 2
const PDF_ZOOM_GESTURE_SETTLE_MS = 400
const PDF_NAVIGATION_SETTLE_MS = 250
const PDF_SEARCH_DEBOUNCE_MS = 200
const EMPTY_SEARCH_MATCHES: Array<{ match: PdfSearchMatch; selected: boolean }> = []

function zoomPercent(value: number): string {
  return String(Number((value * 100).toFixed(1)))
}

interface PdfRuntime {
  getDocument: typeof import('pdfjs-dist').getDocument
  PDFDataRangeTransport: typeof import('pdfjs-dist').PDFDataRangeTransport
}

interface PdfZoomAnchor {
  page: number
  x: number
  y: number
  offsetX: number
  offsetY: number
  clientX: number
  clientY: number
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
        PDFDataRangeTransport: pdfjs.PDFDataRangeTransport
      }
    })
  }
  return runtimePromise
}

async function readPdfRangeWithRetry(
  documentId: string,
  begin: number,
  end: number
): Promise<Awaited<ReturnType<typeof api.documents.readPdfRange>>> {
  const readChunk = async (chunkBegin: number, chunkEnd: number) => {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await api.documents.readPdfRange(documentId, chunkBegin, chunkEnd)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  if (end - begin <= MAX_PDF_RANGE_BYTES) return readChunk(begin, end)

  const chunks: Uint8Array[] = []
  let fileSize: number | null = null
  let totalLength = 0
  for (let chunkBegin = begin; chunkBegin < end; chunkBegin += MAX_PDF_RANGE_BYTES) {
    const chunkEnd = Math.min(end, chunkBegin + MAX_PDF_RANGE_BYTES)
    const chunk = await readChunk(chunkBegin, chunkEnd)
    const stableFileSize: number = fileSize ?? chunk.fileSize
    const expectedLength = Math.min(chunkEnd, stableFileSize) - chunkBegin
    if (
      chunk.begin !== chunkBegin ||
      chunk.fileSize !== stableFileSize ||
      expectedLength <= 0 ||
      chunk.data.length !== expectedLength
    ) {
      throw new Error('Invalid PDF byte range response')
    }
    fileSize = stableFileSize
    chunks.push(chunk.data)
    totalLength += chunk.data.length
    if (chunkEnd >= stableFileSize) break
  }

  if (fileSize === null) throw new Error('Empty PDF byte range response')
  const data = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return { begin, fileSize, data }
}

const TOOL_ICONS = {
  select: Cursor,
  highlight: Highlighter,
  underline: TextUnderline,
  strikeout: TextStrikethrough,
  note: NoteBlank,
  text: Textbox,
  ink: PencilSimple,
  eraser: Eraser
} satisfies Record<PdfTool, typeof CursorText>

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
  active?: boolean
}

export default function PdfReader({ onBack, embedded = false, active = true }: PdfReaderProps) {
  const { t } = useTranslation()
  const tabs = usePdfReaderStore((state) => state.tabs)
  const activeDocumentId = usePdfReaderStore((state) => state.activeDocumentId)
  const annotationMap = usePdfReaderStore((state) => state.annotations)
  const annotationLoadStatus = usePdfReaderStore((state) => state.loadStatus)
  const tool = usePdfReaderStore((state) => state.tool)
  const color = usePdfReaderStore((state) => state.color)
  const fontSize = usePdfReaderStore((state) => state.fontSize)
  const strokeWidth = usePdfReaderStore((state) => state.strokeWidth)
  const sidebarOpen = usePdfReaderStore((state) => state.sidebarOpen)
  const selectedAnnotationIds = usePdfReaderStore((state) => state.selectedAnnotationIds)
  const annotationHistory = usePdfReaderStore((state) => activeDocumentId ? state.annotationHistory[activeDocumentId] : undefined)
  const saveStatus = usePdfReaderStore((state) => activeDocumentId ? state.saveStatus[activeDocumentId] : undefined)
  const savedDocumentView = usePdfViewStore((state) => activeDocumentId ? state.documents[activeDocumentId] : undefined)
  const viewLoadStatus = usePdfViewStore((state) => activeDocumentId ? state.loadStatus[activeDocumentId] : undefined)
  const viewSaveStatus = usePdfViewStore((state) => activeDocumentId ? state.saveStatus[activeDocumentId] : undefined)
  const activeDocument = tabs.find((tab) => tab.id === activeDocumentId) ?? null
  const annotationsLoaded = !!activeDocumentId &&
    annotationLoadStatus[activeDocumentId] === 'loaded'
  const effectiveTool = annotationsLoaded ? tool : null
  const annotations = activeDocumentId ? annotationMap[activeDocumentId] ?? [] : []
  const annotationsByPage = useMemo(() => {
    const grouped = new Map<number, typeof annotations>()
    for (const annotation of annotations) {
      const pageAnnotations = grouped.get(annotation.page)
      if (pageAnnotations) pageAnnotations.push(annotation)
      else grouped.set(annotation.page, [annotation])
    }
    return grouped
  }, [annotations])
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
    effectiveTool !== null && effectiveTool !== 'eraser' && effectiveTool !== 'select'
  )
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [scale, setScale] = useState(1.15)
  const [zoomInput, setZoomInput] = useState(() => zoomPercent(1.15))
  const [rotation, setRotation] = useState(0)
  const [zoomMode, setZoomMode] = useState<'custom' | 'width'>('custom')
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [measuredPageWidth, setMeasuredPageWidth] = useState(PDF_PAGE_WIDTH)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchNavigationRevision, setSearchNavigationRevision] = useState(0)
  const [compactLayout, setCompactLayout] = useState(false)
  const [devicePixelRatio, setDevicePixelRatio] = useState(
    () => window.devicePixelRatio || 1
  )
  const readerRootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scaleRef = useRef(scale)
  const zoomAnchorRef = useRef<PdfZoomAnchor | null>(null)
  const zoomAnchorTimerRef = useRef<number | null>(null)
  const zoomCorrectionFrameRef = useRef<number | null>(null)
  const wheelZoomFrameRef = useRef<number | null>(null)
  const wheelZoomAnchorRef = useRef<PdfZoomAnchor | null>(null)
  const pendingWheelZoomRef = useRef<{
    scale: number
    anchor: PdfZoomAnchor | null
  } | null>(null)
  const pageBaseHeightsRef = useRef(new Map<number, number>())
  const pageBaseWidthsRef = useRef(new Map<number, number>())
  const loadedDocumentRef = useRef<string | null>(null)
  const pendingLocationRef = useRef<(PdfReadingPosition & { annotationId?: string }) | null>(null)
  const initialViewRef = useRef<PdfReadingView | null>(null)
  const persistViewRef = useRef<() => void>(() => undefined)
  const navigationHistoryRef = useRef(new Map<string, { back: PdfReadingView[]; forward: PdfReadingView[] }>())
  const navigationGenerationRef = useRef(0)
  const fitGenerationRef = useRef(0)
  const navigateRef = useRef<(page: number, annotationId?: string, position?: PdfReadingPosition, recordHistory?: boolean) => void>(() => undefined)
  const pageLayoutKeyRef = useRef('')
  const navigationTargetRef = useRef<number | null>(null)
  const navigationTimerRef = useRef<number | null>(null)
  const visiblePagesRef = useRef(new Map<number, PdfPageVisibility>())
  const reconcileVisiblePageRef = useRef<() => void>(() => undefined)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchDebounceRef = useRef<number | null>(null)
  const runPdfSearchRef = useRef<() => Promise<void>>(async () => undefined)
  const rotated = Math.abs(rotation) % 180 !== 0
  const estimatedPageBaseHeight = rotated ? PDF_PAGE_WIDTH : PDF_PAGE_HEIGHT
  const estimatedPageWidth = measuredPageWidth * scale
  const estimatePageSize = useCallback((index: number) =>
    (pageBaseHeightsRef.current.get(index) ?? estimatedPageBaseHeight) * scale,
  [estimatedPageBaseHeight, scale])
  const pageKey = useCallback(
    (index: number) => `${activeDocumentId ?? 'pdf'}-${index + 1}`,
    [activeDocumentId]
  )
  const pageVirtualizer = useVirtualizer({
    count: pdf?.numPages ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimatePageSize,
    getItemKey: pageKey,
    gap: PDF_PAGE_GAP,
    paddingStart: PDF_PAGE_PADDING,
    paddingEnd: PDF_PAGE_PADDING,
    overscan: PDF_PAGE_OVERSCAN,
    initialRect: { width: 0, height: 800 }
  })
  const virtualPages = pageVirtualizer.getVirtualItems()

  const handlePageSize = useCallback((pageNumber: number, baseHeight: number, baseWidth: number) => {
    pageBaseHeightsRef.current.set(pageNumber - 1, baseHeight)
    pageBaseWidthsRef.current.set(pageNumber - 1, baseWidth)
    setMeasuredPageWidth(Math.max(...pageBaseWidthsRef.current.values()))
    pageVirtualizer.resizeItem(pageNumber - 1, baseHeight * scaleRef.current)
  }, [pageVirtualizer])

  const captureZoomAnchor = useCallback((x?: number, y?: number): PdfZoomAnchor | null => {
    const root = scrollRef.current
    const rootBounds = root?.getBoundingClientRect()
    if (!root || !rootBounds) return null
    const clientX = x ?? rootBounds.left + rootBounds.width / 2
    const clientY = y ?? rootBounds.top + rootBounds.height / 2
    const pointedPage = document.elementFromPoint?.(clientX, clientY)
      ?.closest<HTMLElement>('[data-page-number]')
    const mountedPages = Array.from(
      root.querySelectorAll<HTMLElement>('[data-page-number]')
    )
    const currentPageElement = root.querySelector<HTMLElement>(
      `[data-page-number="${currentPage}"]`
    )
    const nearestPage = mountedPages.reduce<HTMLElement | null>((nearest, candidate) => {
      if (!nearest) return candidate
      const candidateBounds = candidate.getBoundingClientRect()
      const nearestBounds = nearest.getBoundingClientRect()
      const candidateDistance = clientY < candidateBounds.top
        ? candidateBounds.top - clientY
        : clientY > candidateBounds.bottom
          ? clientY - candidateBounds.bottom
          : 0
      const nearestDistance = clientY < nearestBounds.top
        ? nearestBounds.top - clientY
        : clientY > nearestBounds.bottom
          ? clientY - nearestBounds.bottom
          : 0
      return candidateDistance < nearestDistance ? candidate : nearest
    }, null)
    const anchorPage = pointedPage && root.contains(pointedPage)
      ? pointedPage
      : currentPageElement ?? nearestPage
    const pageBounds = anchorPage?.getBoundingClientRect()
    if (!anchorPage || !pageBounds) return null
    const normalizedX = pageBounds.width > 0
      ? Math.max(0, Math.min(1, (clientX - pageBounds.left) / pageBounds.width))
      : 0.5
    const normalizedY = pageBounds.height > 0
      ? Math.max(0, Math.min(1, (clientY - pageBounds.top) / pageBounds.height))
      : 0.5
    const page = Number(anchorPage.dataset.pageNumber)
    if (!Number.isFinite(page)) return null
    return {
      page,
      x: normalizedX,
      y: normalizedY,
      offsetX: clientX - (pageBounds.left + pageBounds.width * normalizedX),
      offsetY: clientY - (pageBounds.top + pageBounds.height * normalizedY),
      clientX,
      clientY
    }
  }, [currentPage])

  const holdZoomAnchor = useCallback((anchor: PdfZoomAnchor | null) => {
    zoomAnchorRef.current = anchor
    if (zoomAnchorTimerRef.current !== null) {
      window.clearTimeout(zoomAnchorTimerRef.current)
    }
    zoomAnchorTimerRef.current = window.setTimeout(() => {
      zoomAnchorTimerRef.current = null
      zoomAnchorRef.current = null
      wheelZoomAnchorRef.current = null
    }, PDF_ZOOM_GESTURE_SETTLE_MS)
  }, [])

  const correctZoomAnchor = useCallback(() => {
    const root = scrollRef.current
    const anchor = zoomAnchorRef.current
    if (!root || !anchor) return
    const pageElement = root.querySelector<HTMLElement>(
      `[data-page-number="${anchor.page}"]`
    )
    const pageBounds = pageElement?.getBoundingClientRect()
    if (!pageBounds) return
    const deltaX = pageBounds.left + pageBounds.width * anchor.x +
      anchor.offsetX - anchor.clientX
    const deltaY = pageBounds.top + pageBounds.height * anchor.y +
      anchor.offsetY - anchor.clientY
    if (Math.abs(deltaX) > 0.25) root.scrollLeft += deltaX
    if (Math.abs(deltaY) > 0.25) root.scrollTop += deltaY
  }, [])

  const setScaleAnchored = useCallback((
    requestedScale: number,
    x?: number,
    y?: number,
    preservedAnchor?: PdfZoomAnchor | null,
    preserveZoomMode = false
  ) => {
    if (!preserveZoomMode) {
      fitGenerationRef.current += 1
      setZoomMode('custom')
      navigationGenerationRef.current += 1
      pendingLocationRef.current = null
      navigationTargetRef.current = null
      if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
    }
    const nextScale = Math.round(
      Math.max(preserveZoomMode && zoomMode === 'width' ? 0.01 : MIN_SCALE,
        Math.min(MAX_SCALE, requestedScale)) * 1000
    ) / 1000
    const previousScale = scaleRef.current
    if (nextScale === previousScale) return
    if (preservedAnchor === undefined) wheelZoomAnchorRef.current = null
    holdZoomAnchor(pendingLocationRef.current ? null : preservedAnchor ?? captureZoomAnchor(x, y))
    scaleRef.current = nextScale
    flushSync(() => {
      setScale(nextScale)
      setZoomInput(zoomPercent(nextScale))
    })
  }, [captureZoomAnchor, holdZoomAnchor, zoomMode])

  useLayoutEffect(() => {
    const layoutKey = `${activeDocumentId ?? ''}:${rotation}`
    if (pageLayoutKeyRef.current !== layoutKey) {
      pageLayoutKeyRef.current = layoutKey
      pageBaseHeightsRef.current.clear()
      pageBaseWidthsRef.current.clear()
      setMeasuredPageWidth(rotated ? PDF_PAGE_HEIGHT : PDF_PAGE_WIDTH)
    }
    pageVirtualizer.measure()
  }, [activeDocumentId, pageVirtualizer, rotated, rotation, scale])

  useLayoutEffect(() => {
    correctZoomAnchor()
    if (!zoomAnchorRef.current || zoomCorrectionFrameRef.current !== null) return
    zoomCorrectionFrameRef.current = window.requestAnimationFrame(() => {
      zoomCorrectionFrameRef.current = null
      correctZoomAnchor()
    })
  })

  useEffect(() => () => {
    if (zoomAnchorTimerRef.current !== null) window.clearTimeout(zoomAnchorTimerRef.current)
    if (zoomCorrectionFrameRef.current !== null) {
      window.cancelAnimationFrame(zoomCorrectionFrameRef.current)
    }
    if (wheelZoomFrameRef.current !== null) {
      window.cancelAnimationFrame(wheelZoomFrameRef.current)
    }
    if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current)
  }, [])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        navigationGenerationRef.current += 1
        pendingLocationRef.current = null
        navigationTargetRef.current = null
        return
      }
      navigationGenerationRef.current += 1
      pendingLocationRef.current = null
      navigationTargetRef.current = null
      if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.01)
      const pendingZoom = pendingWheelZoomRef.current
      const existingAnchor = pendingZoom?.anchor ?? wheelZoomAnchorRef.current
      if (!existingAnchor) {
        root.scrollTo?.({
          left: root.scrollLeft,
          top: root.scrollTop,
          behavior: 'instant' as ScrollBehavior
        })
      }
      const anchor = existingAnchor
        ? { ...existingAnchor, clientX: event.clientX, clientY: event.clientY }
        : captureZoomAnchor(event.clientX, event.clientY)
      wheelZoomAnchorRef.current = anchor
      const nextScale = (pendingZoom?.scale ?? scaleRef.current) * factor
      pendingWheelZoomRef.current = { scale: nextScale, anchor }
      holdZoomAnchor(anchor)
      if (wheelZoomFrameRef.current !== null) return
      wheelZoomFrameRef.current = window.requestAnimationFrame(() => {
        wheelZoomFrameRef.current = null
        const nextZoom = pendingWheelZoomRef.current
        pendingWheelZoomRef.current = null
        if (!nextZoom) return
        setScaleAnchored(nextZoom.scale, undefined, undefined, nextZoom.anchor)
      })
    }
    root.addEventListener('wheel', handleWheel, { passive: false })
    return () => root.removeEventListener('wheel', handleWheel)
  }, [captureZoomAnchor, holdZoomAnchor, setScaleAnchored])

  useEffect(() => {
    const updateDevicePixelRatio = () => {
      setDevicePixelRatio(window.devicePixelRatio || 1)
    }
    const resolution = window.matchMedia?.(`(resolution: ${devicePixelRatio}dppx)`)
    window.addEventListener('resize', updateDevicePixelRatio)
    resolution?.addEventListener('change', updateDevicePixelRatio)
    return () => {
      window.removeEventListener('resize', updateDevicePixelRatio)
      resolution?.removeEventListener('change', updateDevicePixelRatio)
    }
  }, [devicePixelRatio])

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
    const root = scrollRef.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      setContainerSize((previous) => root.clientWidth === previous.width && root.clientHeight === previous.height
        ? previous : { width: root.clientWidth, height: root.clientHeight })
    })
    observer.observe(root)
    let frame: number | null = null
    const save = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        persistViewRef.current()
      })
    }
    root.addEventListener('scroll', save, { passive: true })
    return () => {
      observer.disconnect()
      root.removeEventListener('scroll', save)
      if (frame !== null) window.cancelAnimationFrame(frame)
      persistViewRef.current()
    }
  }, [])

  useEffect(() => {
    if (!compactLayout || !usePdfReaderStore.getState().sidebarOpen) return
    usePdfReaderStore.getState().toggleSidebar()
  }, [activeDocumentId, compactLayout])

  useEffect(() => {
    if (
      !compactLayout ||
      effectiveTool === null ||
      !usePdfReaderStore.getState().sidebarOpen
    ) return
    usePdfReaderStore.getState().toggleSidebar()
  }, [compactLayout, effectiveTool])

  useEffect(() => {
    if (effectiveTool !== null) window.getSelection()?.removeAllRanges()
  }, [effectiveTool])

  useEffect(() => {
    if (annotationsLoaded || tool === null) return
    usePdfReaderStore.getState().setTool(null)
  }, [activeDocumentId, annotationsLoaded, tool])

  useEffect(() => {
    if (!activeDocument) {
      setPdf(null)
      return
    }
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | null = null
    loadedDocumentRef.current = null
    pendingLocationRef.current = null
    navigationGenerationRef.current += 1
    setNavigationError(null)
    setLoadingError(null)
    setPdf(null)
    setCurrentPage(1)
    setPageInput('1')
    visiblePagesRef.current.clear()
    void Promise.all([
      loadPdfRuntime(),
      readPdfRangeWithRetry(activeDocument.id, 0, PDF_RANGE_CHUNK_SIZE),
      usePdfViewStore.getState().load(activeDocument.id).catch(() => ({ view: DEFAULT_PDF_VIEW, bookmarks: [] }))
    ]).then(([runtime, initial, saved]) => {
      if (!cancelled) {
        initialViewRef.current = saved.view
        setScale(saved.view.scale)
        scaleRef.current = saved.view.scale
        setZoomInput(zoomPercent(saved.view.scale))
        setRotation(saved.view.rotation)
        setZoomMode(saved.view.zoomMode)
      }
      const requestedDocumentId = activeDocument.id
      class IpcPdfRangeTransport extends runtime.PDFDataRangeTransport {
        private aborted = false

        constructor() {
          super(initial.fileSize, initial.data, true)
        }

        requestDataRange(begin: number, end: number): void {
          if (this.aborted) return
          void readPdfRangeWithRetry(requestedDocumentId, begin, end).then((chunk) => {
            if (this.aborted) return
            const expectedLength = Math.min(end, initial.fileSize) - begin
            if (
              chunk.begin !== begin ||
              chunk.fileSize !== initial.fileSize ||
              expectedLength <= 0 ||
              chunk.data.length !== expectedLength
            ) {
              this.abort()
              if (!cancelled) setLoadingError(t('pdfReader.loadFailed'))
              void loadingTask?.destroy().catch(() => undefined)
              return
            }
            this.onDataRange(begin, chunk.data)
          }).catch(() => {
            if (this.aborted) return
            this.abort()
            if (!cancelled) setLoadingError(t('pdfReader.loadFailed'))
            void loadingTask?.destroy().catch(() => undefined)
          })
        }

        abort(): void {
          this.aborted = true
        }
      }
      const task = runtime.getDocument({
        range: new IpcPdfRangeTransport(),
        rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
        disableStream: true
      })
      loadingTask = task
      if (cancelled) void task.destroy()?.catch(() => undefined)
      return task.promise
    }).then((nextDocument) => {
      if (cancelled) return
      loadedDocumentRef.current = activeDocument.id
      setPdf(nextDocument)
    }).catch(() => {
      if (!cancelled) setLoadingError(t('pdfReader.loadFailed'))
    })
    return () => {
      cancelled = true
      void loadingTask?.destroy()?.catch(() => undefined)
    }
  }, [activeDocument?.id, activeDocument?.fileHash, activeDocument?.fileMtimeNs, loadAttempt, t])

  const captureView = useCallback((): PdfReadingView => ({
    ...(scrollRef.current ? capturePdfPosition(scrollRef.current, currentPage) : null) ?? { page: currentPage, x: 0, y: 0 },
    scale: scaleRef.current, rotation, zoomMode
  }), [currentPage, rotation, zoomMode])

  persistViewRef.current = () => {
    if (!activeDocumentId || loadedDocumentRef.current !== activeDocumentId ||
      !active || pendingLocationRef.current || initialViewRef.current) return
    usePdfViewStore.getState().updateView(activeDocumentId, captureView())
  }

  useEffect(() => usePdfReaderStore.subscribe((state, previous) => {
    if (state.activeDocumentId !== previous.activeDocumentId) persistViewRef.current()
  }), [])

  useEffect(() => {
    persistViewRef.current()
  }, [rotation, scale, zoomMode])

  const navigateToPage = useCallback((
    page: number,
    annotationId?: string,
    position?: PdfReadingPosition,
    recordHistory = true
  ) => {
    navigationGenerationRef.current += 1
    const safePage = Math.max(1, Math.min(pdf?.numPages ?? 1, page))
    if (recordHistory && activeDocumentId) {
      const history = navigationHistoryRef.current.get(activeDocumentId) ?? { back: [], forward: [] }
      history.back = [...history.back, captureView()].slice(-100)
      history.forward = []
      navigationHistoryRef.current.set(activeDocumentId, history)
      setHistoryVersion((value) => value + 1)
    }
    pendingLocationRef.current = {
      page: safePage,
      x: position?.x ?? Number.NaN,
      y: position?.y ?? 0,
      annotationId
    }
    wheelZoomAnchorRef.current = null
    zoomAnchorRef.current = null
    if (zoomAnchorTimerRef.current !== null) {
      window.clearTimeout(zoomAnchorTimerRef.current)
      zoomAnchorTimerRef.current = null
    }
    navigationTargetRef.current = safePage
    if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current)
    const root = scrollRef.current
    const offset = pageVirtualizer.getOffsetForIndex(safePage - 1, 'start')?.[0]
    if (root && offset !== undefined) {
      if (root.scrollTo) {
        root.scrollTo({
          left: root.scrollLeft,
          top: offset,
          behavior: 'auto'
        })
      } else {
        root.scrollTop = offset
      }
    } else {
      pageVirtualizer.scrollToIndex(safePage - 1, { behavior: 'auto', align: 'start' })
    }
    visiblePagesRef.current.clear()
    setCurrentPage(safePage)
    setPageInput(String(safePage))
    if (annotationId) {
      usePdfReaderStore.getState().setTool(null)
      usePdfReaderStore.getState().selectAnnotation(annotationId)
    }
  }, [activeDocumentId, captureView, pageVirtualizer, pdf?.numPages])
  navigateRef.current = navigateToPage

  useEffect(() => {
    if (!pdf || !initialViewRef.current) return
    const view = initialViewRef.current
    initialViewRef.current = null
    if (view.page !== 1 || view.x !== 0 || view.y !== 0) {
      navigateRef.current(view.page, undefined, view, false)
    }
  }, [pdf])

  useLayoutEffect(() => {
    const location = pendingLocationRef.current
    const root = scrollRef.current
    if (!root || !location || !pdf || !pageBaseHeightsRef.current.has(location.page - 1)) return
    const pageElement = root.querySelector<HTMLElement>(`[data-page-number="${location.page}"]`)
    if (!pageElement) return
    const bounds = pageElement.getBoundingClientRect()
    const rootBounds = root.getBoundingClientRect()
    let x = location.x
    let y = location.y
    if (location.annotationId) {
      const annotation = annotations.find((item) => item.id === location.annotationId)
      const canonicalRect = annotation?.rects?.[0] ?? (annotation?.point
        ? { ...annotation.point, width: annotation.size?.width ?? 0.02, height: annotation.size?.height ?? 0.02 }
        : annotation?.points?.[0] ? { ...annotation.points[0], width: 0.02, height: 0.02 } : null)
      if (canonicalRect) {
        const rect = pdfRectForRotation(canonicalRect, Number(pageElement.dataset.pageRotation) || 0)
        x = rect.x + rect.width / 2 - root.clientWidth / (2 * bounds.width)
        y = rect.y + rect.height / 2 - root.clientHeight / (2 * bounds.height)
      }
    }
    if (Number.isFinite(x)) root.scrollLeft += bounds.left - rootBounds.left + x * bounds.width
    else root.scrollLeft = Math.min(root.scrollLeft, Math.max(0, bounds.width + PDF_PAGE_PADDING * 2 - root.clientWidth))
    root.scrollTop += bounds.top - rootBounds.top + y * bounds.height
    if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current)
    navigationTimerRef.current = window.setTimeout(() => {
      navigationTimerRef.current = null
      pendingLocationRef.current = null
      navigationTargetRef.current = null
      reconcileVisiblePageRef.current()
      persistViewRef.current()
    }, PDF_NAVIGATION_SETTLE_MS)
  })

  const navigateToDestination = useCallback(async (destination: string | unknown[]) => {
    const root = scrollRef.current
    if (!pdf || !root) return
    const generation = ++navigationGenerationRef.current
    try {
      const target = await resolvePdfDestination(pdf, destination, rotation, {
        width: root.clientWidth, height: root.clientHeight
      }, captureView())
      if (generation !== navigationGenerationRef.current || !target) return
      navigateToPage(target.page, undefined, target)
      if (target.scale) setScaleAnchored(target.scale, undefined, undefined, undefined, true)
      if (target.zoomMode) setZoomMode(target.zoomMode)
      setNavigationError(null)
    } catch {
      if (generation === navigationGenerationRef.current) setNavigationError(t('pdfReader.navigationFailed'))
    }
  }, [captureView, navigateToPage, pdf, rotation, setScaleAnchored, t])

  const handleSearchMatchVisible = useCallback((page: number) => {
    pendingLocationRef.current = null
    navigationTargetRef.current = null
    if (navigationTimerRef.current !== null) window.clearTimeout(navigationTimerRef.current)
    setCurrentPage(page)
    setPageInput(String(page))
    persistViewRef.current()
  }, [])

  const navigateFromSidebar = useCallback(async (page: number, position?: { x: number; y: number }) => {
    if (!position || !pdf) {
      navigateToPage(page)
      return
    }
    const generation = ++navigationGenerationRef.current
    try {
      const pdfPage = await pdf.getPage(page)
      if (generation !== navigationGenerationRef.current) return
      const rotatedPosition = pdfPointForRotation(position, ((pdfPage.rotate ?? 0) + rotation) % 360)
      navigateToPage(page, undefined, { page, ...rotatedPosition })
    } catch {
      if (generation === navigationGenerationRef.current) setNavigationError(t('pdfReader.navigationFailed'))
    }
  }, [navigateToPage, pdf, rotation, t])

  const addBookmark = () => {
    if (!activeDocumentId) return
    const view = captureView()
    const pageElement = scrollRef.current?.querySelector<HTMLElement>(`[data-page-number="${view.page}"]`)
    if (!pageElement) return
    const point = pdfPointFromRotation(view, Number(pageElement.dataset.pageRotation) || 0)
    usePdfViewStore.getState().addBookmark(activeDocumentId, { page: view.page, ...point },
      t('pdfReader.navigation.page', { page: view.page }))
  }

  const travelHistory = useCallback((direction: 'back' | 'forward') => {
    if (!activeDocumentId) return
    const history = navigationHistoryRef.current.get(activeDocumentId)
    const target = history?.[direction].pop()
    if (!history || !target) return
    history[direction === 'back' ? 'forward' : 'back'].push(captureView())
    setScale(target.scale)
    scaleRef.current = target.scale
    setZoomInput(zoomPercent(target.scale))
    setRotation(target.rotation)
    setZoomMode(target.zoomMode)
    navigateToPage(target.page, undefined, target, false)
    setHistoryVersion((value) => value + 1)
  }, [activeDocumentId, captureView, navigateToPage])

  const navigateSearchPage = useCallback((page: number) => {
    navigateToPage(page)
    setSearchNavigationRevision((value) => value + 1)
  }, [navigateToPage])

  const pdfSearch = usePdfSearch({
    pdf,
    cacheKey: activeDocument
      ? `${activeDocument.id}:${activeDocument.fileHash ?? ''}:${activeDocument.fileMtimeNs ?? ''}`
      : '',
    failureMessage: t('pdfReader.searchFailed'),
    navigateToPage: navigateSearchPage
  })
  runPdfSearchRef.current = pdfSearch.run

  const runPdfSearch = useCallback(() => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current)
      searchDebounceRef.current = null
    }
    void runPdfSearchRef.current()
  }, [])

  useEffect(() => {
    if (searchDebounceRef.current !== null) {
      window.clearTimeout(searchDebounceRef.current)
      searchDebounceRef.current = null
    }
    if (!pdfSearch.query.trim()) return
    searchDebounceRef.current = window.setTimeout(() => {
      searchDebounceRef.current = null
      void runPdfSearchRef.current()
    }, PDF_SEARCH_DEBOUNCE_MS)
    return () => {
      if (searchDebounceRef.current === null) return
      window.clearTimeout(searchDebounceRef.current)
      searchDebounceRef.current = null
    }
  }, [pdfSearch.query])

  const searchMatchesByPage = useMemo(() => {
    const grouped = new Map<number, Array<{
      match: (typeof pdfSearch.matches)[number]
      selected: boolean
    }>>()
    pdfSearch.matches.forEach((match, index) => {
      const pageMatches = grouped.get(match.page) ?? []
      pageMatches.push({ match, selected: index === pdfSearch.index })
      grouped.set(match.page, pageMatches)
    })
    return grouped
  }, [pdfSearch.index, pdfSearch.matches])

  reconcileVisiblePageRef.current = () => {
    const primaryPage = [...visiblePagesRef.current.values()].sort((left, right) =>
      right.visibleArea - left.visibleArea ||
      left.viewportDistance - right.viewportDistance ||
      left.page - right.page
    )[0]?.page
    if (primaryPage === undefined) return
    setCurrentPage(primaryPage)
    setPageInput(String(primaryPage))
  }

  const handleVisiblePage = useCallback((visibility: PdfPageVisibility) => {
    if (visibility.isVisible && visibility.visibleArea > 0) {
      visiblePagesRef.current.set(visibility.page, visibility)
    } else {
      visiblePagesRef.current.delete(visibility.page)
    }
    if (navigationTargetRef.current !== null) return
    reconcileVisiblePageRef.current()
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

  useEffect(() => {
    if (!pdf || zoomMode !== 'width' || containerSize.width <= 0) return
    let cancelled = false
    const generation = ++fitGenerationRef.current
    void pdf.getPage(currentPage).then((page) => {
      if (cancelled || generation !== fitGenerationRef.current) return
      const viewport = page.getViewport({ scale: 1, rotation: ((page.rotate ?? 0) + rotation) % 360 })
      const available = Math.max(1, containerSize.width - PDF_PAGE_PADDING * 2)
      setScaleAnchored(available / viewport.width, undefined, undefined, undefined, true)
    }).catch(() => {
      if (!cancelled) setNavigationError(t('pdfReader.navigationFailed'))
    })
    return () => { cancelled = true }
  }, [containerSize.width, currentPage, pdf, rotation, setScaleAnchored, t, zoomMode])

  const rotateView = () => {
    const anchor = captureZoomAnchor()
    holdZoomAnchor(anchor ? { ...anchor, ...pdfPointForRotation(anchor, 90) } : null)
    setRotation((value) => (value + 90) % 360)
  }

  const changeFontSize = (delta: number) => {
    if (!activeDocumentId || !annotationsLoaded) return
    const current = selectedTextAnnotations[0]?.fontSize ?? fontSize
    const next = Math.max(8, Math.min(72, current + delta))
    usePdfReaderStore.getState().setFontSize(next)
    usePdfReaderStore.getState().updateAnnotations(
      activeDocumentId,
      selectedTextAnnotations.map((annotation) => annotation.id),
      { fontSize: next, size: undefined }
    )
  }

  const changeStrokeWidth = (delta: number) => {
    if (!activeDocumentId || !annotationsLoaded) return
    const current = selectedInkAnnotations[0]?.strokeWidth ?? strokeWidth
    const next = Math.max(1, Math.min(12, current + delta))
    usePdfReaderStore.getState().setStrokeWidth(next)
    usePdfReaderStore.getState().updateAnnotations(
      activeDocumentId,
      selectedInkAnnotations.map((annotation) => annotation.id),
      { strokeWidth: next }
    )
  }

  const changeColor = (nextColor: string) => {
    if (!annotationsLoaded) return
    usePdfReaderStore.getState().setColor(nextColor)
    if (!activeDocumentId) return
    usePdfReaderStore.getState().updateAnnotations(
      activeDocumentId,
      selectedAnnotations.map((annotation) => annotation.id),
      { color: nextColor }
    )
  }

  const removeSelectedAnnotations = () => {
    if (
      !activeDocumentId ||
      !annotationsLoaded ||
      selectedAnnotationIds.length === 0
    ) return
    usePdfReaderStore.getState().removeAnnotations(
      activeDocumentId,
      selectedAnnotationIds
    )
  }

  useEffect(() => {
    if (!active) return
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return
      const currentState = usePdfReaderStore.getState()
      const annotationShortcutsEnabled = !!currentState.activeDocumentId &&
        currentState.loadStatus[currentState.activeDocumentId] === 'loaded'
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === 'z' &&
        annotationShortcutsEnabled
      ) {
        event.preventDefault()
        if (currentState.activeDocumentId) {
          if (event.shiftKey) currentState.redo(currentState.activeDocumentId)
          else currentState.undo(currentState.activeDocumentId)
        }
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (
        (event.key === 'Backspace' || event.key === 'Delete') &&
        annotationShortcutsEnabled &&
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
        event.preventDefault()
        window.getSelection()?.removeAllRanges()
        const state = usePdfReaderStore.getState()
        if (state.tool !== null) state.setTool(null)
        else state.selectAnnotations([])
        return
      }
      const shortcuts: Partial<Record<string, PdfTool | null>> = {
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
      if (!annotationShortcutsEnabled) return
      event.preventDefault()
      const currentTool = usePdfReaderStore.getState().tool
      usePdfReaderStore.getState().setTool(currentTool === nextTool ? null : nextTool)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active])

  useEffect(() => {
    if (!active) return
    const find = () => {
      setSearchOpen(true)
      window.requestAnimationFrame(() => searchInputRef.current?.focus())
    }
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || document.querySelector('.dialog-overlay')) return
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopImmediatePropagation()
        find()
      } else if (event.key === '[' || event.key === ']') {
        const target = event.target
        if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return
        event.preventDefault()
        event.stopImmediatePropagation()
        travelHistory(event.key === '[' ? 'back' : 'forward')
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [active, travelHistory])

  const navigationHistory = useMemo(() => activeDocumentId
    ? navigationHistoryRef.current.get(activeDocumentId) : undefined,
  [activeDocumentId, historyVersion])

  if (!activeDocument) return null

  const handleCloseTab = (documentId: string) => {
    const closesLastTab = tabs.length === 1
    usePdfReaderStore.getState().close(documentId)
    if (closesLastTab) onBack?.()
  }

  const pageControls = (
    <>
      <ReaderButton label={t('pdfReader.navigation.title')} active={navigationOpen}
        onClick={() => {
          if (compactLayout && sidebarOpen) usePdfReaderStore.getState().toggleSidebar()
          setNavigationOpen((open) => !open)
        }}>
        <SidebarSimple className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton label={t('pdfReader.navigationBack')} shortcut="⌘["
        disabled={!navigationHistory?.back.length} onClick={() => travelHistory('back')}>
        <ArrowLeft className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton label={t('pdfReader.navigationForward')} shortcut="⌘]"
        disabled={!navigationHistory?.forward.length} onClick={() => travelHistory('forward')}>
        <ArrowRight className="h-4 w-4" />
      </ReaderButton>
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
        onClick={() => setScaleAnchored(scaleRef.current - 0.1)}
      >
        <Minus className="h-4 w-4" />
      </ReaderButton>
      <form
        className="relative flex h-7 w-14 items-center"
        onSubmit={(event) => {
          event.preventDefault()
          setScaleAnchored((Number(zoomInput) || 100) / 100)
        }}
      >
        <input
          value={zoomInput}
          inputMode="decimal"
          aria-label={t('pdfReader.zoomPercentage')}
          className="h-7 w-full rounded-md border border-border bg-panel pl-1 pr-4 text-center text-xs text-foreground"
          onChange={(event) => {
            fitGenerationRef.current += 1
            setZoomMode('custom')
            setZoomInput(event.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'))
          }}
          onBlur={() => {
            setScaleAnchored((Number(zoomInput) || scaleRef.current * 100) / 100)
            setZoomInput(zoomPercent(scaleRef.current))
          }}
        />
        <span className="pointer-events-none absolute right-1 text-label text-muted">%</span>
      </form>
      <ReaderButton
        label={t('pdfReader.zoomIn')}
        disabled={scale >= MAX_SCALE}
        onClick={() => setScaleAnchored(scaleRef.current + 0.1)}
      >
        <Plus className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton
        label={t('pdfReader.rotate')}
        onClick={rotateView}
      >
        <ArrowClockwise className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton
        label={t('pdfReader.fitWidth')}
        disabled={!pdf}
        active={zoomMode === 'width'}
        onClick={() => setZoomMode('width')}
      >
        <ArrowsOutSimple className="h-4 w-4" />
      </ReaderButton>
    </>
  )

  const annotationControls = (
    <>
      <div
        data-pdf-annotation-toolbar
        className="flex shrink-0 items-center gap-0.5"
        aria-label={t('pdfReader.annotationTools')}
      >
        <ReaderButton label={t('pdfReader.tools.read')} active={effectiveTool === null}
          shortcut="Esc" onClick={() => usePdfReaderStore.getState().setTool(null)}>
          <CursorText className="h-4 w-4" />
        </ReaderButton>
        {(Object.keys(TOOL_ICONS) as PdfTool[]).map((item) => {
          const Icon = TOOL_ICONS[item]
          return (
            <ReaderButton
              key={item}
              label={t(`pdfReader.tools.${item}`)}
              shortcut={TOOL_SHORTCUTS[item]}
              active={effectiveTool === item}
              disabled={!annotationsLoaded}
              onClick={() => usePdfReaderStore.getState().setTool(
                effectiveTool === item ? null : item
              )}
            >
              <Icon className="h-4 w-4" />
            </ReaderButton>
          )
        })}
      </div>
      <ReaderButton label={t('pdfReader.undo')} shortcut="⌘Z"
        disabled={!annotationHistory?.past.length || !annotationsLoaded}
        onClick={() => usePdfReaderStore.getState().undo(activeDocument.id)}>
        <ArrowCounterClockwise className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton label={t('pdfReader.redo')} shortcut="⇧⌘Z"
        disabled={!annotationHistory?.future.length || !annotationsLoaded}
        onClick={() => usePdfReaderStore.getState().redo(activeDocument.id)}>
        <ArrowClockwise className="h-4 w-4" />
      </ReaderButton>
      {compactLayout && (
        <span
          data-active-pdf-tool
          className="shrink-0 rounded-md bg-active px-2 py-1 text-label font-medium text-accent"
        >
          {t(effectiveTool === null ? 'pdfReader.tools.read' : `pdfReader.tools.${effectiveTool}`)}
        </span>
      )}
      {(effectiveTool === 'text' || selectedTextAnnotations.length > 0) && (
        <div className="ml-1 flex shrink-0 items-center gap-0.5 rounded-md bg-panel px-0.5">
          <ReaderButton
            label={t('pdfReader.decreaseFontSize')}
            disabled={!annotationsLoaded || displayedFontSize <= 8}
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
            disabled={!annotationsLoaded || displayedFontSize >= 72}
            onClick={() => changeFontSize(2)}
          >
            <Plus className="h-3 w-3" />
          </ReaderButton>
        </div>
      )}
      {(effectiveTool === 'ink' || selectedInkAnnotations.length > 0) && (
        <div className="ml-1 flex shrink-0 items-center gap-0.5 rounded-md bg-panel px-0.5">
          <ReaderButton
            label={t('pdfReader.decreaseStrokeWidth')}
            disabled={!annotationsLoaded || displayedStrokeWidth <= 1}
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
            disabled={!annotationsLoaded || displayedStrokeWidth >= 12}
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
            disabled={!annotationsLoaded}
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
              disabled={!annotationsLoaded}
              onPointerDown={(event) => event.preventDefault()}
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
        if (pdfSearch.matches.length > 0) {
          pdfSearch.cycle(1)
          return
        }
        if (pdfSearch.searching) return
        runPdfSearch()
      }}
    >
      <div className={`relative flex-1 ${compactLayout ? '' : 'min-w-28 max-w-52'}`}>
        <MagnifyingGlass className="pointer-events-none absolute left-2 top-1.5 h-4 w-4 text-muted" />
        <input
          ref={searchInputRef}
          value={pdfSearch.query}
          autoFocus={compactLayout && searchOpen}
          placeholder={t('pdfReader.search')}
          className="h-7 w-full rounded-md border border-border bg-panel pl-7 pr-7 text-xs text-foreground outline-none focus:border-accent"
          aria-invalid={pdfSearch.error ? true : undefined}
          onChange={(event) => pdfSearch.updateQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.shiftKey && pdfSearch.matches.length > 0) {
              event.preventDefault()
              pdfSearch.cycle(-1)
              return
            }
            if (event.key !== 'Escape') return
            if (searchDebounceRef.current !== null) window.clearTimeout(searchDebounceRef.current)
            searchDebounceRef.current = null
            pdfSearch.cancel()
            if (compactLayout) setSearchOpen(false)
            event.currentTarget.blur()
          }}
        />
        {pdfSearch.query.length > 0 && (
          <button
            type="button"
            aria-label={t('common.clearSearch')}
            className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              pdfSearch.updateQuery('')
              searchInputRef.current?.focus()
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <span
        data-pdf-search-status
        className="min-w-10 text-center text-label text-muted"
        role="status"
        aria-live="polite"
      >
        {pdfSearch.matches.length > 0 ? `${pdfSearch.index + 1}/${pdfSearch.matches.length}` : ''}
        {pdfSearch.searching ? ' …' : pdfSearch.noResults ? t('pdfReader.noResults') : ''}
        {pdfSearch.error && <span className="ml-1 text-error">{pdfSearch.error}</span>}
      </span>
      <ReaderButton
        label={t('pdfReader.previousResult')}
        disabled={pdfSearch.matches.length === 0}
        onClick={() => pdfSearch.cycle(-1)}
      >
        <CaretLeft className="h-3.5 w-3.5" />
      </ReaderButton>
      <ReaderButton
        label={t('pdfReader.nextResult')}
        disabled={pdfSearch.matches.length === 0}
        onClick={() => pdfSearch.cycle(1)}
      >
        <CaretRight className="h-3.5 w-3.5" />
      </ReaderButton>
    </form>
  )

  const retryReaderPersistence = () => {
    if (annotationLoadStatus[activeDocument.id] === 'error') void usePdfReaderStore.getState().retryLoad(activeDocument.id)
    if (saveStatus === 'error') usePdfReaderStore.getState().retrySave(activeDocument.id)
    if (viewLoadStatus === 'error') setLoadAttempt((attempt) => attempt + 1)
    if (viewSaveStatus === 'error') usePdfViewStore.getState().retrySave(activeDocument.id)
  }

  const utilityControls = (
    <>
      <button type="button" data-pdf-persistence-status
        aria-label={t('pdfReader.persistenceStatus')}
        disabled={annotationLoadStatus[activeDocument.id] !== 'error' && saveStatus !== 'error' &&
          viewLoadStatus !== 'error' && viewSaveStatus !== 'error'}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-label text-muted disabled:cursor-default"
        onClick={retryReaderPersistence}>
        {annotationLoadStatus[activeDocument.id] === 'error' || saveStatus === 'error' || viewLoadStatus === 'error' || viewSaveStatus === 'error'
          ? <WarningCircle className="h-4 w-4 text-error" />
          : <CheckCircle className="h-4 w-4" />}
        <span aria-live="polite">
          {annotationLoadStatus[activeDocument.id] === 'error' ? t('pdfReader.retryLoadAnnotations')
            : saveStatus === 'error' ? t('pdfReader.retrySave')
              : viewLoadStatus === 'error' || viewSaveStatus === 'error' ? t('pdfReader.retryReadingState')
                : annotationLoadStatus[activeDocument.id] === 'loading' ? t('pdfReader.loadingAnnotations')
                  : t(`pdfReader.saveStatus.${saveStatus === 'saving' || viewSaveStatus === 'saving' ? 'saving' : saveStatus ?? 'idle'}`)}
        </span>
      </button>
      <ReaderButton
        label={t('pdfReader.openInSystem')}
        onClick={() => void openDocumentPdf(activeDocument.id, { forceSystem: true })}
      >
        <ArrowSquareOut className="h-4 w-4" />
      </ReaderButton>
      <ReaderButton
        label={t('pdfReader.toggleAnnotations')}
        active={sidebarOpen}
        onClick={() => {
          if (compactLayout) setNavigationOpen(false)
          usePdfReaderStore.getState().toggleSidebar()
        }}
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
        <div
          className="ml-2 flex min-w-0 flex-1 items-end gap-1 overflow-x-auto"
          role="tablist"
        >
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex h-8 min-w-36 max-w-64 items-center rounded-t-lg border border-b-0 text-left text-xs ${
                tab.id === activeDocumentId
                  ? 'border-border bg-background text-foreground'
                  : 'border-transparent bg-transparent text-muted hover:bg-hover'
              }`}
            >
              <button
                type="button"
                role="tab"
                tabIndex={tab.id === activeDocumentId ? 0 : -1}
                aria-selected={tab.id === activeDocumentId}
                className="min-w-0 flex-1 truncate py-2 pl-3 text-left"
                onClick={() => usePdfReaderStore.getState().activate(tab.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const tabButtons = Array.from(
                    event.currentTarget.closest('[role="tablist"]')
                      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
                  )
                  const index = tabButtons.indexOf(event.currentTarget)
                  const offset = event.key === 'ArrowLeft' ? -1 : 1
                  const next = tabButtons[(index + offset + tabButtons.length) % tabButtons.length]
                  next?.click()
                  next?.focus()
                }}
              >
                {tab.title || tab.fileName}
              </button>
              <button
                type="button"
                className="mr-2 rounded p-0.5 opacity-50 hover:bg-hover group-hover:opacity-100"
                aria-label={t('pdfReader.closeTab')}
                onClick={() => handleCloseTab(tab.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
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
      {(annotationLoadStatus[activeDocument.id] === 'error' || saveStatus === 'error' ||
        viewLoadStatus === 'error' || viewSaveStatus === 'error' || navigationError) && (
        <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-error/25 bg-error/10 px-3 py-2 text-xs text-error">
          <span className="flex-1">{navigationError ?? (annotationLoadStatus[activeDocument.id] === 'error'
            ? t('pdfReader.annotationLoadFailed') : saveStatus === 'error'
              ? t('pdfReader.annotationSaveFailed') : t('pdfReader.readingStateFailed'))}</span>
          {!navigationError && <button type="button" className="shrink-0 rounded border border-error/40 px-2 py-1 hover:bg-error/10"
            onClick={retryReaderPersistence}>{t('common.retry')}</button>}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {navigationOpen && pdf && (
          <PdfNavigationSidebar pdf={pdf} currentPage={currentPage} rotation={rotation}
            bookmarks={savedDocumentView?.bookmarks ?? []} overlay={compactLayout}
            onClose={() => setNavigationOpen(false)}
            onNavigate={navigateFromSidebar}
            onNavigateDestination={(destination) => void navigateToDestination(destination)}
            onAddBookmark={addBookmark}
            onRenameBookmark={(id, title) => usePdfViewStore.getState().renameBookmark(activeDocument.id, id, title)}
            onRemoveBookmark={(id) => usePdfViewStore.getState().removeBookmark(activeDocument.id, id)} />
        )}
        <div
          ref={scrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-panel-2 [overflow-anchor:none]"
        >
          {loadingError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-error" role="alert">
              {loadingError}
              <button type="button" className="rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-hover"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{t('common.retry')}</button>
            </div>
          ) : !pdf ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {t('pdfReader.loading')}
            </div>
          ) : (
            <div
              data-pdf-page-virtualizer
              className="relative min-w-full"
              style={{
                height: pageVirtualizer.getTotalSize(),
                width: estimatedPageWidth + PDF_PAGE_PADDING * 2
              }}
            >
              {virtualPages.map((virtualPage) => {
                const pageNumber = virtualPage.index + 1
                return (
                  <div
                    key={virtualPage.key}
                    ref={pageVirtualizer.measureElement}
                    data-index={virtualPage.index}
                    data-virtual-page={pageNumber}
                    className="absolute top-0 w-max"
                    style={{
                      left: Math.max(containerSize.width / 2,
                        (pageBaseWidthsRef.current.get(virtualPage.index) ?? (rotated ? PDF_PAGE_HEIGHT : PDF_PAGE_WIDTH)) * scale / 2 + PDF_PAGE_PADDING),
                      transform: `translate(-50%, ${virtualPage.start}px)`
                    }}
                  >
                    <PdfPage
                      active={active}
                      pdf={pdf}
                      pageNumber={pageNumber}
                      scale={scale}
                      maximumScale={MAX_SCALE}
                      rotation={rotation}
                      devicePixelRatio={devicePixelRatio}
                      scrollRootRef={scrollRef}
                      documentId={activeDocument.id}
                      documentTitle={activeDocument.title || activeDocument.fileName}
                      annotations={annotationsByPage.get(pageNumber) ?? []}
                      tool={effectiveTool}
                      color={displayedColor}
                      fontSize={fontSize}
                      strokeWidth={strokeWidth}
                      searchMatches={searchMatchesByPage.get(pageNumber) ?? EMPTY_SEARCH_MATCHES}
                      searchNavigationRevision={searchNavigationRevision}
                      onAddAnnotation={addAnnotation}
                      onPageSize={handlePageSize}
                      onPageVisible={handleVisiblePage}
                      onNavigateToPage={navigateToPage}
                      onNavigateToDestination={navigateToDestination}
                      onSearchMatchVisible={handleSearchMatchVisible}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {sidebarOpen && (
          <PdfAnnotationSidebar
            annotations={annotations}
            documentId={activeDocument.id}
            overlay={compactLayout}
            onClose={() => usePdfReaderStore.getState().toggleSidebar()}
            onNavigate={navigateToPage}
          />
        )}
      </div>
    </div>
  )
}
