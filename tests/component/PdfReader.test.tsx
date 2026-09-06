import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showContextMenu } from '@lobehub/ui'
import type { Document as LibraryDocument } from '../../src/shared/ipc-types'
import { api } from '../../src/renderer/ipc'
import PdfReader from '../../src/renderer/components/PdfReader'
import { usePdfReaderStore, type PdfAnnotation } from '../../src/renderer/store/pdfReaderStore'
import { DEFAULT_PDF_VIEW, usePdfViewStore } from '../../src/renderer/store/pdfViewStore'
import { invalidateRendererSettingWrites } from '../../src/renderer/persistence'
import { useChatDraftStore } from '../../src/renderer/store/chatDraftStore'
import { useDocumentStore } from '../../src/renderer/store/documentStore'
import { MAX_PDF_RANGE_BYTES } from '../../src/shared/pdf-range'

const pdfMocks = vi.hoisted(() => {
  const translate = (key: string) => key
  const cancelRender = vi.fn()
  const renderPage = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel: cancelRender
  }))
  const page = {
    rotate: 0,
    view: [0, 0, 612, 792],
    getViewport: vi.fn(({ scale, rotation = 0 }: { scale: number; rotation?: number }) => {
      const viewport = {
        width: 612 * scale,
        height: 792 * scale,
        rotation,
        convertToViewportPoint: (x: number, y: number) => [x * scale, (792 - y) * scale],
        convertToPdfPoint: (x: number, y: number) => [x / scale, 792 - y / scale],
        clone: vi.fn(() => viewport)
      }
      return viewport
    }),
    getTextContent: vi.fn(async () => ({ items: [] as Array<{ str: string }> })),
    getAnnotations: vi.fn(async (): Promise<Array<{
      url?: string
      dest?: string | unknown[]
    }>> => []),
    render: renderPage
  }
  const document = {
    numPages: 1,
    getPage: vi.fn(async (_pageNumber: number) => page),
    getDestination: vi.fn(async () => null),
    getPageIndex: vi.fn(async () => 0),
    cachedPageNumber: vi.fn(() => null),
    getAttachmentContent: vi.fn(async () => null),
    annotationStorage: {},
    cleanup: vi.fn()
  }
  const destroyDocument = vi.fn(async () => undefined)
  let loadGate: Promise<typeof document> | null = null
  const getDocument = vi.fn((_options?: Record<string, unknown>) => ({
    promise: loadGate ?? Promise.resolve(document),
    destroy: destroyDocument
  }))
  return {
    cancelRender,
    document,
    page,
    renderPage,
    translate,
    destroyDocument,
    getDocument,
    gateLoad(promise: Promise<typeof document> | null) {
      loadGate = promise
    }
  }
})

const pdfVirtualizerMocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  getOffsetForIndex: vi.fn(),
  resizeItem: vi.fn(),
  startIndex: 0
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: {
    count: number
    estimateSize: (index: number) => number
    getItemKey?: (index: number) => string | number
    gap?: number
    paddingStart?: number
    paddingEnd?: number
  }) => {
    const startIndex = Math.min(pdfVirtualizerMocks.startIndex, Math.max(0, options.count - 1))
    const mountedCount = Math.min(Math.max(0, options.count - startIndex), 3)
    const size = options.estimateSize(0)
    const gap = options.gap ?? 0
    const paddingStart = options.paddingStart ?? 0
    const paddingEnd = options.paddingEnd ?? 0
    return {
      getVirtualItems: () => Array.from({ length: mountedCount }, (_, offset) => ({
        index: startIndex + offset,
        key: options.getItemKey?.(startIndex + offset) ?? startIndex + offset,
        start: paddingStart + (startIndex + offset) * (size + gap),
        size,
        end: paddingStart + (startIndex + offset) * (size + gap) + size
      })),
      getTotalSize: () => paddingStart + options.count * size +
        Math.max(0, options.count - 1) * gap + paddingEnd,
      measureElement: () => undefined,
      measure: () => undefined,
      scrollToIndex: pdfVirtualizerMocks.scrollToIndex,
      getOffsetForIndex: (index: number, align: string) => {
        pdfVirtualizerMocks.getOffsetForIndex(index, align)
        return [paddingStart + index * (size + gap), align]
      },
      resizeItem: pdfVirtualizerMocks.resizeItem
    }
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: pdfMocks.translate
  })
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class {
    constructor(
      readonly length: number,
      readonly initialData: Uint8Array | null
    ) {}
    onDataRange = vi.fn()
  },
  getDocument: pdfMocks.getDocument,
  TextLayer: class {
    textDivs: HTMLElement[]
    textContentItemsStr: string[]
    private readonly container: HTMLElement
    constructor({
      textContentSource,
      container
    }: {
      textContentSource: { items: Array<{ str?: string }> }
      container: HTMLElement
    }) {
      this.container = container
      this.textContentItemsStr = textContentSource.items.map((item) => item.str ?? '')
      this.textDivs = this.textContentItemsStr.map((text) => {
        const span = window.document.createElement('span')
        span.textContent = text
        return span
      })
    }
    render = vi.fn(async () => {
      this.container.append(...this.textDivs)
    })
    cancel = vi.fn()
  },
  AnnotationLayer: class {
    private readonly div: HTMLDivElement
    private readonly linkService: {
      addLinkAttributes: (link: HTMLAnchorElement, url: string) => void
      getDestinationHash: () => string
      goToDestination: (destination: string | unknown[]) => void
    }
    constructor({
      div,
      linkService
    }: {
      div: HTMLDivElement
      linkService: {
        addLinkAttributes: (link: HTMLAnchorElement, url: string) => void
        getDestinationHash: () => string
        goToDestination: (destination: string | unknown[]) => void
      }
    }) {
      this.div = div
      this.linkService = linkService
    }
    render = vi.fn(async ({ annotations }: { annotations: Array<{
      url?: string
      dest?: string | unknown[]
    }> }) => {
      annotations.forEach((annotation) => {
        const section = window.document.createElement('section')
        section.className = 'linkAnnotation'
        const link = window.document.createElement('a')
        if (annotation.url) this.linkService.addLinkAttributes(link, annotation.url)
        if (annotation.dest) {
          link.href = this.linkService.getDestinationHash()
          link.onclick = () => {
            this.linkService.goToDestination(annotation.dest ?? [])
            return false
          }
        }
        section.append(link)
        this.div.append(section)
      })
    })
    destroy = vi.fn()
  }
}))

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'pdf.worker.mjs'
}))

interface ObservedElement {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  target?: Element
}

let observers: ObservedElement[] = []

class IntersectionObserverMock {
  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly thresholds: readonly number[] = [0]
  private readonly observed: ObservedElement

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.root = options?.root ?? null
    this.rootMargin = options?.rootMargin ?? '0px'
    this.observed = { callback, options }
    observers.push(this.observed)
  }

  observe(target: Element) {
    this.observed.target = target
  }

  disconnect() {}
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function pageVisibilityEntry(
  pageTop: number,
  visibleTop: number,
  visibleHeight: number,
  isIntersecting = true
): IntersectionObserverEntry {
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    x: 0,
    y: top,
    toJSON: () => ({})
  }) as DOMRectReadOnly
  return {
    isIntersecting,
    intersectionRatio: isIntersecting ? visibleHeight / 800 : 0,
    intersectionRect: rect(visibleTop, isIntersecting ? visibleHeight : 0),
    boundingClientRect: rect(pageTop, 800),
    rootBounds: rect(0, 800),
    target: window.document.createElement('div'),
    time: 0
  }
}

function document(): LibraryDocument {
  return {
    id: 'paper',
    filePath: '/tmp/paper.pdf',
    originalFolderPath: '/tmp',
    fileName: 'paper.pdf',
    fileSize: 1024,
    fileHash: 'paper',
    title: 'Paper',
    authors: null,
    year: null,
    venue: null,
    volume: null,
    issue: null,
    pages: null,
    abstract: null,
    keywords: null,
    url: null,
    doi: null,
    arxivId: null,
    note: null,
    affiliations: null,
    starred: 0,
    addedAt: 1,
    lastReadAt: 2,
    updatedAt: 3,
    metadataSource: null,
    metadataStatus: 'done',
    metadataAttempts: 0,
    editedFields: [],
    remoteValues: null,
    fileMissing: 0
  }
}

describe('PdfReader rendering visibility', () => {
  beforeEach(() => {
    usePdfReaderStore.getState().resetForLibrarySwitch()
    usePdfViewStore.getState().reset()
    invalidateRendererSettingWrites()
    observers = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    pdfMocks.renderPage.mockReset().mockImplementation(() => ({
      promise: Promise.resolve(),
      cancel: pdfMocks.cancelRender
    }))
    pdfMocks.cancelRender.mockClear()
    pdfMocks.document.numPages = 1
    pdfMocks.document.getPage.mockReset().mockResolvedValue(pdfMocks.page)
    pdfMocks.page.getTextContent.mockReset().mockResolvedValue({ items: [] })
    pdfMocks.page.getAnnotations.mockReset().mockResolvedValue([])
    pdfMocks.destroyDocument.mockClear()
    pdfMocks.getDocument.mockClear()
    pdfMocks.gateLoad(null)
    pdfVirtualizerMocks.scrollToIndex.mockReset()
    pdfVirtualizerMocks.getOffsetForIndex.mockReset()
    pdfVirtualizerMocks.resizeItem.mockReset()
    pdfVirtualizerMocks.startIndex = 0
    vi.spyOn(api.documents, 'readPdfRange').mockResolvedValue({
      begin: 0,
      fileSize: 1,
      data: new Uint8Array([1])
    })
    usePdfReaderStore.setState({
      tabs: [document()],
      activeDocumentId: 'paper',
      annotations: { paper: [] },
      loadStatus: { paper: 'loaded' },
      saveStatus: { paper: 'saved' },
      tool: null,
      color: '#f2c94c',
      fontSize: 14,
      strokeWidth: 2,
      sidebarOpen: false,
      selectedAnnotationId: null,
      selectedAnnotationIds: [],
      pendingCommentFocusId: null,
      lastDeletion: null
    })
    useChatDraftStore.setState({ pending: null })
    useDocumentStore.setState({ toastMessage: null, showToast: vi.fn() })
    vi.mocked(showContextMenu).mockReset()
  })

  afterEach(() => {
    cleanup()
    usePdfReaderStore.getState().resetForLibrarySwitch()
    usePdfViewStore.getState().reset()
    invalidateRendererSettingWrites()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('preloads against the PDF scroller and retains the committed tile while offscreen', async () => {
    const view = render(<PdfReader />)

    await waitFor(() => {
      expect(observers.some((observer) =>
        (observer.target as HTMLElement | undefined)?.hasAttribute('data-pdf-canvas-tile')
      )).toBe(true)
    })
    expect(api.documents.readPdfRange).toHaveBeenCalledWith('paper', 0, 262144)
    expect(pdfMocks.getDocument).toHaveBeenCalledWith({
      range: expect.anything(),
      rangeChunkSize: 262144,
      disableStream: true
    })

    const canvasObserver = observers.find(
      (observer) => (observer.target as HTMLElement | undefined)
        ?.hasAttribute('data-pdf-canvas-tile')
    )
    const root = canvasObserver?.options?.root
    expect(root).toBeInstanceOf(HTMLDivElement)
    expect((root as HTMLDivElement).classList.contains('overflow-auto')).toBe(true)
    expect(canvasObserver?.options?.rootMargin).toBe('700px 0px')

    const canvases = Array.from(
      canvasObserver?.target?.querySelectorAll('canvas') ?? []
    ) as HTMLCanvasElement[]
    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(1))
    expect(canvases.some((canvas) => canvas.width > 1 && canvas.height > 1)).toBe(true)

    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    expect(canvases.some((canvas) => canvas.width > 1 && canvas.height > 1)).toBe(true)

    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(2))
    expect(view.container.querySelector('.pdf-reader-page')).toBeVisible()
  })

  it('retains every committed high-zoom tile across a grid threshold', async () => {
    const view = render(<PdfReader />)
    const zoom = await screen.findByRole('textbox', { name: 'pdfReader.zoomPercentage' })

    fireEvent.change(zoom, { target: { value: '500' } })
    fireEvent.submit(zoom.closest('form') as HTMLFormElement)
    const tilesAtFiveHundred = await waitFor(() => {
      const tiles = Array.from(
        view.container.querySelectorAll<HTMLElement>('[data-pdf-canvas-tile]')
      )
      expect(tiles.length).toBeGreaterThan(1)
      return tiles
    })
    const tileObservers = await waitFor(() => {
      const matchingObservers = tilesAtFiveHundred.map((tile) =>
        observers.find((candidate) => candidate.target === tile)
      )
      expect(matchingObservers.every(Boolean)).toBe(true)
      return matchingObservers
    })

    act(() => {
      tileObservers.forEach((observer) => {
        observer?.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          observer as unknown as IntersectionObserver
        )
      })
    })
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(
      tilesAtFiveHundred.length
    ))
    const committedCanvases = await waitFor(() => tilesAtFiveHundred.map((tile) => {
      const canvas = Array.from(tile.querySelectorAll('canvas')).find((candidate) =>
        candidate.style.visibility === 'visible' &&
        candidate.width > 1 && candidate.height > 1
      )
      expect(canvas).toBeDefined()
      return canvas
    }))
    pdfMocks.renderPage.mockImplementation(() => ({
      promise: new Promise<void>(() => undefined),
      cancel: pdfMocks.cancelRender
    }))

    fireEvent.change(zoom, { target: { value: '350' } })
    fireEvent.submit(zoom.closest('form') as HTMLFormElement)

    await waitFor(() => {
      const tilesAtThreeHundredFifty = Array.from(
        view.container.querySelectorAll<HTMLElement>('[data-pdf-canvas-tile]')
      )
      expect(tilesAtThreeHundredFifty).toHaveLength(tilesAtFiveHundred.length)
      tilesAtThreeHundredFifty.forEach((tile, index) => {
        expect(tile).toBe(tilesAtFiveHundred[index])
      })
    })
    committedCanvases.forEach((canvas) => {
      expect(canvas).toBeVisible()
      expect(canvas?.width).toBeGreaterThan(1)
      expect(canvas?.height).toBeGreaterThan(1)
    })
  })

  it('finishes and commits an in-flight tile after a transient visibility change', async () => {
    let finishRender!: () => void
    const cancelRender = vi.fn()
    pdfMocks.renderPage.mockImplementationOnce(() => ({
      promise: new Promise<void>((resolve) => {
        finishRender = resolve
      }),
      cancel: cancelRender
    }))
    const view = render(<PdfReader />)

    const canvasObserver = await waitFor(() => {
      const observer = observers.find(
        (candidate) => (candidate.target as HTMLElement | undefined)
          ?.hasAttribute('data-pdf-canvas-tile')
      )
      expect(observer).toBeDefined()
      return observer
    })
    const canvases = Array.from(
      canvasObserver?.target?.querySelectorAll('canvas') ?? []
    ) as HTMLCanvasElement[]

    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(1))

    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    expect(cancelRender).not.toHaveBeenCalled()

    await act(async () => {
      finishRender()
      await Promise.resolve()
    })
    await waitFor(() => expect(canvases[1].style.visibility).toBe('visible'))
    expect(canvases[1].width).toBeGreaterThan(1)
    expect(canvases[1].height).toBeGreaterThan(1)
    expect(view.container.querySelector('.pdf-reader-page')).toBeVisible()
  })

  it('retries a cancelled tile while it remains visible', async () => {
    let cancelFirstRender!: (error: Error) => void
    pdfMocks.renderPage
      .mockImplementationOnce(() => ({
        promise: new Promise<void>((_resolve, reject) => {
          cancelFirstRender = reject
        }),
        cancel: vi.fn()
      }))
      .mockImplementationOnce(() => ({
        promise: Promise.resolve(),
        cancel: vi.fn()
      }))
    render(<PdfReader />)

    const canvasObserver = await waitFor(() => {
      const observer = observers.find(
        (candidate) => (candidate.target as HTMLElement | undefined)
          ?.hasAttribute('data-pdf-canvas-tile')
      )
      expect(observer).toBeDefined()
      return observer
    })
    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(1))

    const cancellation = new Error('render cancelled')
    cancellation.name = 'RenderingCancelledException'
    await act(async () => {
      cancelFirstRender(cancellation)
      await Promise.resolve()
    })

    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(2))
  })

  it('retries a transient PDF range failure before delivering the complete chunk', async () => {
    render(<PdfReader />)
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalled())
    const options = pdfMocks.getDocument.mock.calls.at(0)?.[0]
    expect(options).toBeDefined()
    const range = options?.range as {
      requestDataRange: (begin: number, end: number) => void
      onDataRange: ReturnType<typeof vi.fn>
    }
    vi.mocked(api.documents.readPdfRange)
      .mockRejectedValueOnce(new Error('transient IPC failure'))
      .mockResolvedValueOnce({ begin: 0, fileSize: 1, data: new Uint8Array([1]) })

    range.requestDataRange(0, 1)

    await waitFor(() => expect(range.onDataRange).toHaveBeenCalledWith(
      0,
      new Uint8Array([1])
    ))
  })

  it('splits a large PDF.js range request across the bounded IPC reader', async () => {
    const fileSize = MAX_PDF_RANGE_BYTES * 2 + 17
    vi.mocked(api.documents.readPdfRange).mockImplementation(async (_id, begin, end) => {
      const data = new Uint8Array(end - begin)
      data.fill(Math.floor(begin / MAX_PDF_RANGE_BYTES) + 1)
      return { begin, fileSize, data }
    })
    render(<PdfReader />)
    await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalled())
    const options = pdfMocks.getDocument.mock.calls.at(0)?.[0]
    const range = options?.range as {
      requestDataRange: (begin: number, end: number) => void
      onDataRange: ReturnType<typeof vi.fn>
    }
    vi.mocked(api.documents.readPdfRange).mockClear()

    range.requestDataRange(0, fileSize)

    await waitFor(() => expect(range.onDataRange).toHaveBeenCalledTimes(1))
    const delivered = range.onDataRange.mock.calls[0][1] as Uint8Array
    expect(api.documents.readPdfRange).toHaveBeenNthCalledWith(
      1,
      'paper',
      0,
      MAX_PDF_RANGE_BYTES
    )
    expect(api.documents.readPdfRange).toHaveBeenNthCalledWith(
      2,
      'paper',
      MAX_PDF_RANGE_BYTES,
      MAX_PDF_RANGE_BYTES * 2
    )
    expect(api.documents.readPdfRange).toHaveBeenNthCalledWith(
      3,
      'paper',
      MAX_PDF_RANGE_BYTES * 2,
      fileSize
    )
    expect(delivered).toHaveLength(fileSize)
    expect(delivered[0]).toBe(1)
    expect(delivered[MAX_PDF_RANGE_BYTES]).toBe(2)
    expect(delivered[MAX_PDF_RANGE_BYTES * 2]).toBe(3)
  })

  it('retries transient page loading failures', async () => {
    pdfMocks.document.getPage
      .mockReset()
      .mockRejectedValueOnce(new Error('page unavailable'))
      .mockRejectedValueOnce(new Error('page unavailable'))
      .mockResolvedValue(pdfMocks.page)

    const view = render(<PdfReader />)

    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).toBeVisible())
    await waitFor(() => expect(pdfMocks.document.getPage).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('bounds mounted pages and page observers for a long document', async () => {
    pdfMocks.document.numPages = 1000
    pdfMocks.document.getPage.mockClear()
    const view = render(<PdfReader />)

    await waitFor(() => expect(view.container.querySelectorAll('.pdf-reader-page')).toHaveLength(3))
    await waitFor(() => expect(pdfMocks.document.getPage).toHaveBeenCalledTimes(3))
    expect(observers.filter(
      (observer) => (observer.target as HTMLElement | undefined)?.dataset.pageNumber
    )).toHaveLength(3)
  })

  it('jumps to an unmounted page through the virtualizer', async () => {
    pdfMocks.document.numPages = 1000
    const view = render(<PdfReader />)
    await waitFor(() => expect(screen.getByText('/ 1000')).toBeInTheDocument())
    const input = screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })
    const scroller = view.container.querySelector<HTMLElement>(
      '[data-pdf-page-virtualizer]'
    )?.parentElement
    expect(scroller).not.toBeNull()
    const scrollTo = vi.fn()
    scroller!.scrollTo = scrollTo

    fireEvent.change(input, { target: { value: '900' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(pdfVirtualizerMocks.getOffsetForIndex).toHaveBeenCalledWith(899, 'start')
    expect(pdfVirtualizerMocks.scrollToIndex).not.toHaveBeenCalled()
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }))
    expect(input).toHaveValue('900')
  })

  it('removes an unmounted page from current-page visibility tracking', async () => {
    pdfMocks.document.numPages = 4
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelectorAll('.pdf-reader-page')).toHaveLength(3))
    const pageOne = observers.find(
      (observer) => (observer.target as HTMLElement | undefined)?.dataset.pageNumber === '1'
    )!
    act(() => {
      pageOne.callback(
        [pageVisibilityEntry(0, 0, 800)],
        pageOne as unknown as IntersectionObserver
      )
    })

    pdfVirtualizerMocks.startIndex = 1
    view.rerender(<PdfReader />)
    await waitFor(() => expect(
      view.container.querySelector('[data-page-number="1"]')
    ).not.toBeInTheDocument())
    const pageFour = observers.find(
      (observer) => (observer.target as HTMLElement | undefined)?.dataset.pageNumber === '4'
    )!
    act(() => {
      pageFour.callback(
        [pageVisibilityEntry(2400, 700, 100)],
        pageFour as unknown as IntersectionObserver
      )
    })

    await waitFor(() => expect(screen.getByRole('textbox', {
      name: 'pdfReader.pageNumber'
    })).toHaveValue('4'))
  })

  it('chooses the largest page in the real viewport regardless of preload callback order', async () => {
    pdfMocks.document.numPages = 2
    render(<PdfReader />)
    await waitFor(() => {
      expect(observers.filter((observer) =>
        (observer.target as HTMLElement | undefined)?.dataset.pageNumber
      )).toHaveLength(2)
    })
    const pageObservers = (page: string) => observers.filter(
      (observer) => (observer.target as HTMLElement | undefined)?.dataset.pageNumber === page
    )
    const pageOneCurrent = pageObservers('1').find(
      (observer) => observer.options?.rootMargin === undefined
    )!
    const pageTwoCurrent = pageObservers('2').find(
      (observer) => observer.options?.rootMargin === undefined
    )!

    act(() => {
      pageOneCurrent.callback(
        [pageVisibilityEntry(0, 0, 600)],
        pageOneCurrent as unknown as IntersectionObserver
      )
      pageTwoCurrent.callback(
        [pageVisibilityEntry(620, 620, 180)],
        pageTwoCurrent as unknown as IntersectionObserver
      )
    })

    expect(screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })).toHaveValue('1')
  })

  it('reports PDF text search failures without leaving the search busy', async () => {
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())
    await waitFor(() => expect(pdfMocks.page.getTextContent).toHaveBeenCalled())
    pdfMocks.page.getTextContent.mockReset()
    pdfMocks.page.getTextContent.mockRejectedValue(new Error('text unavailable'))
    const input = screen.getByPlaceholderText('pdfReader.search')
    fireEvent.change(input, { target: { value: 'query' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    expect(await screen.findByRole('status')).toHaveTextContent('pdfReader.searchFailed')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('does not let an older search overwrite a newer result', async () => {
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())
    await waitFor(() => expect(pdfMocks.document.getPage).toHaveBeenCalled())
    Element.prototype.scrollIntoView = vi.fn()
    let resolveOlderPage: ((page: typeof pdfMocks.page) => void) | undefined
    const newerPage = {
      ...pdfMocks.page,
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'old new result' }] })
    }
    const olderPage = {
      ...pdfMocks.page,
      getTextContent: vi.fn().mockResolvedValue({ items: [] })
    }
    pdfMocks.document.getPage
      .mockReset()
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOlderPage = resolve
      }))
      .mockResolvedValueOnce(newerPage)
    const input = screen.getByPlaceholderText('pdfReader.search')
    fireEvent.change(input, { target: { value: 'old' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(pdfMocks.document.getPage).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'new' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await screen.findByText('1/1')
    await act(async () => {
      resolveOlderPage?.(olderPage)
      await Promise.resolve()
    })

    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(newerPage.getTextContent).toHaveBeenCalledTimes(1)
    expect(olderPage.getTextContent).not.toHaveBeenCalled()
  })

  it('reuses extracted page text across different searches', async () => {
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())
    await waitFor(() => expect(pdfMocks.page.getTextContent).toHaveBeenCalled())
    pdfMocks.page.getTextContent.mockReset().mockResolvedValue({
      items: [{ str: 'alpha beta' }]
    })
    const input = screen.getByPlaceholderText('pdfReader.search')

    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await screen.findByText('1/1')
    fireEvent.change(input, { target: { value: 'beta' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => expect(input).toHaveValue('beta'))

    expect(pdfMocks.page.getTextContent).toHaveBeenCalledTimes(1)
  })

  it('highlights every PDF search match and marks the active result', async () => {
    pdfMocks.page.getTextContent.mockResolvedValue({
      items: [{ str: 'alpha beta alpha' }]
    })
    const view = render(<PdfReader />)
    await waitFor(() => expect(
      view.container.querySelector('.textLayer span')
    ).toHaveTextContent('alpha beta alpha'))
    const input = screen.getByPlaceholderText('pdfReader.search')

    fireEvent.change(input, { target: { value: 'alpha' } })

    await screen.findByText('1/2')
    await waitFor(() => expect(
      view.container.querySelectorAll('.textLayer .highlight')
    ).toHaveLength(2))
    let highlights = view.container.querySelectorAll('.textLayer .highlight')
    expect(highlights[0]).toHaveClass('selected')
    expect(highlights[1]).not.toHaveClass('selected')

    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await screen.findByText('2/2')
    highlights = view.container.querySelectorAll('.textLayer .highlight')
    expect(highlights[0]).not.toHaveClass('selected')
    expect(highlights[1]).toHaveClass('selected')

    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await screen.findByText('1/2')
    highlights = view.container.querySelectorAll('.textLayer .highlight')
    expect(highlights[0]).toHaveClass('selected')
    expect(highlights[1]).not.toHaveClass('selected')

    const clear = screen.getByRole('button', { name: 'common.clearSearch' })
    fireEvent.click(clear)
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'common.clearSearch' })).not.toBeInTheDocument()
    expect(view.container.querySelectorAll('.textLayer .highlight')).toHaveLength(0)
  })

  it('lets an in-progress PDF search be cleared and stopped immediately', async () => {
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).toBeVisible())
    pdfMocks.document.getPage.mockReset().mockReturnValue(new Promise(() => undefined))
    const input = screen.getByPlaceholderText('pdfReader.search')

    fireEvent.change(input, { target: { value: 'pending' } })
    await waitFor(() => expect(
      view.container.querySelector('[data-pdf-search-status]')
    ).toHaveTextContent('…'))
    const clear = screen.getByRole('button', { name: 'common.clearSearch' })
    fireEvent.click(clear)

    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'common.clearSearch' })).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-pdf-search-status]')).toHaveTextContent('')
  })

  it('renders native PDF links and navigates internal destinations', async () => {
    pdfMocks.document.numPages = 2
    pdfMocks.page.getAnnotations.mockResolvedValue([
      { url: 'https://example.com/paper' },
      { dest: [1, { name: 'XYZ' }, 306, 396, 2] }
    ])
    const view = render(<PdfReader />)

    const links = await waitFor(() => {
      const elements = view.container.querySelectorAll<HTMLAnchorElement>(
        '[data-page-number="1"] .annotationLayer a'
      )
      expect(elements).toHaveLength(2)
      return elements
    })
    expect(links[0]).toHaveAttribute('href', 'https://example.com/paper')
    expect(links[0]).toHaveAttribute('target', '_blank')

    fireEvent.click(links[1])
    await waitFor(() => expect(pdfVirtualizerMocks.getOffsetForIndex)
      .toHaveBeenCalledWith(1, 'start'))
    expect(screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })).toHaveValue('2')
    expect(screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })).toHaveValue('200')
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigationBack' }))
    expect(screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })).toHaveValue('1')
    expect(screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })).toHaveValue('115')
    fireEvent.keyDown(window, { key: ']', metaKey: true })
    expect(screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })).toHaveValue('2')
    expect(screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })).toHaveValue('200')
  })

  it('supports precise zoom input and trackpad pinch zoom', async () => {
    const view = render(<PdfReader />)
    const zoom = await screen.findByRole('textbox', { name: 'pdfReader.zoomPercentage' })

    fireEvent.change(zoom, { target: { value: '137.5' } })
    fireEvent.submit(zoom.closest('form') as HTMLFormElement)
    await waitFor(() => expect(zoom).toHaveValue('137.5'))
    expect(view.container.querySelector<HTMLElement>('.pdf-reader-page'))
      .toHaveStyle({ width: '841.5px' })

    const scroller = view.container.querySelector<HTMLElement>(
      '[data-pdf-page-virtualizer]'
    )?.parentElement
    expect(scroller).not.toBeNull()
    fireEvent.wheel(scroller!, {
      ctrlKey: true,
      deltaY: -10,
      clientX: 200,
      clientY: 200
    })
    await waitFor(() => expect(Number((zoom as HTMLInputElement).value)).toBeGreaterThan(137.5))
  })

  it('moves a selected underline with a pointer drag', async () => {
    usePdfReaderStore.setState({
      tool: null,
      annotations: {
        paper: [{
          id: 'movable-underline',
          kind: 'underline',
          page: 1,
          color: '#f2c94c',
          text: 'Move me',
          comment: '',
          createdAt: 1,
          rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.04 }]
        }]
      }
    })
    const view = render(<PdfReader />)
    const pdfPage = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('.pdf-reader-page')
      expect(element).not.toBeNull()
      return element!
    })
    vi.spyOn(pdfPage, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 200,
      top: 0,
      bottom: 300,
      width: 200,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    Object.defineProperties(pdfPage, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 300 }
    })
    pdfPage.setPointerCapture = vi.fn()
    const highlight = await waitFor(() => {
      const element = pdfPage.querySelector<HTMLButtonElement>(
        'button[aria-label="pdfReader.tools.underline"]'
      )
      expect(element).not.toBeNull()
      return element!
    })

    fireEvent.pointerDown(highlight, { pointerId: 7, button: 0, clientX: 40, clientY: 30 })
    fireEvent.pointerMove(pdfPage, { pointerId: 7, clientX: 60, clientY: 60 })
    fireEvent.pointerUp(pdfPage, { pointerId: 7, clientX: 60, clientY: 60 })

    const movedRect = usePdfReaderStore.getState().annotations.paper[0].rects?.[0]
    expect(movedRect?.x).toBeCloseTo(0.2)
    expect(movedRect?.y).toBeCloseTo(0.2)
  })

  it('fits an inline text annotation box to its content', async () => {
    usePdfReaderStore.setState({ tool: 'text' })
    const view = render(<PdfReader />)
    const pdfPage = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('.pdf-reader-page')
      expect(element).not.toBeNull()
      return element!
    })
    vi.spyOn(pdfPage, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 612,
      top: 0,
      bottom: 792,
      width: 612,
      height: 792,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    const inputLayer = pdfPage.querySelector<HTMLElement>('[data-annotation-input-layer]')!
    fireEvent.pointerDown(inputLayer, {
      pointerId: 1,
      button: 0,
      clientX: 60,
      clientY: 80
    })
    const editor = await screen.findByPlaceholderText('pdfReader.textPlaceholder')

    fireEvent.change(editor, {
      target: { value: 'A much longer inline PDF annotation that wraps onto another line.' }
    })

    const annotation = usePdfReaderStore.getState().annotations.paper[0]
    expect(annotation.size?.width).toBeGreaterThan(0.16)
    expect(annotation.size?.height).toBeGreaterThan(0.04)
  })

  it('ignores PDF keyboard shortcuts while its workspace view is hidden', async () => {
    const view = render(<PdfReader active={false} />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())

    fireEvent.keyDown(window, { key: 'h' })
    expect(usePdfReaderStore.getState().tool).toBeNull()

    view.rerender(<PdfReader active />)
    fireEvent.keyDown(window, { key: 'h' })
    expect(usePdfReaderStore.getState().tool).toBe('highlight')
  })

  it('uses text selection over text and annotation selection over page whitespace by default', async () => {
    const view = render(<PdfReader />)
    const pdfPage = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('.pdf-reader-page')
      expect(element).not.toBeNull()
      return element!
    })
    vi.spyOn(pdfPage, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 200,
      top: 0,
      bottom: 300,
      width: 200,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    pdfPage.setPointerCapture = vi.fn()
    const textLayer = pdfPage.querySelector<HTMLElement>('.textLayer')!
    const text = window.document.createElement('span')
    text.textContent = 'Selectable PDF text'
    textLayer.append(text)

    expect(screen.queryByRole('button', { name: 'pdfReader.tools.read' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pdfReader.tools.select' })).not.toBeInTheDocument()
    expect(usePdfReaderStore.getState().tool).toBeNull()
    expect(pdfPage.querySelector('[data-annotation-input-layer]'))
      .toHaveClass('pointer-events-none')

    fireEvent.pointerDown(text, { pointerId: 1, clientX: 40, clientY: 40 })
    expect(pdfPage.querySelector('[data-annotation-selection]')).toBeNull()

    fireEvent.pointerDown(pdfPage, { pointerId: 2, clientX: 10, clientY: 10 })
    expect(pdfPage.querySelector('[data-annotation-selection]')).toBeVisible()
    fireEvent.pointerUp(pdfPage, { pointerId: 2, clientX: 20, clientY: 20 })

    act(() => usePdfReaderStore.setState({
      annotations: {
        paper: [
          {
            id: 'highlight-1',
            kind: 'highlight',
            page: 1,
            color: '#f2c94c',
            text: 'Marked PDF text',
            comment: '',
            createdAt: 1,
            rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.05 }]
          },
          {
            id: 'ink-1',
            kind: 'ink',
            page: 1,
            color: '#56ccf2',
            text: '',
            comment: '',
            createdAt: 2,
            points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }],
            strokeWidth: 2
          }
        ]
      }
    }))
    const markedText = await waitFor(() => {
      const element = pdfPage.querySelector<HTMLButtonElement>(
        'button[aria-label="pdfReader.tools.highlight"]'
      )
      expect(element).not.toBeNull()
      return element!
    })
    expect(markedText).toHaveAttribute('tabindex', '0')
    expect(usePdfReaderStore.getState().tool).toBeNull()
    expect(markedText).toHaveClass('z-20', 'pointer-events-auto', 'cursor-pointer')
    fireEvent.pointerDown(pdfPage, { pointerId: 3, clientX: 10, clientY: 10 })
    expect(pdfPage.querySelector('[data-annotation-selection]')).toBeVisible()
    fireEvent.pointerUp(pdfPage, { pointerId: 3, clientX: 20, clientY: 20 })
    expect(pdfPage.querySelector('svg[aria-label="pdfReader.annotations"]'))
      .toHaveStyle({ zIndex: '20' })
    fireEvent.click(markedText)
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual(['highlight-1'])
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePdfReaderStore.getState().tool).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual([])

    const ink = pdfPage.querySelector<SVGPolylineElement>('[data-annotation-kind="ink"]')!
    fireEvent.keyDown(window, { key: 'h' })
    expect(usePdfReaderStore.getState().tool).toBe('highlight')
    fireEvent.keyDown(window, { key: 'a' })
    expect(usePdfReaderStore.getState().tool).toBeNull()
    fireEvent.keyDown(ink, { key: 'Enter' })
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual(['ink-1'])
    act(() => usePdfReaderStore.getState().setTool('eraser'))
    fireEvent.keyDown(ink, { key: ' ' })
    expect(usePdfReaderStore.getState().annotations.paper.map((item) => item.id))
      .toEqual(['highlight-1'])
  })

  it('clears and suppresses text selection when drawing starts', async () => {
    const removeAllRanges = vi.fn()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      removeAllRanges
    } as unknown as Selection)
    usePdfReaderStore.setState({ tool: 'ink' })
    const view = render(<PdfReader />)
    const pdfPage = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('.pdf-reader-page')
      expect(element).not.toBeNull()
      return element!
    })
    pdfPage.setPointerCapture = vi.fn()
    const inputLayer = pdfPage.querySelector<HTMLElement>('[data-annotation-input-layer]')!
    removeAllRanges.mockClear()

    expect(fireEvent.pointerDown(inputLayer, {
      pointerId: 1,
      button: 0,
      clientX: 40,
      clientY: 40
    })).toBe(false)
    expect(removeAllRanges).toHaveBeenCalled()
  })

  it('removes an empty text annotation when its editor loses focus', async () => {
    usePdfReaderStore.setState({ tool: 'text' })
    const view = render(<PdfReader />)
    const pdfPage = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('.pdf-reader-page')
      expect(element).not.toBeNull()
      return element!
    })
    vi.spyOn(pdfPage, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 200,
      top: 0,
      bottom: 300,
      width: 200,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    const inputLayer = pdfPage.querySelector<HTMLElement>('[data-annotation-input-layer]')!
    fireEvent.pointerDown(inputLayer, {
      pointerId: 1,
      button: 0,
      clientX: 40,
      clientY: 40
    })
    const editor = await screen.findByPlaceholderText('pdfReader.textPlaceholder')
    expect(usePdfReaderStore.getState().annotations.paper).toHaveLength(1)

    fireEvent.blur(editor)

    expect(usePdfReaderStore.getState().annotations.paper).toEqual([])
    expect(screen.queryByPlaceholderText('pdfReader.textPlaceholder')).not.toBeInTheDocument()
  })

  it.each(['loading', 'error'] as const)(
    'keeps annotation input read-only while annotation loading is %s',
    async (loadStatus) => {
      usePdfReaderStore.setState({
        loadStatus: { paper: loadStatus },
        tool: 'ink'
      })

      const view = render(<PdfReader />)
      const toolbar = view.container.querySelector<HTMLElement>(
        '[data-pdf-annotation-toolbar]'
      )
      expect(toolbar).not.toBeNull()
      expect(within(toolbar!).getAllByRole('button')).toHaveLength(7)
      within(toolbar!).getAllByRole('button').forEach((button) => {
        expect(button).toBeDisabled()
      })

      const pdfPage = await waitFor(() => {
        const element = view.container.querySelector<HTMLElement>('.pdf-reader-page')
        expect(element).not.toBeNull()
        return element!
      })
      expect(pdfPage.querySelector('[data-annotation-input-layer]'))
        .toHaveClass('pointer-events-none')
      await waitFor(() => expect(usePdfReaderStore.getState().tool).toBeNull())

      fireEvent.keyDown(window, { key: 'p' })
      expect(usePdfReaderStore.getState().tool).toBeNull()
    }
  )

  it('offers copy, current-color highlight, and AI actions for selected text', async () => {
    const writeText = vi.spyOn(api.clipboard, 'writeText').mockResolvedValue(undefined)
    const removeAllRanges = vi.fn()
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'Selected research finding',
      getRangeAt: () => ({
        getClientRects: () => [{
          left: 20,
          right: 180,
          top: 40,
          bottom: 60
        }]
      }),
      removeAllRanges
    } as unknown as Selection)

    const view = render(<PdfReader />)
    const pdfPage = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>('.pdf-reader-page')
      expect(element).not.toBeNull()
      return element!
    })
    vi.spyOn(pdfPage, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 200,
      top: 0,
      bottom: 300,
      width: 200,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    fireEvent.contextMenu(pdfPage)

    const items = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      children?: Array<{ key: string; onClick?: () => void }>
      onClick?: () => void
    }>
    items.find((item) => item.key === 'copy')?.onClick?.()
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('Selected research finding')
      expect(useDocumentStore.getState().showToast)
        .toHaveBeenCalledWith('pdfReader.contextMenu.copySuccess')
    })
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    items.find((item) => item.key === 'copy')?.onClick?.()
    await waitFor(() => expect(useDocumentStore.getState().showToast)
      .toHaveBeenLastCalledWith('pdfReader.contextMenu.copyFailed'))

    items.find((item) => item.key === 'highlight')?.onClick?.()
    expect(usePdfReaderStore.getState().annotations.paper).toEqual([
      expect.objectContaining({
        kind: 'highlight',
        color: '#f2c94c',
        text: 'Selected research finding',
        page: 1,
        rects: [{ x: 0.1, y: 40 / 300, width: 0.8, height: 20 / 300 }]
      })
    ])

    const aiItems = items.find((item) => item.key === 'ai')?.children ?? []
    expect(aiItems.map((item) => item.key)).toEqual([
      'ai-summary',
      'ai-explain',
      'ai-context'
    ])
    aiItems.find((item) => item.key === 'ai-summary')?.onClick?.()
    expect(useChatDraftStore.getState().pending).toMatchObject({
      mode: 'prefill',
      text: 'pdfReader.contextMenu.summaryPrompt\n\n> Selected research finding'
    })
    expect(removeAllRanges).toHaveBeenCalled()
  })

  it('creates one current-color highlight per page for a cross-page selection', async () => {
    pdfMocks.document.numPages = 2
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'Selection spanning two pages',
      getRangeAt: () => ({
        getClientRects: () => [
          { left: 20, right: 180, top: 40, bottom: 60 },
          { left: 30, right: 170, top: 350, bottom: 370 }
        ]
      }),
      removeAllRanges: vi.fn()
    } as unknown as Selection)

    const view = render(<PdfReader />)
    const pages = await waitFor(() => {
      const elements = view.container.querySelectorAll<HTMLElement>('.pdf-reader-page')
      expect(elements).toHaveLength(2)
      return Array.from(elements)
    })
    vi.spyOn(pages[0], 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 200,
      top: 0,
      bottom: 300,
      width: 200,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    vi.spyOn(pages[1], 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 200,
      top: 320,
      bottom: 620,
      width: 200,
      height: 300,
      x: 0,
      y: 320,
      toJSON: () => ({})
    })

    fireEvent.contextMenu(pages[1])
    const items = vi.mocked(showContextMenu).mock.calls[0][0] as Array<{
      key: string
      onClick?: () => void
    }>
    items.find((item) => item.key === 'highlight')?.onClick?.()

    expect(usePdfReaderStore.getState().annotations.paper).toEqual([
      expect.objectContaining({
        kind: 'highlight',
        page: 1,
        color: '#f2c94c',
        rects: [{ x: 0.1, y: 40 / 300, width: 0.8, height: 20 / 300 }]
      }),
      expect.objectContaining({
        kind: 'highlight',
        page: 2,
        color: '#f2c94c',
        rects: [{ x: 0.15, y: 0.1, width: 0.7, height: 20 / 300 }]
      })
    ])
  })

  it('undoes and redoes annotation creation and edits using the toolbar and keyboard', async () => {
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())
    const undo = screen.getByRole('button', { name: 'pdfReader.undo' })
    const redo = screen.getByRole('button', { name: 'pdfReader.redo' })
    expect(undo).toBeDisabled()
    expect(redo).toBeDisabled()
    act(() => usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'highlight', page: 1, text: 'Important', comment: '', color: '#ff0',
      rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.04 }]
    }))
    expect(undo).toBeEnabled()
    fireEvent.click(undo)
    expect(usePdfReaderStore.getState().annotations.paper).toEqual([])
    expect(redo).toBeEnabled()
    fireEvent.click(redo)
    const id = usePdfReaderStore.getState().annotations.paper[0].id
    act(() => usePdfReaderStore.getState().updateAnnotation('paper', id, { color: '#f00' }))
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    expect(usePdfReaderStore.getState().annotations.paper[0].color).toBe('#ff0')
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true })
    expect(usePdfReaderStore.getState().annotations.paper[0].color).toBe('#f00')
    fireEvent.keyDown(screen.getByPlaceholderText('pdfReader.search'), { key: 'z', metaKey: true })
    expect(usePdfReaderStore.getState().annotations.paper[0].color).toBe('#f00')
  })

  it('saves reading progress silently and only reports a failed write', async () => {
    let completeSave!: () => void
    const save = vi.spyOn(api.settings, 'set').mockImplementationOnce(() => new Promise<void>((resolve) => {
      completeSave = resolve
    }))
    usePdfReaderStore.setState({ sidebarOpen: true })
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())
    const expectSilentPersistence = () => {
      expect(view.container.querySelector('[data-pdf-persistence-status]')).toBeNull()
      expect(view.container.querySelector('[data-pdf-persistence-error]')).toBeNull()
      expect(screen.queryByText(/^pdfReader\.saveStatus\./)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'common.retry' })).not.toBeInTheDocument()
    }
    expectSilentPersistence()
    const readingView = { ...DEFAULT_PDF_VIEW, y: 0.3 }
    act(() => usePdfViewStore.getState().updateView('paper', readingView))
    expectSilentPersistence()
    await waitFor(() => expect(save).toHaveBeenCalledWith('pdfReader.document.paper', {
      view: readingView, bookmarks: []
    }))
    expect(usePdfViewStore.getState().saveStatus.paper).toBe('saving')
    expectSilentPersistence()
    await act(async () => completeSave())
    await waitFor(() => expect(usePdfViewStore.getState().saveStatus.paper).toBe('saved'))
    expectSilentPersistence()

    save.mockRejectedValueOnce(new Error('Disk full'))
    act(() => usePdfViewStore.getState().updateView('paper', { ...readingView, y: 0.6 }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.readingStateSaveFailed'))
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { completeSave = resolve }))
    act(() => usePdfViewStore.getState().updateView('paper', { ...readingView, y: 0.8 }))
    expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.readingStateSaveFailed')
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.readingStateSaveFailed')
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.readingStateSaveFailed')
    await act(async () => completeSave())
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expectSilentPersistence()
    expect(save).toHaveBeenLastCalledWith('pdfReader.document.paper', {
      view: { ...readingView, y: 0.8 }, bookmarks: []
    })
  })

  it('keeps annotation save failures visible through edits and retries until the latest snapshot saves', async () => {
    let completeSave!: (annotations: PdfAnnotation[]) => void
    const save = vi.spyOn(api.documents, 'setPdfAnnotations')
      .mockRejectedValueOnce(new Error('Disk full'))
      .mockImplementationOnce(() => new Promise<PdfAnnotation[]>((resolve) => { completeSave = resolve }))
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())
    act(() => usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'ink', page: 1, text: '', comment: '', color: '#ff0',
      points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }]
    }))
    expect(screen.queryByText(/^pdfReader\.saveStatus\./)).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.annotationSaveFailed'))
    expect(view.container.querySelector('[data-annotation-sidebar]')).toBeNull()
    const id = usePdfReaderStore.getState().annotations.paper[0].id
    act(() => usePdfReaderStore.getState().updateAnnotation('paper', id, { color: '#f00' }))
    expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.annotationSaveFailed')
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.annotationSaveFailed')
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toHaveTextContent('pdfReader.annotationSaveFailed')
    expect(save).toHaveBeenLastCalledWith('paper', expect.arrayContaining([
      expect.objectContaining({ kind: 'ink', color: '#f00' })
    ]))
    await act(async () => completeSave(usePdfReaderStore.getState().annotations.paper))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.queryByText(/^pdfReader\.saveStatus\./)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'common.retry' })).not.toBeInTheDocument()
  })

  it('routes Command-F to PDF search and leaves it alone while the reader is hidden', async () => {
    const globalFind = vi.fn()
    window.addEventListener('keydown', globalFind)
    try {
      const view = render(<PdfReader />)
      await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      const input = screen.getByPlaceholderText('pdfReader.search')
      await waitFor(() => expect(input).toHaveFocus())
      expect(globalFind).not.toHaveBeenCalled()
      view.rerender(<PdfReader active={false} />)
      input.blur()
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      expect(input).not.toHaveFocus()
      expect(globalFind).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', globalFind)
    }
  })

  it('restores each document page, zoom and rotation when switching tabs', async () => {
    pdfMocks.document.numPages = 3
    usePdfReaderStore.setState({
      tabs: [document(), { ...document(), id: 'paper-2', title: 'Second paper' }],
      annotations: { paper: [], 'paper-2': [] },
      loadStatus: { paper: 'loaded', 'paper-2': 'loaded' }
    })
    usePdfViewStore.setState({
      documents: {
        paper: { view: { ...DEFAULT_PDF_VIEW, page: 2, y: 0.35, scale: 1.4, rotation: 90 }, bookmarks: [] },
        'paper-2': { view: { ...DEFAULT_PDF_VIEW, page: 3, y: 0.7, scale: 0.8, rotation: 180 }, bookmarks: [] }
      },
      loadStatus: { paper: 'loaded', 'paper-2': 'loaded' }
    })
    const view = render(<PdfReader />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })).toHaveValue('2'))
    expect(screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })).toHaveValue('140')
    expect(view.container.querySelector('.pdf-reader-page')).toHaveAttribute('data-page-rotation', '90')
    fireEvent.click(screen.getByRole('tab', { name: 'Second paper' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })).toHaveValue('3'))
    expect(screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })).toHaveValue('80')
    expect(view.container.querySelector('.pdf-reader-page')).toHaveAttribute('data-page-rotation', '180')
    fireEvent.click(screen.getByRole('tab', { name: 'Paper' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })).toHaveValue('2'))
    expect(screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })).toHaveValue('140')
    expect(usePdfViewStore.getState().documents.paper.view.y).toBe(0.35)
  })

  it('keeps fit width responsive to the scroller and the current page of a mixed-size PDF', async () => {
    const resizeObservers: Array<{ callback: ResizeObserverCallback; target: Element }> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { resizeObservers.push({ callback: this.callback, target }) }
      disconnect() {}
      unobserve() {}
    })
    const widePage = {
      ...pdfMocks.page,
      rotate: 90,
      getViewport: vi.fn(({ scale, rotation = 90 }: { scale: number; rotation?: number }) => {
        const viewport = {
          width: 1000 * scale, height: 600 * scale, rotation,
          convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
          convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale],
          clone: vi.fn(() => viewport)
        }
        return viewport
      })
    }
    pdfMocks.document.numPages = 2
    pdfMocks.document.getPage.mockImplementation(async (pageNumber) => pageNumber === 2 ? widePage : pdfMocks.page)
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelectorAll('.pdf-reader-page')).toHaveLength(2))
    const virtualizer = view.container.querySelector<HTMLElement>('[data-pdf-page-virtualizer]')!
    const scroller = virtualizer.parentElement!
    let width = 900
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, value: 700 }
    })
    const resize = () => {
      const observer = resizeObservers.find((item) => item.target === scroller)!
      observer.callback([], observer as unknown as ResizeObserver)
    }
    act(resize)
    await waitFor(() => expect(view.container.querySelector('[data-page-number="2"]'))
      .toHaveStyle({ width: '1150px' }))
    expect(virtualizer).toHaveStyle({ width: '1198px' })
    const fit = screen.getByRole('button', { name: 'pdfReader.fitWidth' })
    fireEvent.click(fit)
    const pageWidth = (page: number) => Number.parseFloat(view.container
      .querySelector<HTMLElement>(`[data-page-number="${page}"]`)!.style.width)
    await waitFor(() => expect(pageWidth(1)).toBeCloseTo(852, 0))
    width = 600
    act(resize)
    await waitFor(() => expect(pageWidth(1)).toBeCloseTo(552, 0))
    const pageInput = screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })
    fireEvent.change(pageInput, { target: { value: '2' } })
    fireEvent.submit(pageInput.closest('form') as HTMLFormElement)
    await waitFor(() => expect(view.container.querySelector('[data-page-number="2"]'))
      .toHaveStyle({ width: '552px' }))
    expect(fit).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })).toHaveValue('55.2')
    width = 200
    act(resize)
    await waitFor(() => expect(pageWidth(2)).toBeCloseTo(152, 0))
    expect(screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })).toHaveValue('15.2')
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.zoomIn' }))
    expect(fit).not.toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps a typed zoom value when a delayed fit-width calculation finishes after resizing', async () => {
    const resizeObservers: Array<{ callback: ResizeObserverCallback; target: Element }> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { resizeObservers.push({ callback: this.callback, target }) }
      disconnect() {}
      unobserve() {}
    })
    const view = render(<PdfReader />)
    await waitFor(() => expect(view.container.querySelector('.pdf-reader-page')).not.toBeNull())
    const page = view.container.querySelector<HTMLElement>('.pdf-reader-page')!
    const scroller = view.container.querySelector('[data-pdf-page-virtualizer]')!.parentElement!
    let width = 900
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, get: () => width },
      clientHeight: { configurable: true, value: 700 }
    })
    const resize = () => {
      const observer = resizeObservers.find((item) => item.target === scroller)!
      observer.callback([], observer as unknown as ResizeObserver)
    }
    act(resize)
    const fit = screen.getByRole('button', { name: 'pdfReader.fitWidth' })
    const zoom = screen.getByRole('textbox', { name: 'pdfReader.zoomPercentage' })
    fireEvent.click(fit)
    await waitFor(() => expect(Number.parseFloat(page.style.width)).toBeCloseTo(852, 0))
    let resolveFit: ((page: typeof pdfMocks.page) => void) | undefined
    pdfMocks.document.getPage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFit = resolve
    }))
    width = 600
    act(resize)
    await waitFor(() => expect(resolveFit).toBeDefined())
    fireEvent.change(zoom, { target: { value: '140' } })
    expect(fit).not.toHaveAttribute('aria-pressed', 'true')
    await act(async () => {
      resolveFit!(pdfMocks.page)
    })
    expect(zoom).toHaveValue('140')
    expect(Number.parseFloat(page.style.width)).toBeCloseTo(852, 0)
    expect(usePdfViewStore.getState().documents.paper.view.zoomMode).toBe('custom')
    fireEvent.submit(zoom.closest('form') as HTMLFormElement)
    await waitFor(() => expect(page).toHaveStyle({ width: '856.8px' }))
    expect(zoom).toHaveValue('140')
    expect(usePdfViewStore.getState().documents.paper.view).toMatchObject({
      scale: 1.4, zoomMode: 'custom'
    })
  })

  it('destroys the superseded loading task when switching documents', async () => {
    render(<PdfReader />)
    await waitFor(() => {
      expect(observers.some((observer) =>
        (observer.target as HTMLElement | undefined)?.hasAttribute('data-pdf-canvas-tile')
      )).toBe(true)
    })
    pdfMocks.destroyDocument.mockClear()

    act(() => {
      usePdfReaderStore.setState({
        tabs: [document(), { ...document(), id: 'paper-2', fileName: 'paper-2.pdf' }],
        activeDocumentId: 'paper-2'
      })
    })

    await waitFor(() => expect(pdfMocks.destroyDocument).toHaveBeenCalledTimes(1))
  })

  it('destroys a late-resolving loading task after unmount instead of adopting it', async () => {
    let release!: (value: typeof pdfMocks.document) => void
    const gate = new Promise<typeof pdfMocks.document>((resolve) => {
      release = resolve
    })
    pdfMocks.gateLoad(gate)
    pdfMocks.document.cleanup.mockClear()

    const view = render(<PdfReader />)
    view.unmount()

    release(pdfMocks.document)
    await waitFor(() => expect(pdfMocks.destroyDocument).toHaveBeenCalledTimes(1))
    expect(pdfMocks.document.cleanup).not.toHaveBeenCalled()
  })
})
