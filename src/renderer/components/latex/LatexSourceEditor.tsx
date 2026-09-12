import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/core'
import latex from 'highlight.js/lib/languages/latex'
import { ArrowDown, ArrowUp, CaretDown, CaretRight, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'

hljs.registerLanguage('latex', latex)

export interface LatexSourceHandle {
  focus: () => void
  revealLine: (line: number) => void
  insert: (text: string) => void
  openFind: () => void
}
interface Props {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  onPositionChange?: (line: number, column: number) => void
}

const LatexSourceEditor = forwardRef<LatexSourceHandle, Props>(function LatexSourceEditor({ value, onChange, disabled = false, onPositionChange }, ref) {
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
  const [matchIndex, setMatchIndex] = useState(0)
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
  const openFind = () => { setFind(true); requestAnimationFrame(() => search.current?.focus()) }
  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    revealLine: (target) => reveal(lines.slice(0, Math.max(0, target - 1)).reduce((sum, text) => sum + text.length + 1, 0)),
    insert: (text) => {
      let { start, end } = selection.current
      const closing = value.lastIndexOf('\\end{document}')
      const opening = value.indexOf('\\begin{document}')
      if (start === end && (start === 0 || (closing >= 0 && (start >= closing || start < opening)))) {
        start = end = closing >= 0 ? closing : value.length
      }
      onChange(value.slice(0, start) + text + value.slice(end))
      requestAnimationFrame(() => reveal(start + text.length))
    },
    openFind
  }))
  const selectMatch = (direction: number) => {
    if (!matches.length) return
    const caret = input.current?.selectionStart ?? 0
    let index = direction > 0 ? matches.findIndex((offset) => offset > caret) : matches.findLastIndex((offset) => offset < caret)
    if (index < 0) index = direction > 0 ? 0 : matches.length - 1
    setMatchIndex(index)
    reveal(matches[index], matches[index] + query.length)
  }
  return <div className="latex-source" onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); openFind() }
    if (event.key === 'Escape') { setFind(false); input.current?.focus() }
  }}>
    {find && <div className="latex-find">
      <div className="latex-find-row"><button type="button" className="latex-icon-button" aria-label={t('latex.toggleReplace')} aria-expanded={replaceOpen} onClick={() => setReplaceOpen(!replaceOpen)}>{replaceOpen ? <CaretDown size={14} /> : <CaretRight size={14} />}</button><label><MagnifyingGlass size={14} /><input ref={search} aria-label={t('latex.find')} placeholder={t('latex.find')} value={query} onChange={(event) => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); selectMatch(event.shiftKey ? -1 : 1) } }} /></label><span className="latex-match-count" role="status">{matches.length ? `${Math.min(matchIndex + 1, matches.length)}/${matches.length}` : '0/0'}</span><button type="button" className="latex-icon-button" aria-label={t('latex.previousMatch')} disabled={!matches.length} onClick={() => selectMatch(-1)}><ArrowUp size={14} /></button><button type="button" className="latex-icon-button" aria-label={t('latex.next')} disabled={!matches.length} onClick={() => selectMatch(1)}><ArrowDown size={14} /></button><button type="button" className="latex-icon-button" onClick={() => { setFind(false); input.current?.focus() }} aria-label={t('common.close')}><X size={15} /></button></div>
      {replaceOpen && <div className="latex-replace-row"><input aria-label={t('latex.replacement')} placeholder={t('latex.replacement')} value={replacement} onChange={(event) => setReplacement(event.target.value)} /><button type="button" className="latex-text-button" disabled={!query || disabled} onClick={() => onChange(value.split(query).join(replacement))}>{t('latex.replaceAll')}</button></div>}
    </div>}
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
