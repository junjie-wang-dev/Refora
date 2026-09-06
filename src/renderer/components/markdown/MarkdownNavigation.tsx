import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { CaretDown, CaretUp, X } from '@phosphor-icons/react'

interface Heading {
  id: string
  text: string
  level: number
  offset: number
}

interface Props {
  articleRef: RefObject<HTMLElement | null>
  content: string
  findOpen: boolean
  outlineOpen: boolean
  onCloseFind: () => void
  onCloseOutline: () => void
  onNavigate?: (offset: number) => void
}

export default function MarkdownNavigation({ articleRef, content, findOpen, outlineOpen, onCloseFind, onCloseOutline, onNavigate }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [headings, setHeadings] = useState<Heading[]>([])
  const [matches, setMatches] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const article = articleRef.current
    setHeadings(article ? Array.from(article.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')).filter((heading) => !heading.closest('[hidden], .sr-only')).map((heading) => ({
      id: heading.id,
      text: heading.textContent ?? '',
      level: Number(heading.tagName.slice(1)),
      offset: Number(heading.dataset.sourceOffset ?? 0)
    })).filter((heading) => heading.text) : [])
  }, [articleRef, content, outlineOpen])

  useEffect(() => {
    if (findOpen) inputRef.current?.focus()
  }, [findOpen])

  useEffect(() => {
    const article = articleRef.current
    if (!article || !findOpen || !query) {
      setMatches([])
      return
    }
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => (node instanceof Element ? node : node.parentElement)?.closest('button:not([data-markdown-searchable]), .markdown-format-toolbar, .markdown-format-button, .katex-mathml, script, style, [aria-hidden="true"], [hidden], .sr-only')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    })
    const chunks: Array<{ node: Text; start: number; end: number }> = []
    let text = ''
    let previousBlock: Element | null = null
    let node: Node | null
    while ((node = walker.nextNode())) {
      if (node instanceof Element) {
        if (node.tagName === 'BR') text += '\n'
        continue
      }
      const value = node.textContent ?? ''
      if (!value) continue
      const block = node.parentElement?.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote, div') ?? null
      if (block !== previousBlock && text && !text.endsWith('\n')) text += '\n'
      previousBlock = block
      chunks.push({ node: node as Text, start: text.length, end: text.length + value.length })
      text += value
    }
    const ranges: Range[] = []
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null && ranges.length < 2000) {
      const offset = match.index
      const start = chunks.find((chunk) => chunk.start <= offset && chunk.end > offset)
      const endOffset = offset + match[0].length
      const end = chunks.find((chunk) => chunk.start < endOffset && chunk.end >= endOffset)
      if (start && end) {
        const range = document.createRange()
        range.setStart(start.node, offset - start.start)
        range.setEnd(end.node, endOffset - end.start)
        ranges.push(range)
      }
    }
    setMatches(ranges)
    setIndex(0)
  }, [articleRef, content, findOpen, query])

  useEffect(() => {
    if (!findOpen) return
    const highlights = globalThis.CSS?.highlights
    const all = typeof Highlight !== 'undefined' ? new Highlight(...matches) : undefined
    const active = typeof Highlight !== 'undefined' ? new Highlight(...(matches[index] ? [matches[index]] : [])) : undefined
    if (highlights && all && active) {
      highlights.set('markdown-find', all)
      highlights.set('markdown-find-active', active)
    }
    matches[index]?.startContainer.parentElement?.scrollIntoView?.({ block: 'center' })
    return () => {
      if (highlights?.get('markdown-find') === all) highlights?.delete('markdown-find')
      if (highlights?.get('markdown-find-active') === active) highlights?.delete('markdown-find-active')
    }
  }, [findOpen, index, matches])

  const navigate = (direction: number) => {
    if (matches.length) setIndex((current) => (current + direction + matches.length) % matches.length)
  }

  return <>
    {findOpen && <div className="markdown-find-bar" role="search" aria-label={t('markdown.findDocument')}>
      <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('markdown.findDocument')} placeholder={t('markdown.findDocument')} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCloseFind() }
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); navigate(event.shiftKey ? -1 : 1) }
      }} />
      <span role="status">{query ? t('markdown.matchCount', { current: matches.length ? index + 1 : 0, total: matches.length }) : ''}</span>
      <button type="button" disabled={!matches.length} aria-label={t('markdown.previousMatch')} onClick={() => navigate(-1)}><CaretUp size={16} /></button>
      <button type="button" disabled={!matches.length} aria-label={t('markdown.nextMatch')} onClick={() => navigate(1)}><CaretDown size={16} /></button>
      <button type="button" aria-label={t('markdown.closeFind')} onClick={onCloseFind}><X size={16} /></button>
    </div>}
    {outlineOpen && <nav className="markdown-outline" aria-label={t('markdown.outline')}>
      <div className="markdown-outline-title"><strong>{t('markdown.outline')}</strong><button type="button" aria-label={t('markdown.closeOutline')} onClick={onCloseOutline}><X size={16} /></button></div>
      {headings.length ? headings.map((heading) => <button key={heading.id} type="button" style={{ paddingInlineStart: `${12 + (heading.level - 1) * 12}px` }} onClick={() => {
        const target = Array.from(articleRef.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find((element) => element.id === heading.id)
        target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
        onNavigate?.(heading.offset)
      }}>{heading.text}</button>) : <p>{t('markdown.noHeadings')}</p>}
    </nav>}
  </>
}
