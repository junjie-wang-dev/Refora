import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  X
} from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy
} from 'pdfjs-dist/types/src/display/api'
import {
  usePdfReaderStore,
  type PdfAnnotationDraft,
  type PdfTool
} from '../store/pdfReaderStore'
import { api } from '../ipc'
import { openDocumentPdf } from '../utils/openPdf'
import PdfAnnotationSidebar from './PdfAnnotationSidebar'
import PdfPage, { type PdfPageVisibility } from './PdfPage'
import 'pdfjs-dist/web/pdf_viewer.css'

const COLORS = ['#f2c94c', '#6fcf97', '#56ccf2', '#bb6bd9', '#eb5757']
const MIN_SCALE = 0.5
const MAX_SCALE = 3
const PDF_RANGE_CHUNK_SIZE = 64 * 1024

interface PdfRuntime {
  getDocument: typeof import('pdfjs-dist').getDocument
  PDFDataRangeTransport: typeof import('pdfjs-dist').PDFDataRangeTransport
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

const TOOL_ICONS = {
  highlight: Highlighter,
  underline: TextUnderline,
  strikeout: TextStrikethrough,
  note: NoteBlank,
  text: Textbox,
  ink: PencilSimple,
  eraser: Eraser
} satisfies Record<PdfTool, typeof CursorText>

const TOOL_SHORTCUTS: Record<PdfTool, string> = {
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
  const annotationLoadStatus = usePdfReaderStore((state) => state.loadStatus)
  const tool = usePdfReaderStore((state) => state.tool)
  const color = usePdfReaderStore((state) => state.color)
  const fontSize = usePdfReaderStore((state) => state.fontSize)
  const strokeWidth = usePdfReaderStore((state) => state.strokeWidth)
  const sidebarOpen = usePdfReaderStore((state) => state.sidebarOpen)
  const selectedAnnotationIds = usePdfReaderStore((state) => state.selectedAnnotationIds)
  const lastDeletion = usePdfReaderStore((state) => state.lastDeletion)
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
    effectiveTool !== null && effectiveTool !== 'eraser'
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
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [compactLayout, setCompactLayout] = useState(false)
  const [devicePixelRatio, setDevicePixelRatio] = useState(
    () => window.devicePixelRatio || 1
  )
  const readerRootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchGenerationRef = useRef(0)
  const visiblePagesRef = useRef(new Map<number, PdfPageVisibility>())

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
    let document: PDFDocumentProxy | null = null
    let loadingTask: PDFDocumentLoadingTask | null = null
    setLoadingError(null)
    setPdf(null)
    setCurrentPage(1)
    setPageInput('1')
    visiblePagesRef.current.clear()
    searchGenerationRef.current += 1
    setSearchPages([])
    setSearchError(null)
    void Promise.all([
      loadPdfRuntime(),
      api.documents.readPdfRange(activeDocument.id, 0, PDF_RANGE_CHUNK_SIZE)
    ]).then(([runtime, initial]) => {
      const requestedDocumentId = activeDocument.id
      class IpcPdfRangeTransport extends runtime.PDFDataRangeTransport {
        private aborted = false

        constructor() {
          super(initial.fileSize, initial.data, true)
        }

        requestDataRange(begin: number, end: number): void {
          if (this.aborted) return
          void api.documents.readPdfRange(requestedDocumentId, begin, end).then((chunk) => {
            if (this.aborted) return
            if (
              chunk.begin !== begin ||
              chunk.fileSize !== initial.fileSize ||
              chunk.data.length === 0 ||
              chunk.data.length > end - begin
            ) {
              this.abort()
              void loadingTask?.destroy().catch(() => undefined)
              return
            }
            this.onDataRange(begin, chunk.data)
          }).catch(() => {
            if (this.aborted) return
            this.abort()
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
        disableAutoFetch: true,
        disableStream: true
      })
      loadingTask = task
      if (cancelled) void task.destroy()?.catch(() => undefined)
      return task.promise
    }).then((nextDocument) => {
      if (cancelled) return
      document = nextDocument
      setPdf(nextDocument)
    }).catch(() => {
      if (!cancelled) setLoadingError(t('pdfReader.loadFailed'))
    })
    return () => {
      cancelled = true
      searchGenerationRef.current += 1
      void document?.cleanup()?.catch(() => undefined)
      void loadingTask?.destroy()?.catch(() => undefined)
    }
  }, [activeDocument?.id, activeDocument?.updatedAt, t])

  const navigateToPage = useCallback((page: number, annotationId?: string) => {
    const safePage = Math.max(1, Math.min(pdf?.numPages ?? 1, page))
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-page-number="${safePage}"]`
    )
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    visiblePagesRef.current.clear()
    setCurrentPage(safePage)
    setPageInput(String(safePage))
    if (annotationId) {
      usePdfReaderStore.getState().setTool(null)
      usePdfReaderStore.getState().selectAnnotation(annotationId)
    }
  }, [pdf?.numPages])

  const handleVisiblePage = useCallback((visibility: PdfPageVisibility) => {
    if (visibility.isVisible && visibility.visibleArea > 0) {
      visiblePagesRef.current.set(visibility.page, visibility)
    } else {
      visiblePagesRef.current.delete(visibility.page)
    }
    const primaryPage = [...visiblePagesRef.current.values()].sort((left, right) =>
      right.visibleArea - left.visibleArea ||
      left.viewportDistance - right.viewportDistance ||
      left.page - right.page
    )[0]?.page
    if (primaryPage === undefined) return
    setCurrentPage(primaryPage)
    setPageInput(String(primaryPage))
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
    const generation = ++searchGenerationRef.current
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!pdf || !query) {
      setSearchPages([])
      setSearchError(null)
      return
    }
    setSearching(true)
    setSearchError(null)
    const pages: number[] = []
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        if (searchGenerationRef.current !== generation) return
        const text = content.items
          .map((item) => 'str' in item ? item.str : '')
          .join(' ')
          .toLocaleLowerCase()
        if (text.includes(query)) pages.push(pageNumber)
      }
      if (searchGenerationRef.current !== generation) return
      setSearchPages(pages)
      setSearchIndex(0)
      if (pages[0]) navigateToPage(pages[0])
    } catch {
      if (searchGenerationRef.current !== generation) return
      setSearchPages([])
      setSearchIndex(0)
      setSearchError(t('pdfReader.searchFailed'))
    } finally {
      if (searchGenerationRef.current === generation) setSearching(false)
    }
  }, [navigateToPage, pdf, searchQuery, t])

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
    if (!activeDocumentId || !annotationsLoaded) return
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
    if (!activeDocumentId || !annotationsLoaded) return
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
    if (!annotationsLoaded) return
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
      const currentState = usePdfReaderStore.getState()
      const annotationShortcutsEnabled = !!currentState.activeDocumentId &&
        currentState.loadStatus[currentState.activeDocumentId] === 'loaded'
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === 'z' &&
        annotationShortcutsEnabled &&
        usePdfReaderStore.getState().lastDeletion
      ) {
        event.preventDefault()
        usePdfReaderStore.getState().undoLastDeletion()
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
        a: null,
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
        data-pdf-annotation-toolbar
        className="flex shrink-0 items-center gap-0.5"
        aria-label={t('pdfReader.annotationTools')}
      >
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
      {compactLayout && (
        <span
          data-active-pdf-tool
          className="shrink-0 rounded-md bg-active px-2 py-1 text-label font-medium text-accent"
        >
          {t(effectiveTool === null ? 'pdfReader.tools.select' : `pdfReader.tools.${effectiveTool}`)}
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
          aria-invalid={searchError ? true : undefined}
          onChange={(event) => {
            searchGenerationRef.current += 1
            setSearchQuery(event.target.value)
            setSearching(false)
            setSearchError(null)
          }}
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
          : searchError
            ? <span className="text-error" role="status">{searchError}</span>
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
                  devicePixelRatio={devicePixelRatio}
                  scrollRootRef={scrollRef}
                  documentId={activeDocument.id}
                  documentTitle={activeDocument.title || activeDocument.fileName}
                  annotations={annotationsByPage.get(index + 1) ?? []}
                  tool={effectiveTool}
                  color={displayedColor}
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
          <PdfAnnotationSidebar
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
