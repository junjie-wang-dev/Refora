import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, TextItem } from 'pdfjs-dist/types/src/display/api'
import {
  findPdfPageMatches,
  normalizePdfSearchQuery,
  searchablePdfPage,
  type PdfSearchMatch,
  type SearchablePdfPage
} from '../utils/pdfSearchText'

export type { PdfSearchFragment, PdfSearchMatch } from '../utils/pdfSearchText'

interface PdfSearchOptions {
  pdf: PDFDocumentProxy | null
  cacheKey: string
  failureMessage: string
  navigateToPage: (page: number) => void
}

export function usePdfSearch({
  pdf,
  cacheKey,
  failureMessage,
  navigateToPage
}: PdfSearchOptions) {
  const [query, setQuery] = useState('')
  const [queryRevision, setQueryRevision] = useState(0)
  const [searching, setSearching] = useState(false)
  const [matches, setMatches] = useState<PdfSearchMatch[]>([])
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState(false)
  const [pagesSearched, setPagesSearched] = useState(0)
  const [failedPages, setFailedPages] = useState(0)
  const generationRef = useRef(0)
  const preferredPageRef = useRef<number | undefined>(undefined)
  const textCacheRef = useRef<{
    key: string
    pdf: PDFDocumentProxy | null
    pages: Map<number, SearchablePdfPage>
  }>({ key: '', pdf: null, pages: new Map() })

  useEffect(() => {
    generationRef.current += 1
    if (textCacheRef.current.key !== cacheKey || textCacheRef.current.pdf !== pdf) {
      textCacheRef.current = { key: cacheKey, pdf, pages: new Map() }
    }
    setQuery('')
    preferredPageRef.current = undefined
    setMatches([])
    setIndex(0)
    setError(null)
    setSearching(false)
    setCompleted(false)
    setPagesSearched(0)
    setFailedPages(0)
    return () => { generationRef.current += 1 }
  }, [cacheKey, pdf])

  const cancel = useCallback(() => {
    generationRef.current += 1
    setSearching(false)
    setCompleted(false)
  }, [])

  const updateQuery = useCallback((value: string, preferredPage?: number) => {
    generationRef.current += 1
    preferredPageRef.current = preferredPage
    setQuery(value)
    setQueryRevision((revision) => revision + 1)
    setMatches([])
    setIndex(0)
    setSearching(false)
    setError(null)
    setCompleted(false)
    setPagesSearched(0)
    setFailedPages(0)
  }, [])

  const run = useCallback(async () => {
    const generation = ++generationRef.current
    const normalizedQuery = normalizePdfSearchQuery(query)
    setMatches([])
    setIndex(0)
    setError(null)
    setCompleted(false)
    setPagesSearched(0)
    setFailedPages(0)
    if (!pdf || !normalizedQuery) {
      setSearching(false)
      return
    }
    setSearching(true)
    if (textCacheRef.current.key !== cacheKey || textCacheRef.current.pdf !== pdf) {
      textCacheRef.current = { key: cacheKey, pdf, pages: new Map() }
    }
    const pageTextCache = textCacheRef.current.pages
    const nextMatches: PdfSearchMatch[] = []
    let failures = 0
    const preferredPage = preferredPageRef.current
    const pageNumbers = Array.from({ length: pdf.numPages }, (_, pageIndex) => pageIndex + 1)
    if (preferredPage !== undefined && Number.isInteger(preferredPage) &&
      preferredPage >= 1 && preferredPage <= pdf.numPages) {
      pageNumbers.splice(preferredPage - 1, 1)
      pageNumbers.unshift(preferredPage)
    }
    try {
      for (const [pageIndex, pageNumber] of pageNumbers.entries()) {
        if (generationRef.current !== generation) return
        const previousMatchCount = nextMatches.length
        try {
          let cached = pageTextCache.get(pageNumber)
          if (!cached) {
            const page = await pdf.getPage(pageNumber)
            if (generationRef.current !== generation) return
            const content = await page.getTextContent()
            if (generationRef.current !== generation) return
            cached = searchablePdfPage(content.items.filter((item): item is TextItem => 'str' in item))
            pageTextCache.set(pageNumber, cached)
          }
          nextMatches.push(...findPdfPageMatches(pageNumber, cached, normalizedQuery))
        } catch {
          if (generationRef.current !== generation) return
          failures += 1
          setFailedPages(failures)
          setError(failureMessage)
        }
        setPagesSearched(pageIndex + 1)
        if (nextMatches.length > previousMatchCount) {
          setMatches([...nextMatches])
          if (previousMatchCount === 0) navigateToPage(nextMatches[0].page)
        }
        if (pageNumber % 8 === 0 || (previousMatchCount === 0 && nextMatches.length > 0)) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
        }
      }
      if (generationRef.current !== generation) return
      setCompleted(true)
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

  return {
    query, queryRevision, searching, matches, index, error, completed, pagesSearched, failedPages,
    noResults: completed && matches.length === 0 && failedPages === 0,
    updateQuery, run, cycle, cancel
  }
}
