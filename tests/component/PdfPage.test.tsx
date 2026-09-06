import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import PdfPage from '../../src/renderer/components/PdfPage'
import { api } from '../../src/renderer/ipc'
import { usePdfReaderStore, type PdfAnnotation } from '../../src/renderer/store/pdfReaderStore'
import type { PdfSearchMatch } from '../../src/renderer/hooks/usePdfSearch'

const pdfMocks = vi.hoisted(() => {
  const page = {
    rotate: 0,
    getViewport: vi.fn(({ scale, rotation = 0 }: { scale: number; rotation?: number }) => {
      const viewport = {
        width: (rotation % 180 === 0 ? 600 : 800) * scale,
        height: (rotation % 180 === 0 ? 800 : 600) * scale,
        rotation,
        clone: () => viewport
      }
      return viewport
    }),
    getTextContent: vi.fn(async () => ({ items: [{ str: 'Highlighted words' }] })),
    getAnnotations: vi.fn(async () => []),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  }
  return {
    page,
    pdf: {
      numPages: 3,
      getPage: vi.fn(async () => page),
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async () => 1),
      cachedPageNumber: vi.fn(() => null),
      annotationStorage: {}
    }
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@lobehub/ui', async () => import('../mocks/lobehub-ui'))

vi.mock('pdfjs-dist', () => ({
  TextLayer: class {
    textDivs: HTMLElement[] = []
    textContentItemsStr = ['Highlighted words']
    constructor(private options: { container: HTMLElement }) {}
    render = async () => {
      const span = document.createElement('span')
      span.textContent = this.textContentItemsStr[0]
      this.textDivs = [span]
      this.options.container.append(span)
    }
    cancel = vi.fn()
  },
  AnnotationLayer: class {
    constructor(private options: {
      div: HTMLElement
      linkService: { goToDestination: (destination: string) => void }
    }) {}
    render = async () => {
      const link = document.createElement('a')
      link.href = '#reference'
      link.textContent = 'Reference'
      link.onclick = (event) => {
        event.preventDefault()
        this.options.linkService.goToDestination('reference')
      }
      this.options.div.append(link)
    }
    destroy = vi.fn()
  }
}))

function Harness({
  active = true,
  rotation = 0,
  scale = 1,
  searchNavigationRevision = 0,
  searchMatches = [],
  onPageSize = vi.fn(),
  onNavigateToDestination = vi.fn(),
  onSearchMatchVisible = vi.fn()
}: {
  active?: boolean
  rotation?: number
  scale?: number
  searchNavigationRevision?: number
  searchMatches?: Array<{ match: PdfSearchMatch; selected: boolean }>
  onPageSize?: (page: number, height: number, width: number) => void
  onNavigateToDestination?: (destination: string | unknown[]) => void
  onSearchMatchVisible?: (page: number) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const annotations = usePdfReaderStore((state) => state.annotations.paper ?? [])
  const tool = usePdfReaderStore((state) => state.tool)
  return (
    <div ref={rootRef}>
      <PdfPage
        active={active}
        pdf={pdfMocks.pdf as unknown as PDFDocumentProxy}
        pageNumber={1}
        scale={scale}
        maximumScale={2}
        rotation={rotation}
        devicePixelRatio={1}
        scrollRootRef={rootRef}
        documentId="paper"
        documentTitle="Paper"
        annotations={annotations}
        tool={tool}
        color="#ff0"
        fontSize={14}
        strokeWidth={2}
        searchMatches={searchMatches}
        searchNavigationRevision={searchNavigationRevision}
        onAddAnnotation={(draft) => usePdfReaderStore.getState().addAnnotation('paper', draft)}
        onPageSize={onPageSize}
        onPageVisible={vi.fn()}
        onNavigateToPage={vi.fn()}
        onNavigateToDestination={onNavigateToDestination}
        onSearchMatchVisible={onSearchMatchVisible}
      />
    </div>
  )
}

async function loadedPage(container: HTMLElement): Promise<HTMLElement> {
  await screen.findByText('Highlighted words')
  const element = container.querySelector<HTMLElement>('[data-page-number]')!
  element.setPointerCapture = vi.fn()
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800,
    x: 0, y: 0, toJSON: () => ({})
  })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: 600 })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 800 })
  return element
}

const highlight: PdfAnnotation = {
  id: 'mark', kind: 'highlight', page: 1, text: 'Highlighted words', comment: '',
  color: '#ff0', createdAt: 0, rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.04 }]
}

describe('PdfPage annotation interaction', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    })
    pdfMocks.page.rotate = 0
    pdfMocks.page.getViewport.mockClear()
    usePdfReaderStore.getState().resetForLibrarySwitch()
    usePdfReaderStore.setState({
      activeDocumentId: 'paper', annotations: { paper: [] }, loadStatus: { paper: 'loaded' }
    })
    vi.spyOn(api.documents, 'setPdfAnnotations').mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    usePdfReaderStore.getState().resetForLibrarySwitch()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('selects highlights without moving them, including when dragging a mixed selection', async () => {
    const ink: PdfAnnotation = {
      id: 'ink', kind: 'ink', page: 1, text: '', comment: '', color: '#f00',
      points: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }], createdAt: 0
    }
    usePdfReaderStore.setState({ annotations: { paper: [highlight, ink] } })
    const view = render(<Harness />)
    const page = await loadedPage(view.container)
    const mark = screen.getByRole('button', { name: 'pdfReader.tools.highlight' })
    expect(mark).toHaveClass('cursor-pointer')
    fireEvent.pointerDown(mark, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(page, { pointerId: 1, clientX: 160, clientY: 180 })
    fireEvent.pointerUp(page, { pointerId: 1, clientX: 160, clientY: 180 })
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual([highlight.id])
    expect(usePdfReaderStore.getState().annotations.paper[0].rects).toEqual(highlight.rects)
    expect(usePdfReaderStore.getState().annotationHistory.paper).toBeUndefined()

    act(() => usePdfReaderStore.getState().selectAnnotations([highlight.id, ink.id]))
    const drawing = page.querySelector('[data-annotation-kind="ink"]')!
    fireEvent.pointerDown(drawing, { button: 0, pointerId: 2, clientX: 180, clientY: 240 })
    fireEvent.pointerMove(page, { pointerId: 2, clientX: 240, clientY: 320 })
    fireEvent.pointerUp(page, { pointerId: 2, clientX: 240, clientY: 320 })
    expect(usePdfReaderStore.getState().annotations.paper[0].rects).toEqual(highlight.rects)
    expect(usePdfReaderStore.getState().annotations.paper[1].points?.[0].x).toBeCloseTo(0.4)
    expect(usePdfReaderStore.getState().annotationHistory.paper.past).toHaveLength(1)
    act(() => usePdfReaderStore.getState().undo('paper'))
    expect(usePdfReaderStore.getState().annotations.paper).toEqual([highlight, ink])
  })

  it('uses the shared annotation selection frame for text and hides it while editing', async () => {
    usePdfReaderStore.setState({
      annotations: { paper: [
        { id: 'text', kind: 'text', page: 1, text: 'Editable', comment: '', color: '#f00',
          point: { x: 0.2, y: 0.3 }, size: { width: 0.3, height: 0.05 }, createdAt: 0 },
        { id: 'ink', kind: 'ink', page: 1, text: '', comment: '', color: '#f00',
          points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }], createdAt: 0 }
      ] },
      selectedAnnotationIds: ['text', 'ink']
    })
    const view = render(<Harness />)
    const page = await loadedPage(view.container)
    const frame = page.querySelector<HTMLElement>('[data-selected-annotation="text"]')!
    const inkFrame = page.querySelector<HTMLElement>('[data-selected-annotation="ink"]')!
    expect(frame.className).toBe(inkFrame.className)
    expect(frame.querySelectorAll('span')).toHaveLength(4)
    const textarea = screen.getByRole('textbox', { name: 'pdfReader.tools.text' })
    expect(textarea).toHaveClass('outline-none')
    fireEvent.doubleClick(textarea)
    expect(page.querySelector('[data-selected-annotation="text"]')).toBeNull()
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(page.querySelector('[data-selected-annotation="text"]')).toHaveClass('border-2', 'border-accent')
  })

  it('opens a new note immediately, saves its comment and reopens it without a sidebar', async () => {
    usePdfReaderStore.getState().setTool('note')
    const view = render(<Harness />)
    const page = await loadedPage(view.container)
    fireEvent.pointerDown(page, { button: 0, pointerId: 1, clientX: 120, clientY: 200 })
    const dialog = await screen.findByRole('dialog', { name: 'pdfReader.editNote' })
    const editor = within(dialog).getByRole('textbox')
    await waitFor(() => expect(editor).toHaveFocus())
    fireEvent.change(editor, { target: { value: 'R' } })
    fireEvent.change(editor, { target: { value: 'Read this again' } })
    fireEvent.blur(editor)
    fireEvent.click(within(dialog).getByRole('button', { name: 'pdfReader.closeNote' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(usePdfReaderStore.getState().sidebarOpen).toBe(false)
    expect(usePdfReaderStore.getState().annotationHistory.paper.past).toHaveLength(1)
    act(() => usePdfReaderStore.getState().setTool(null))
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.tools.note' }))
    expect(screen.getByRole('textbox')).toHaveValue('Read this again')
    fireEvent.blur(screen.getByRole('textbox'))
    act(() => usePdfReaderStore.getState().undo('paper'))
    expect(usePdfReaderStore.getState().annotations.paper).toEqual([])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each(['double click', 'keyboard'])('reopens text with %s and groups each editing session for undo', async (action) => {
    usePdfReaderStore.setState({ annotations: { paper: [{
      id: 'text', kind: 'text', page: 1, text: 'Original', comment: '', color: '#f00',
      point: { x: 0.1, y: 0.2 }, size: { width: 0.3, height: 0.05 }, createdAt: 0
    }] } })
    const view = render(<Harness />)
    await loadedPage(view.container)
    const editor = screen.getByRole('textbox', { name: 'pdfReader.tools.text' })
    expect(editor).toHaveAttribute('readonly')
    expect(editor).toHaveAttribute('title', 'pdfReader.editTextHint')
    fireEvent.click(editor)
    expect(editor).toHaveAttribute('readonly')
    expect(usePdfReaderStore.getState().textEditor).toBeNull()
    if (action === 'double click') fireEvent.doubleClick(editor)
    else fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(editor).toHaveFocus())
    expect(editor).not.toHaveAttribute('readonly')
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual(['text'])
    expect(usePdfReaderStore.getState().annotations.paper[0].color).toBe('#f00')
    fireEvent.change(editor, { target: { value: 'Updated' } })
    fireEvent.change(editor, { target: { value: 'Updated annotation' } })
    fireEvent.blur(editor)
    expect(editor).toHaveAttribute('readonly')
    fireEvent.doubleClick(editor)
    await waitFor(() => expect(editor).toHaveFocus())
    fireEvent.change(editor, { target: { value: 'Edited again' } })
    fireEvent.blur(editor)
    act(() => usePdfReaderStore.getState().undo('paper'))
    expect(editor).toHaveValue('Updated annotation')
    act(() => usePdfReaderStore.getState().undo('paper'))
    expect(editor).toHaveValue('Original')
  })

  it('keeps a note editor inside the reader viewport when a tiny PDF page or its anchor is clipped', async () => {
    usePdfReaderStore.setState({ annotations: { paper: [{
      id: 'note', kind: 'note', page: 1, color: '#ff0', text: '', comment: 'Original',
      point: { x: 0.9, y: 0.9 }, createdAt: 0
    }] } })
    const view = render(<Harness scale={0.1} />)
    const page = await loadedPage(view.container)
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      left, top, width, height, right: left + width, bottom: top + height,
      x: left, y: top, toJSON: () => ({})
    })
    vi.mocked(page.getBoundingClientRect).mockReturnValue(rect(420, 360, 60, 80))
    const root = page.parentElement!
    const rootBounds = vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 400, 300))
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.tools.note' }))
    const editor = await screen.findByRole('dialog', { name: 'pdfReader.editNote' })
    expect(page).not.toContainElement(editor)
    expect(editor.parentElement).toBe(document.body)
    expect(editor).toHaveClass('fixed', 'overflow-auto')
    expect(editor).toHaveStyle({ left: '236px', top: '200px', maxWidth: '384px', maxHeight: '284px' })
    const comment = within(editor).getByRole('textbox')
    await waitFor(() => expect(comment).toHaveFocus())
    fireEvent.change(comment, { target: { value: 'Revised' } })
    fireEvent.change(comment, { target: { value: 'Revised note' } })
    rootBounds.mockReturnValue(rect(100, 100, 400, 120))
    fireEvent(window, new Event('resize'))
    expect(editor).toHaveStyle({ left: '236px', top: '108px', maxHeight: '104px' })
    fireEvent.pointerDown(document.body, { button: 0 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => usePdfReaderStore.getState().undo('paper'))
    expect(usePdfReaderStore.getState().annotations.paper[0].comment).toBe('Original')
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.tools.note' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    view.rerender(<Harness scale={0.1} active={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('combines intrinsic rotation with user rotation for page size and annotation geometry', async () => {
    pdfMocks.page.rotate = 90
    usePdfReaderStore.setState({ annotations: { paper: [highlight, {
      id: 'text', kind: 'text', page: 1, text: 'Rotated', comment: '', color: '#ff0',
      point: { x: 0.1, y: 0.2 }, size: { width: 0.3, height: 0.05 }, createdAt: 0
    }] } })
    const onPageSize = vi.fn()
    const view = render(<Harness onPageSize={onPageSize} />)
    const page = await loadedPage(view.container)
    expect(page).toHaveAttribute('data-page-rotation', '90')
    expect(page).toHaveStyle({ width: '800px', height: '600px' })
    expect(onPageSize).toHaveBeenLastCalledWith(1, 600, 800)
    expect(screen.getByRole('textbox')).toHaveStyle({
      width: '180px', height: '40px', transform: 'translateX(40px) rotate(90deg)'
    })
    view.rerender(<Harness rotation={90} onPageSize={onPageSize} />)
    expect(page).toHaveAttribute('data-page-rotation', '180')
    expect(onPageSize).toHaveBeenLastCalledWith(1, 800, 600)
  })

  it('passes the full named destination to the reader when following a native reference', async () => {
    const onNavigateToDestination = vi.fn()
    render(<Harness onNavigateToDestination={onNavigateToDestination} />)
    fireEvent.click(await screen.findByRole('link', { name: 'Reference' }))
    expect(onNavigateToDestination).toHaveBeenCalledWith('reference')
  })

  it.each([false, true])('preserves an active DOM selection across equivalent search renders (search=%s)', async (searching) => {
    const matches = () => searching ? [{
      match: { page: 1, fragments: [{ itemIndex: 0, start: 0, end: 11 }] }, selected: true
    }] : []
    const view = render(<Harness searchMatches={matches()} />)
    await loadedPage(view.container)
    await act(async () => undefined)
    const text = await waitFor(() => {
      const element = view.container.querySelector(searching ? '.textLayer .highlight' : '.textLayer span')
      expect(element).not.toBeNull()
      return element!
    })
    const node = text.firstChild!
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 8)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selection.toString()).toBe('Highligh')
    view.rerender(<Harness searchMatches={matches()} onSearchMatchVisible={vi.fn()} />)
    expect(text.firstChild).toBe(node)
    expect(range.startContainer).toBe(node)
    expect(selection.toString()).toBe('Highligh')
    view.rerender(<Harness searchMatches={matches()} searchNavigationRevision={1}
      onSearchMatchVisible={vi.fn()} />)
    expect(text.firstChild).toBe(node)
    expect(range.startContainer).toBe(node)
    expect(selection.toString()).toBe('Highligh')
  })

  it('centers a selected search hit once without moving it again as results or zoom change', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true, value: scrollIntoView
    })
    const onSearchMatchVisible = vi.fn()
    const first = { page: 1, fragments: [{ itemIndex: 0, start: 0, end: 11 }] }
    const second = { page: 1, fragments: [{ itemIndex: 0, start: 12, end: 17 }] }
    const view = render(<Harness searchMatches={[{ match: first, selected: true }]}
      onSearchMatchVisible={onSearchMatchVisible} />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(onSearchMatchVisible).toHaveBeenCalledWith(1)
    view.rerender(<Harness searchMatches={[
      { match: first, selected: true }, { match: second, selected: false }
    ]} onSearchMatchVisible={onSearchMatchVisible} />)
    await act(async () => {
      view.rerender(<Harness scale={1.5} searchMatches={[
        { match: first, selected: true }, { match: second, selected: false }
      ]} onSearchMatchVisible={onSearchMatchVisible} />)
    })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    view.rerender(<Harness scale={1.5} searchMatches={[
      { match: first, selected: false }, { match: second, selected: true }
    ]} onSearchMatchVisible={onSearchMatchVisible} />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
    expect(onSearchMatchVisible).toHaveBeenCalledTimes(2)
    view.rerender(<Harness scale={1.5} searchNavigationRevision={1} searchMatches={[
      { match: first, selected: false }, { match: second, selected: true }
    ]} onSearchMatchVisible={onSearchMatchVisible} />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(3))
    expect(onSearchMatchVisible).toHaveBeenCalledTimes(3)
  })
})
