import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from '@phosphor-icons/react'

import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import { MARKDOWN_COMPONENTS, REMARK_PLUGINS, REHYPE_PLUGINS } from '../../utils/markdown'
import MarkdownSearchControls from './MarkdownSearchControls'

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
  searchContainer?: HTMLElement | null
  compact?: boolean
  sourceOutline?: boolean
  onNavigate?: (offset: number) => void
}

export default function MarkdownNavigation({ articleRef, content, findOpen, outlineOpen, onCloseFind, onCloseOutline, onNavigate, searchContainer, compact = true, sourceOutline = false }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [headings, setHeadings] = useState<Heading[]>([])
  const [matches, setMatches] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const sourceRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const article = sourceOutline ? sourceRef.current : articleRef.current
    setHeadings(article ? Array.from(article.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')).filter((heading) => !heading.closest('.sr-only') && (sourceOutline || !heading.closest('[hidden]'))).map((heading) => ({
      id: heading.id,
      text: heading.textContent ?? '',
      level: Number(heading.tagName.slice(1)),
      offset: Number(heading.dataset.sourceOffset ?? 0)
    })).filter((heading) => heading.text) : [])
  }, [articleRef, content, outlineOpen, sourceOutline])

  useEffect(() => {
    if (findOpen && compact) inputRef.current?.focus()
  }, [findOpen, compact])

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

  const search = <MarkdownSearchControls inputRef={inputRef} query={query} total={matches.length} index={index} label={t('markdown.findDocument')} previousLabel={t('markdown.previousMatch')} nextLabel={t('markdown.nextMatch')} closeLabel={t('markdown.closeFind')} onQueryChange={setQuery} onNavigate={navigate} closable={compact} onClose={() => { onCloseFind(); inputRef.current?.blur() }} />

  return <>
    {sourceOutline && outlineOpen && <div ref={sourceRef} hidden><ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS} allowedElements={['h1', 'h2', 'h3', 'h4', 'h5', 'h6']} unwrapDisallowed>{content}</ReactMarkdown></div>}
    {findOpen && (searchContainer ? createPortal(search, searchContainer) : search)}
    {outlineOpen && <nav className={`markdown-outline ${compact ? 'is-overlay' : ''}`} aria-label={t('markdown.outline')}>
      <div className="markdown-outline-title"><strong>{t('markdown.outline')}</strong><button type="button" aria-label={t('markdown.closeOutline')} onClick={onCloseOutline}><X size={16} /></button></div>
      {headings.length ? headings.map((heading) => <button key={heading.id} type="button" style={{ paddingInlineStart: `${12 + (heading.level - 1) * 12}px` }} onClick={() => {
        const target = Array.from(articleRef.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find((element) => element.id === heading.id)
        if (!sourceOutline) target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
        onNavigate?.(heading.offset)
        if (compact) onCloseOutline()
      }}>{heading.text}</button>) : <p>{t('markdown.noHeadings')}</p>}
    </nav>}
  </>
}
