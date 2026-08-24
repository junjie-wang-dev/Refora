import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'

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
  const [searching, setSearching] = useState(false)
  const [pages, setPages] = useState<number[]>([])
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const textCacheRef = useRef({ key: '', pages: new Map<number, string>() })

  useEffect(() => () => {
    generationRef.current += 1
  }, [pdf])

  useEffect(() => {
    generationRef.current += 1
    setPages([])
    setIndex(0)
    setError(null)
    setSearching(false)
  }, [cacheKey])

  const updateQuery = useCallback((value: string) => {
    generationRef.current += 1
    setQuery(value)
    setSearching(false)
    setError(null)
  }, [])

  const run = useCallback(async () => {
    const generation = ++generationRef.current
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!pdf || !normalizedQuery) {
      setPages([])
      setError(null)
      return
    }
    setSearching(true)
    setError(null)
    const matches: number[] = []
    if (textCacheRef.current.key !== cacheKey) {
      textCacheRef.current = { key: cacheKey, pages: new Map() }
    }
    const pageTextCache = textCacheRef.current.pages
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        let text = pageTextCache.get(pageNumber)
        if (text === undefined) {
          const page = await pdf.getPage(pageNumber)
          const content = await page.getTextContent()
          if (generationRef.current !== generation) return
          text = content.items
            .map((item) => 'str' in item ? item.str : '')
            .join(' ')
            .toLocaleLowerCase()
          pageTextCache.set(pageNumber, text)
        }
        if (text.includes(normalizedQuery)) matches.push(pageNumber)
      }
      if (generationRef.current !== generation) return
      setPages(matches)
      setIndex(0)
      if (matches[0]) navigateToPage(matches[0])
    } catch {
      if (generationRef.current !== generation) return
      setPages([])
      setIndex(0)
      setError(failureMessage)
    } finally {
      if (generationRef.current === generation) setSearching(false)
    }
  }, [cacheKey, failureMessage, navigateToPage, pdf, query])

  const cycle = useCallback((direction: number) => {
    if (pages.length === 0) return
    const nextIndex = (index + direction + pages.length) % pages.length
    setIndex(nextIndex)
    navigateToPage(pages[nextIndex])
  }, [index, navigateToPage, pages])

  return { query, searching, pages, index, error, updateQuery, run, cycle }
}
