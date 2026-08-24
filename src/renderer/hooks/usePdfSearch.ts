import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'

export interface PdfSearchFragment {
  itemIndex: number
  start: number
  end: number
}

export interface PdfSearchMatch {
  page: number
  fragments: PdfSearchFragment[]
}

interface CachedPageText {
  items: string[]
  text: string
  offsets: number[]
}

interface PdfSearchOptions {
  pdf: PDFDocumentProxy | null
  cacheKey: string
  failureMessage: string
  navigateToPage: (page: number) => void
}

function searchablePage(items: string[]): CachedPageText {
  const offsets: number[] = []
  let text = ''
  items.forEach((item, index) => {
    if (index > 0) text += ' '
    offsets.push(text.length)
    text += item
  })
  return { items, text: text.toLocaleLowerCase(), offsets }
}

function pageMatches(page: number, cached: CachedPageText, query: string): PdfSearchMatch[] {
  const matches: PdfSearchMatch[] = []
  let matchStart = cached.text.indexOf(query)
  while (matchStart >= 0) {
    const matchEnd = matchStart + query.length
    const fragments = cached.items.flatMap((item, itemIndex) => {
      const itemStart = cached.offsets[itemIndex]
      const itemEnd = itemStart + item.length
      const start = Math.max(matchStart, itemStart)
      const end = Math.min(matchEnd, itemEnd)
      return end > start
        ? [{ itemIndex, start: start - itemStart, end: end - itemStart }]
        : []
    })
    if (fragments.length > 0) matches.push({ page, fragments })
    matchStart = cached.text.indexOf(query, Math.max(matchEnd, matchStart + 1))
  }
  return matches
}

export function usePdfSearch({
  pdf,
  cacheKey,
  failureMessage,
  navigateToPage
}: PdfSearchOptions) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [matches, setMatches] = useState<PdfSearchMatch[]>([])
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const textCacheRef = useRef({ key: '', pages: new Map<number, CachedPageText>() })

  useEffect(() => () => {
    generationRef.current += 1
  }, [pdf])

  useEffect(() => {
    generationRef.current += 1
    setQuery('')
    setMatches([])
    setIndex(0)
    setError(null)
    setSearching(false)
  }, [cacheKey])

  const cancel = useCallback(() => {
    generationRef.current += 1
    setSearching(false)
  }, [])

  const updateQuery = useCallback((value: string) => {
    generationRef.current += 1
    setQuery(value)
    setMatches([])
    setIndex(0)
    setSearching(false)
    setError(null)
  }, [])

  const run = useCallback(async () => {
    const generation = ++generationRef.current
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!pdf || !normalizedQuery) {
      setMatches([])
      setIndex(0)
      setError(null)
      setSearching(false)
      return
    }
    setSearching(true)
    setError(null)
    if (textCacheRef.current.key !== cacheKey) {
      textCacheRef.current = { key: cacheKey, pages: new Map() }
    }
    const pageTextCache = textCacheRef.current.pages
    const nextMatches: PdfSearchMatch[] = []
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        let cached = pageTextCache.get(pageNumber)
        if (!cached) {
          const page = await pdf.getPage(pageNumber)
          const content = await page.getTextContent()
          if (generationRef.current !== generation) return
          cached = searchablePage(
            content.items.map((item) => 'str' in item ? item.str : '')
          )
          pageTextCache.set(pageNumber, cached)
        }
        nextMatches.push(...pageMatches(pageNumber, cached, normalizedQuery))
      }
      if (generationRef.current !== generation) return
      setMatches(nextMatches)
      setIndex(0)
      if (nextMatches[0]) navigateToPage(nextMatches[0].page)
    } catch {
      if (generationRef.current !== generation) return
      setMatches([])
      setIndex(0)
      setError(failureMessage)
    } finally {
      if (generationRef.current === generation) setSearching(false)
    }
  }, [cacheKey, failureMessage, navigateToPage, pdf, query])

  const cycle = useCallback((direction: number) => {
    if (matches.length === 0) return
    const nextIndex = (index + direction + matches.length) % matches.length
    setIndex(nextIndex)
    navigateToPage(matches[nextIndex].page)
  }, [index, matches, navigateToPage])

  return { query, searching, matches, index, error, updateQuery, run, cycle, cancel }
}
