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
import type { Document } from '../../src/shared/ipc-types'
import { api } from '../../src/renderer/ipc'
import PdfReader from '../../src/renderer/components/PdfReader'
import { usePdfReaderStore } from '../../src/renderer/store/pdfReaderStore'
import { useChatDraftStore } from '../../src/renderer/store/chatDraftStore'
import { useDocumentStore } from '../../src/renderer/store/documentStore'

const pdfMocks = vi.hoisted(() => {
  const translate = (key: string) => key
  const cancelRender = vi.fn()
  const renderPage = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel: cancelRender
  }))
  const page = {
    getViewport: vi.fn(({ scale, rotation }: { scale: number; rotation: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
      rotation
    })),
    getTextContent: vi.fn(async () => ({ items: [] })),
    render: renderPage
  }
  const document = {
    numPages: 1,
    getPage: vi.fn(async () => page),
    cleanup: vi.fn()
  }
  const destroyDocument = vi.fn(async () => undefined)
  let loadGate: Promise<typeof document> | null = null
  const getDocument = vi.fn(() => ({
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
    render = vi.fn(async () => undefined)
    cancel = vi.fn()
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

function document(): Document {
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
    observers = []
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)
    pdfMocks.renderPage.mockClear()
    pdfMocks.cancelRender.mockClear()
    pdfMocks.document.numPages = 1
    pdfMocks.document.getPage.mockReset().mockResolvedValue(pdfMocks.page)
    pdfMocks.page.getTextContent.mockReset().mockResolvedValue({ items: [] })
    pdfMocks.destroyDocument.mockClear()
    pdfMocks.getDocument.mockClear()
    pdfMocks.gateLoad(null)
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('preloads against the PDF scroller and rerenders a released tile', async () => {
    const view = render(<PdfReader />)

    await waitFor(() => {
      expect(observers.some((observer) => observer.target instanceof HTMLCanvasElement)).toBe(true)
    })
    expect(api.documents.readPdfRange).toHaveBeenCalledWith('paper', 0, 65536)
    expect(pdfMocks.getDocument).toHaveBeenCalledWith({
      range: expect.anything(),
      rangeChunkSize: 65536,
      disableAutoFetch: true,
      disableStream: true
    })

    const canvasObserver = observers.find(
      (observer) => observer.target instanceof HTMLCanvasElement
    )
    const root = canvasObserver?.options?.root
    expect(root).toBeInstanceOf(HTMLDivElement)
    expect((root as HTMLDivElement).classList.contains('overflow-auto')).toBe(true)
    expect(canvasObserver?.options?.rootMargin).toBe('700px 0px')

    const canvas = canvasObserver?.target as HTMLCanvasElement
    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(1))
    expect(canvas.width).toBeGreaterThan(1)
    expect(canvas.height).toBeGreaterThan(1)

    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    await waitFor(() => expect(canvas.width).toBe(1))
    expect(canvas.height).toBe(1)

    act(() => {
      canvasObserver?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        canvasObserver as unknown as IntersectionObserver
      )
    })
    await waitFor(() => expect(pdfMocks.renderPage).toHaveBeenCalledTimes(2))
    expect(view.container.querySelector('.pdf-reader-page')).toBeVisible()
  })

  it('defers loading distant pages until they enter the reader preload window', async () => {
    pdfMocks.document.numPages = 4
    pdfMocks.document.getPage.mockClear()
    render(<PdfReader />)

    await waitFor(() => expect(pdfMocks.document.getPage).toHaveBeenCalledTimes(2))
    const thirdPageObserver = observers.find(
      (observer) => (observer.target as HTMLElement | undefined)?.dataset.pageNumber === '3'
    )
    expect(thirdPageObserver).toBeDefined()

    act(() => {
      thirdPageObserver?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        thirdPageObserver as unknown as IntersectionObserver
      )
    })

    await waitFor(() => expect(pdfMocks.document.getPage).toHaveBeenCalledTimes(3))
    const thirdPageCurrentObserver = observers.find(
      (observer) =>
        (observer.target as HTMLElement | undefined)?.dataset.pageNumber === '3' &&
        observer.options?.rootMargin === undefined
    )
    act(() => {
      thirdPageCurrentObserver?.callback(
        [pageVisibilityEntry(1600, 0, 800)],
        thirdPageCurrentObserver as unknown as IntersectionObserver
      )
    })
    expect(screen.getByRole('textbox', { name: 'pdfReader.pageNumber' })).toHaveValue('3')
  })

  it('chooses the largest page in the real viewport regardless of preload callback order', async () => {
    pdfMocks.document.numPages = 2
    render(<PdfReader />)
    await waitFor(() => {
      expect(observers.filter((observer) =>
        (observer.target as HTMLElement | undefined)?.dataset.pageNumber
      )).toHaveLength(4)
    })
    const pageObservers = (page: string) => observers.filter(
      (observer) => (observer.target as HTMLElement | undefined)?.dataset.pageNumber === page
    )
    const pageOneCurrent = pageObservers('1').find(
      (observer) => observer.options?.rootMargin === undefined
    )!
    const pageTwoPreload = pageObservers('2').find(
      (observer) => observer.options?.rootMargin === '700px 0px'
    )!
    const pageTwoCurrent = pageObservers('2').find(
      (observer) => observer.options?.rootMargin === undefined
    )!

    act(() => {
      pageOneCurrent.callback(
        [pageVisibilityEntry(0, 0, 600)],
        pageOneCurrent as unknown as IntersectionObserver
      )
      pageTwoPreload.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        pageTwoPreload as unknown as IntersectionObserver
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
    expect(olderPage.getTextContent).toHaveBeenCalledTimes(1)
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

    expect(view.container.querySelector('[aria-label="pdfReader.tools.read"]')).toBeNull()
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
    expect(markedText).toHaveClass('z-20', 'pointer-events-auto', 'cursor-pointer')
    expect(pdfPage.querySelector('svg[aria-label="pdfReader.annotations"]'))
      .toHaveStyle({ zIndex: '20' })
    fireEvent.click(markedText)
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual(['highlight-1'])
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual([])

    const ink = pdfPage.querySelector<SVGPolylineElement>('[data-annotation-kind="ink"]')!
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

  it('destroys the superseded loading task when switching documents', async () => {
    render(<PdfReader />)
    await waitFor(() => {
      expect(observers.some((observer) => observer.target instanceof HTMLCanvasElement)).toBe(true)
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
