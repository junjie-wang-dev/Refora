import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import hljs from 'highlight.js/lib/core'
import latex from 'highlight.js/lib/languages/latex'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'

import MarkdownSearchControls from '../markdown/MarkdownSearchControls'
import '../markdown/markdownWorkspace.css'

hljs.registerLanguage('latex', latex)

export interface LatexSourceHandle {
  focus: () => void
  revealLine: (line: number) => void
  insert: (text: string) => void
  openFind: () => void
  closeFind: () => void
}
interface Props {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  searchContainer?: HTMLDivElement | null
  onSearchFocus?: () => void
  onPositionChange?: (line: number, column: number) => void
}

const LatexSourceEditor = forwardRef<LatexSourceHandle, Props>(function LatexSourceEditor({ value, onChange, disabled = false, searchContainer, onSearchFocus, onPositionChange }, ref) {
  const { t } = useTranslation()
  const input = useRef<HTMLTextAreaElement>(null)
  const highlights = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [find, setFind] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [line, setLine] = useState(1)
  const [matchIndex, setMatchIndex] = useState(-1)
  const html = useMemo(() => hljs.highlight(value, { language: 'latex' }).value, [value])
  const lines = useMemo(() => value.split('\n'), [value])
  const matches = useMemo(() => {
    const result: number[] = []
    if (!query) return result
    let offset = value.indexOf(query)
    while (offset >= 0) { result.push(offset); offset = value.indexOf(query, offset + query.length) }
    return result
  }, [query, value])
  const selection = useRef({ start: 0, end: 0 })
  const syncScroll = () => {
    if (!input.current) return
    if (highlights.current) { highlights.current.scrollTop = input.current.scrollTop; highlights.current.scrollLeft = input.current.scrollLeft }
    if (gutter.current) gutter.current.scrollTop = input.current.scrollTop
  }
  const notifyPosition = () => {
    if (!input.current) return
    const { selectionStart: start, selectionEnd: end } = input.current
    selection.current = { start, end }
    const before = input.current.value.slice(0, start)
    const currentLine = before.split('\n').length
    setLine(currentLine)
    onPositionChange?.(currentLine, start - before.lastIndexOf('\n'))
  }
  const reveal = (start: number, end = start) => {
    const textarea = input.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(start, end)
    textarea.scrollTop = Math.max(0, textarea.value.slice(0, start).split('\n').length * 23 - textarea.clientHeight / 3)
    syncScroll()
    notifyPosition()
  }
  const closeFind = () => { setFind(false); setQuery(''); setMatchIndex(-1); setReplaceOpen(false); input.current?.focus() }
  const openFind = () => { setFind(true); onSearchFocus?.(); requestAnimationFrame(() => search.current?.focus()) }
  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    revealLine: (target) => reveal(lines.slice(0, Math.max(0, target - 1)).reduce((sum, text) => sum + text.length + 1, 0)),
    insert: (text) => {
      let { start, end } = selection.current
      if (start !== end) {
        const nextLine = value.indexOf('\n', end)
        start = end = nextLine < 0 ? value.length : nextLine + 1
      }
      const closing = value.lastIndexOf('\\end{document}')
      const opening = value.indexOf('\\begin{document}')
      if (start === end && (start === 0 || (closing >= 0 && (start >= closing || start < opening)))) {
        start = end = closing >= 0 ? closing : value.length
      }
      onChange(value.slice(0, start) + text + value.slice(end))
      requestAnimationFrame(() => reveal(start + text.length))
    },
    openFind,
    closeFind
  }))
  const selectMatch = (direction: number) => {
    if (!matches.length) return
    const keepSearchFocus = document.activeElement === search.current
    const index = matchIndex < 0 ? direction > 0 ? 0 : matches.length - 1 : (matchIndex + direction + matches.length) % matches.length
    setMatchIndex(index)
    reveal(matches[index], matches[index] + query.length)
    if (keepSearchFocus) search.current?.focus()
  }
  const searchControls = <div className="latex-find" data-query={Boolean(query) || undefined} onFocusCapture={onSearchFocus}>
      <div className="latex-find-row"><button type="button" className="latex-icon-button" aria-label={t('latex.toggleReplace')} aria-expanded={replaceOpen} onClick={() => setReplaceOpen(!replaceOpen)}>{replaceOpen ? <CaretDown size={14} /> : <CaretRight size={14} />}</button><MarkdownSearchControls inputRef={search} inputPlaceholder={t('latex.find')} query={query} total={matches.length} index={Math.min(matchIndex, Math.max(0, matches.length - 1))} label={t('latex.find')} previousLabel={t('latex.previousMatch')} nextLabel={t('latex.next')} closeLabel={t('common.close')} onQueryChange={(next) => { setQuery(next); setMatchIndex(-1) }} onNavigate={selectMatch} onClose={closeFind} closable={!searchContainer} /></div>
      {replaceOpen && <div className="latex-replace-row"><input aria-label={t('latex.replacement')} placeholder={t('latex.replacement')} value={replacement} onChange={(event) => setReplacement(event.target.value)} /><button type="button" className="latex-text-button" disabled={!query || disabled} onClick={() => onChange(value.split(query).join(replacement))}>{t('latex.replaceAll')}</button></div>}
    </div>
  return <div className="latex-source" onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); openFind() }
    if (event.key === 'Escape' && find) { event.preventDefault(); event.stopPropagation(); closeFind() }
  }}>
    {searchContainer ? createPortal(searchControls, searchContainer) : find && searchControls}
    <div className="latex-source-body"><div ref={gutter} className="latex-line-numbers" aria-hidden="true">{lines.map((_, index) => <span key={index} data-active={line === index + 1}>{index + 1}</span>)}</div><div className="latex-source-stack">
      <pre aria-hidden="true" ref={highlights} className="latex-highlight"><code dangerouslySetInnerHTML={{ __html: html + '\n' }} /></pre>
      <textarea ref={input} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} aria-label={t('latex.source')} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" onSelect={notifyPosition} onKeyUp={notifyPosition} onClick={notifyPosition} onScroll={syncScroll} onKeyDown={(event) => {
        if (event.key === 'Tab') {
          event.preventDefault()
          const textarea = event.currentTarget
          const start = textarea.selectionStart
          const end = textarea.selectionEnd
          if (event.shiftKey || value.slice(start, end).includes('\n')) {
            const lineStart = value.lastIndexOf('\n', start - 1) + 1
            const block = value.slice(lineStart, end)
            const modified = block.split('\n').map((text) => event.shiftKey ? text.replace(/^ {1,2}|^\t/, '') : '  ' + text).join('\n')
            onChange(value.slice(0, lineStart) + modified + value.slice(end))
            requestAnimationFrame(() => textarea.setSelectionRange(lineStart, lineStart + modified.length))
          } else {
            onChange(value.slice(0, start) + '  ' + value.slice(end))
            requestAnimationFrame(() => textarea.setSelectionRange(start + 2, start + 2))
          }
        }
      }} />
    </div></div>
  </div>
})
export default LatexSourceEditor
