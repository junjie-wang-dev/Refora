import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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
  return {
    cancelRender,
    document,
    page,
    renderPage,
    translate,
    destroyDocument,
    gateLoad(promise: Promise<typeof document> | null) {
      loadGate = promise
    },
    createLoadingTask() {
      return {
        promise: loadGate ?? Promise.resolve(document),
        destroy: destroyDocument
      }
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
  getDocument: () => pdfMocks.createLoadingTask(),
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
    pdfMocks.destroyDocument.mockClear()
    pdfMocks.gateLoad(null)
    vi.spyOn(api.documents, 'readPdf').mockResolvedValue(new Uint8Array([1]))
    usePdfReaderStore.setState({
      tabs: [document()],
      activeDocumentId: 'paper',
      annotations: { paper: [] },
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
