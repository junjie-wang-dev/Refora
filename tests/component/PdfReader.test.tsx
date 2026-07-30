import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../../src/shared/ipc-types'
import { api } from '../../src/renderer/ipc'
import PdfReader from '../../src/renderer/components/PdfReader'
import { usePdfReaderStore } from '../../src/renderer/store/pdfReaderStore'

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
  return {
    cancelRender,
    document,
    page,
    renderPage,
    translate
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: pdfMocks.translate
  })
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve(pdfMocks.document) }),
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
})
