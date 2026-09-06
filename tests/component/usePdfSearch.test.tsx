import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy, PDFPageProxy, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import { usePdfSearch } from '../../src/renderer/hooks/usePdfSearch'

function content(str: string): TextContent {
  return {
    items: [{
      str,
      dir: 'ltr',
      transform: [10, 0, 0, 10, 0, 100],
      width: str.length * 5,
      height: 10,
      fontName: 'test',
      hasEOL: false
    }],
    styles: {},
    lang: null
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function documentWithPages(pages: Array<string | (() => Promise<TextContent>)>) {
  const getPage = vi.fn(async (number: number) => ({
    getTextContent: vi.fn(async () => {
      const page = pages[number - 1]
      return typeof page === 'string' ? content(page) : page()
    })
  }))
  return { pdf: { numPages: pages.length, getPage } as unknown as PDFDocumentProxy, getPage }
}

function setup(pdf: PDFDocumentProxy) {
  const navigateToPage = vi.fn()
  const hook = renderHook(({ document, key }) => usePdfSearch({
    pdf: document,
    cacheKey: key,
    failureMessage: 'Search failed',
    navigateToPage
  }), { initialProps: { document: pdf, key: 'first' } })
  return { ...hook, navigateToPage }
}

describe('usePdfSearch', () => {
  it('publishes matches before all pages load and preserves a result selected during the scan', async () => {
    const lastPage = deferred<TextContent>()
    const { pdf } = documentWithPages(['term term', () => lastPage.promise])
    const { result, navigateToPage } = setup(pdf)
    act(() => result.current.updateQuery('term'))
    let pending!: Promise<void>
    act(() => { pending = result.current.run() })
    await waitFor(() => expect(result.current.matches).toHaveLength(2))
    expect(result.current.searching).toBe(true)
    expect(result.current.completed).toBe(false)
    expect(result.current.pagesSearched).toBe(1)
    expect(navigateToPage).toHaveBeenCalledTimes(1)
    act(() => result.current.cycle(1))
    await act(async () => {
      lastPage.resolve(content('term'))
      await pending
    })
    expect(result.current.matches).toHaveLength(3)
    expect(result.current.index).toBe(1)
    expect(result.current.completed).toBe(true)
    expect(result.current.searching).toBe(false)
    expect(result.current.pagesSearched).toBe(2)
    expect(navigateToPage).toHaveBeenCalledTimes(2)
  })

  it('reports no results only after a completed search and clears that state for edits', async () => {
    const { pdf } = documentWithPages(['reader'])
    const { result } = setup(pdf)
    expect(result.current.noResults).toBe(false)
    act(() => result.current.updateQuery('absent'))
    await act(async () => { await result.current.run() })
    expect(result.current.noResults).toBe(true)
    act(() => result.current.updateQuery('reader'))
    expect(result.current.noResults).toBe(false)
  })

  it('keeps usable results when a page fails and retries the failed page on a new search', async () => {
    const brokenPage = vi.fn<() => Promise<TextContent>>()
      .mockRejectedValueOnce(new Error('Unreadable page'))
      .mockResolvedValue(content('term'))
    const { pdf, getPage } = documentWithPages(['term', brokenPage, 'term'])
    const { result } = setup(pdf)
    act(() => result.current.updateQuery('term'))
    await act(async () => { await result.current.run() })
    expect(result.current.matches.map((match) => match.page)).toEqual([1, 3])
    expect(result.current.failedPages).toBe(1)
    expect(result.current.error).toBe('Search failed')
    expect(result.current.completed).toBe(true)
    await act(async () => { await result.current.run() })
    expect(result.current.matches).toHaveLength(3)
    expect(result.current.error).toBeNull()
    expect(result.current.failedPages).toBe(0)
    expect(getPage).toHaveBeenCalledTimes(4)
  })

  it('does not describe a failed scan as no results', async () => {
    const { pdf } = documentWithPages([async () => { throw new Error('failure') }])
    const { result } = setup(pdf)
    act(() => result.current.updateQuery('term'))
    await act(async () => { await result.current.run() })
    expect(result.current.noResults).toBe(false)
    expect(result.current.error).toBe('Search failed')
  })

  it('ignores an old query resolving after a newer query has finished', async () => {
    const oldContent = deferred<TextContent>()
    const pageContent = vi.fn<() => Promise<TextContent>>()
      .mockImplementationOnce(() => oldContent.promise)
      .mockResolvedValue(content('new'))
    const { pdf } = documentWithPages([pageContent])
    const { result, navigateToPage } = setup(pdf)
    act(() => result.current.updateQuery('old'))
    let pending!: Promise<void>
    act(() => { pending = result.current.run() })
    await waitFor(() => expect(pageContent).toHaveBeenCalledTimes(1))
    act(() => result.current.updateQuery('new'))
    await act(async () => { await result.current.run() })
    await act(async () => {
      oldContent.resolve(content('old old'))
      await pending
    })
    expect(result.current.query).toBe('new')
    expect(result.current.matches).toHaveLength(1)
    expect(result.current.completed).toBe(true)
    expect(navigateToPage).toHaveBeenCalledTimes(1)
  })

  it('cancels an in-flight scan without losing results that were already usable', async () => {
    const lastPage = deferred<TextContent>()
    const { pdf } = documentWithPages(['term', () => lastPage.promise])
    const { result, navigateToPage } = setup(pdf)
    act(() => result.current.updateQuery('term'))
    let pending!: Promise<void>
    act(() => { pending = result.current.run() })
    await waitFor(() => expect(result.current.matches).toHaveLength(1))
    act(() => result.current.cancel())
    await act(async () => {
      lastPage.resolve(content('term term'))
      await pending
    })
    expect(result.current.searching).toBe(false)
    expect(result.current.completed).toBe(false)
    expect(result.current.matches).toHaveLength(1)
    expect(navigateToPage).toHaveBeenCalledTimes(1)
  })

  it('discards an old document scan and invalidates its cache when the PDF proxy changes', async () => {
    const first = documentWithPages(['first'])
    const second = documentWithPages(['second'])
    const { result, rerender } = setup(first.pdf)
    act(() => result.current.updateQuery('first'))
    await act(async () => { await result.current.run() })
    rerender({ document: second.pdf, key: 'first' })
    expect(result.current.matches).toEqual([])
    expect(result.current.query).toBe('')
    act(() => result.current.updateQuery('second'))
    await act(async () => { await result.current.run() })
    expect(result.current.matches).toHaveLength(1)
    expect(second.getPage).toHaveBeenCalledTimes(1)
  })

  it('keeps highlight indices aligned to text items when marked content is present', async () => {
    const text = content('term')
    text.items = [{ type: 'beginMarkedContent', id: 'marked' }, text.items[0] as TextItem]
    const { pdf } = documentWithPages([async () => text])
    const { result } = setup(pdf)
    act(() => result.current.updateQuery('term'))
    await act(async () => { await result.current.run() })
    expect(result.current.matches[0].fragments).toEqual([{ itemIndex: 0, start: 0, end: 4 }])
  })

  it('stops before requesting page text if the reader unmounts while loading a page', async () => {
    const page = deferred<PDFPageProxy>()
    const getTextContent = vi.fn(async () => content('term'))
    const pdf = { numPages: 1, getPage: vi.fn(() => page.promise) } as unknown as PDFDocumentProxy
    const { result, unmount, navigateToPage } = setup(pdf)
    act(() => result.current.updateQuery('term'))
    let pending!: Promise<void>
    act(() => { pending = result.current.run() })
    unmount()
    await act(async () => {
      page.resolve({ getTextContent } as unknown as PDFPageProxy)
      await pending
    })
    expect(getTextContent).not.toHaveBeenCalled()
    expect(navigateToPage).not.toHaveBeenCalled()
  })
})
