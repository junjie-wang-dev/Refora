import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import PdfNavigationSidebar from '../../src/renderer/components/PdfNavigationSidebar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`
  })
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function pdfFixture(numPages = 5) {
  const cancel = vi.fn()
  const page = {
    rotate: 90,
    getViewport: vi.fn(({ scale }: { scale: number; rotation: number }) => ({
      width: 800 * scale,
      height: 600 * scale
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel }))
  }
  const pdf = {
    numPages,
    getOutline: vi.fn().mockResolvedValue([]),
    getPage: vi.fn().mockResolvedValue(page)
  }
  return { pdf, page, cancel }
}

function propsFor(pdf: ReturnType<typeof pdfFixture>['pdf']): ComponentProps<typeof PdfNavigationSidebar> {
  return {
    pdf: pdf as unknown as PDFDocumentProxy,
    currentPage: 1,
    rotation: 0,
    bookmarks: [],
    onNavigate: vi.fn(),
    onNavigateDestination: vi.fn(),
    onAddBookmark: vi.fn(),
    onRenameBookmark: vi.fn(),
    onRemoveBookmark: vi.fn(),
    onClose: vi.fn(),
    overlay: false
  }
}

function selectSection(section: string) {
  fireEvent.click(screen.getByRole('tab', { name: `pdfReader.navigation.${section}` }))
}

describe('PdfNavigationSidebar', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('loads an outline, expands nested sections, and preserves exact named and explicit destinations', async () => {
    const { pdf } = pdfFixture()
    const destination = [{ num: 4, gen: 0 }, { name: 'XYZ' }, 20, 400, null]
    pdf.getOutline.mockResolvedValue([
      {
        title: 'Introduction',
        dest: 'intro',
        items: [{ title: 'Background', dest: destination, items: [] }]
      }
    ])
    const props = propsFor(pdf)
    render(<PdfNavigationSidebar {...props} />)

    expect(screen.getByRole('status')).toHaveTextContent('pdfReader.navigation.loadingOutline')
    fireEvent.click(await screen.findByRole('button', { name: 'Introduction' }))
    expect(props.onNavigateDestination).toHaveBeenCalledWith('intro')
    fireEvent.click(screen.getByRole('button', { name: 'Background' }))
    expect(props.onNavigateDestination).toHaveBeenCalledWith(destination)
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.collapse Introduction' }))
    expect(screen.queryByRole('button', { name: 'Background' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.expand Introduction' }))
    expect(screen.getByRole('button', { name: 'Background' })).toBeInTheDocument()
  })

  it('allows an outline heading without a destination to expand its children', async () => {
    const { pdf } = pdfFixture()
    pdf.getOutline.mockResolvedValue([{ title: 'Part one', dest: null, items: [{ title: 'Chapter', dest: [0], items: [] }] }])
    const props = propsFor(pdf)
    render(<PdfNavigationSidebar {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Part one' }))
    expect(screen.queryByRole('button', { name: 'Chapter' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Part one' }))
    expect(screen.getByRole('button', { name: 'Chapter' })).toBeInTheDocument()
    expect(props.onNavigateDestination).not.toHaveBeenCalled()
  })

  it('shows an empty outline state for a PDF without an outline', async () => {
    const { pdf } = pdfFixture()
    pdf.getOutline.mockResolvedValue(null)
    render(<PdfNavigationSidebar {...propsFor(pdf)} />)
    expect(await screen.findByText('pdfReader.navigation.noOutline')).toBeInTheDocument()
    expect(pdf.getPage).not.toHaveBeenCalled()
  })

  it('retries an outline read error', async () => {
    const { pdf } = pdfFixture()
    pdf.getOutline.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce([{ title: 'Recovered', dest: 'chapter', items: [] }])
    render(<PdfNavigationSidebar {...propsFor(pdf)} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('pdfReader.navigation.outlineError')
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.retry' }))
    expect(await screen.findByRole('button', { name: 'Recovered' })).toBeInTheDocument()
    expect(pdf.getOutline).toHaveBeenCalledTimes(2)
  })

  it('ignores an old document outline that completes after switching PDFs', async () => {
    const first = pdfFixture()
    const oldOutline = deferred<unknown[]>()
    first.pdf.getOutline.mockReturnValue(oldOutline.promise)
    const second = pdfFixture()
    second.pdf.getOutline.mockResolvedValue([{ title: 'Current document', dest: 'current', items: [] }])
    const { rerender } = render(<PdfNavigationSidebar {...propsFor(first.pdf)} />)
    rerender(<PdfNavigationSidebar {...propsFor(second.pdf)} />)
    expect(await screen.findByRole('button', { name: 'Current document' })).toBeInTheDocument()
    oldOutline.resolve([{ title: 'Old document', dest: 'old', items: [] }])
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Old document' })).not.toBeInTheDocument())
  })

  it('supports keyboard switching between navigation tabs', async () => {
    const { pdf } = pdfFixture()
    render(<PdfNavigationSidebar {...propsFor(pdf)} />)
    const outline = screen.getByRole('tab', { name: 'pdfReader.navigation.outline' })
    outline.focus()
    fireEvent.keyDown(outline, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'pdfReader.navigation.pages' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'pdfReader.navigation.pages' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'pdfReader.navigation.bookmarks' })).toHaveFocus()
    expect(screen.getByText('pdfReader.navigation.noBookmarks')).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(outline).toHaveFocus()
    await screen.findByText('pdfReader.navigation.noOutline')
  })

  it('mounts a bounded window of thumbnails for a ten-thousand-page PDF and follows the current page', async () => {
    const { pdf } = pdfFixture(10000)
    const props = propsFor(pdf)
    const { container, rerender } = render(<PdfNavigationSidebar {...props} />)
    selectSection('pages')
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalled())
    expect(container.querySelectorAll('canvas').length).toBeLessThanOrEqual(7)
    expect(pdf.getPage.mock.calls.length).toBeLessThanOrEqual(7)
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.page 3' }))
    expect(props.onNavigate).toHaveBeenCalledWith(3)

    rerender(<PdfNavigationSidebar {...props} currentPage={5000} />)
    expect(await screen.findByRole('button', { name: 'pdfReader.navigation.page 5000' })).toHaveAttribute('aria-current', 'page')
    expect(container.querySelectorAll('canvas').length).toBeLessThanOrEqual(7)
    expect(screen.queryByRole('button', { name: 'pdfReader.navigation.page 1' })).not.toBeInTheDocument()
    const scrollContainer = container.querySelector<HTMLElement>('[data-pdf-thumbnails]')!
    fireEvent.scroll(scrollContainer, { target: { scrollTop: 184 * 7999 } })
    expect(screen.getByRole('button', { name: 'pdfReader.navigation.page 8000' })).toBeInTheDocument()
    expect(container.querySelectorAll('canvas').length).toBeLessThanOrEqual(7)
  })

  it('adds native PDF rotation to the user rotation and keeps thumbnail canvases small', async () => {
    const { pdf, page } = pdfFixture(1)
    const { container } = render(<PdfNavigationSidebar {...propsFor(pdf)} rotation={90} />)
    selectSection('pages')
    await waitFor(() => expect(page.render).toHaveBeenCalled())
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 1, rotation: 180 })
    expect(page.getViewport).toHaveBeenCalledWith({ scale: 0.2, rotation: 180 })
    const canvas = container.querySelector('canvas')!
    expect(canvas.width).toBeLessThanOrEqual(320)
    expect(canvas.height).toBeLessThanOrEqual(272)
  })

  it('cancels in-progress thumbnail rendering when closing the thumbnail section', async () => {
    const { pdf, page, cancel } = pdfFixture(1)
    const rendering = deferred<void>()
    page.render.mockReturnValue({ promise: rendering.promise, cancel })
    render(<PdfNavigationSidebar {...propsFor(pdf)} />)
    selectSection('pages')
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1))
    selectSection('bookmarks')
    expect(cancel).toHaveBeenCalledTimes(1)
    rendering.reject(new Error('RenderingCancelledException'))
    await waitFor(() => expect(screen.queryByText('pdfReader.navigation.thumbnailError')).not.toBeInTheDocument())
  })

  it('does not render a thumbnail if its page read finishes after unmount', async () => {
    const { pdf, page } = pdfFixture(1)
    const loading = deferred<typeof page>()
    pdf.getPage.mockReturnValue(loading.promise)
    const { unmount } = render(<PdfNavigationSidebar {...propsFor(pdf)} />)
    selectSection('pages')
    expect(pdf.getPage).toHaveBeenCalledTimes(1)
    unmount()
    loading.resolve(page)
    await Promise.resolve()
    expect(page.render).not.toHaveBeenCalled()
  })

  it('keeps page navigation available after a thumbnail failure and supports retry', async () => {
    const { pdf, page } = pdfFixture(1)
    pdf.getPage.mockRejectedValueOnce(new Error('page read failed')).mockResolvedValueOnce(page)
    const props = propsFor(pdf)
    render(<PdfNavigationSidebar {...props} />)
    selectSection('pages')
    expect(await screen.findByText('pdfReader.navigation.thumbnailError')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.page 1' }))
    expect(props.onNavigate).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.retry' }))
    await waitFor(() => expect(screen.queryByText('pdfReader.navigation.thumbnailError')).not.toBeInTheDocument())
    await waitFor(() => expect(page.render).toHaveBeenCalledTimes(1))
  })

  it('adds bookmarks and navigates existing bookmarks to their saved page position', () => {
    const { pdf } = pdfFixture()
    const props = propsFor(pdf)
    props.bookmarks = [{ id: 'bookmark-1', title: 'Useful definition', page: 4, x: 0.1, y: 0.62 }]
    render(<PdfNavigationSidebar {...props} />)
    selectSection('bookmarks')
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.addBookmark' }))
    expect(props.onAddBookmark).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Useful definition, pdfReader.navigation.page 4' }))
    expect(props.onNavigate).toHaveBeenCalledWith(4, { x: 0.1, y: 0.62 })
  })

  it('renames bookmarks inline, rejects blank names, and removes them', () => {
    const { pdf } = pdfFixture()
    const props = propsFor(pdf)
    props.bookmarks = [{ id: 'bookmark-1', title: 'Definition', page: 4, x: 0, y: 0.62 }]
    render(<PdfNavigationSidebar {...props} />)
    selectSection('bookmarks')
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.renameBookmark Definition' }))
    const input = screen.getByRole('textbox', { name: 'pdfReader.navigation.bookmarkTitle' })
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: 'pdfReader.navigation.saveBookmark' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '  Key equation  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.saveBookmark' }))
    expect(props.onRenameBookmark).toHaveBeenCalledWith('bookmark-1', 'Key equation')
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.removeBookmark Definition' }))
    expect(props.onRemoveBookmark).toHaveBeenCalledWith('bookmark-1')
  })

  it('cancels a bookmark rename using Escape without losing the saved title', () => {
    const { pdf } = pdfFixture()
    const props = propsFor(pdf)
    props.bookmarks = [{ id: 'bookmark-1', title: 'Definition', page: 4, x: 0, y: 0.62 }]
    render(<PdfNavigationSidebar {...props} />)
    selectSection('bookmarks')
    const renameLabel = 'pdfReader.navigation.renameBookmark Definition'
    fireEvent.click(screen.getByRole('button', { name: renameLabel }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Abandoned edit' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(props.onRenameBookmark).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: renameLabel }))
    expect(screen.getByRole('textbox')).toHaveValue('Definition')
  })

  it('offers a close button in both docked and overlay layouts', () => {
    const { pdf } = pdfFixture()
    const props = propsFor(pdf)
    const { rerender } = render(<PdfNavigationSidebar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.close' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    rerender(<PdfNavigationSidebar {...props} overlay />)
    expect(screen.getByRole('complementary')).toHaveAttribute('data-overlay', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'pdfReader.navigation.close' }))
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})
