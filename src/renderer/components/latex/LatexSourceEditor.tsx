import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import hljs from 'highlight.js/lib/core'
import latex from 'highlight.js/lib/languages/latex'
import { ArrowUp, CaretDown, CaretRight, Eye } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'

import MarkdownSearchControls from '../markdown/MarkdownSearchControls'
import '../markdown/markdownWorkspace.css'

hljs.registerLanguage('latex', latex)

export interface LatexSourceHandle {
  focus: () => void
  getPosition: () => { line: number; column: number }
  revealLine: (line: number, select?: boolean) => void
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
  onAi?: (start: number, end: number, instruction?: string) => void
  onPositionChange?: (line: number, column: number) => void
}

const LatexSourceEditor = forwardRef<LatexSourceHandle, Props>(function LatexSourceEditor({ value, onChange, disabled = false, searchContainer, onSearchFocus, onPositionChange, onAi }, ref) {
  const { t } = useTranslation()
  const input = useRef<HTMLTextAreaElement>(null)
  const highlights = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [aiMenu, setAiMenu] = useState<{ start: number; end: number; x: number; y: number } | null>(null)
  const [instruction, setInstruction] = useState('')
  const aiMenuElement = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!aiMenu) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !aiMenuElement.current?.contains(event.target)) setAiMenu(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setAiMenu(null); input.current?.focus() }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape, true) }
  }, [aiMenu])
  useEffect(() => setAiMenu(null), [value, disabled])
  const showAiMenu = (x?: number, y?: number) => {
    const textarea = input.current
    if (!onAi || disabled || !textarea || textarea.selectionStart === textarea.selectionEnd) { setAiMenu(null); return }
    const rect = textarea.getBoundingClientRect()
    setInstruction('')
    setAiMenu({ start: textarea.selectionStart, end: textarea.selectionEnd, x: Math.max(8, Math.min(x ?? rect.left + 30, window.innerWidth - 330)), y: Math.max(8, Math.min(y ?? rect.top + 50, window.innerHeight - 140)) })
  }
  const requestAi = (custom?: string) => {
    if (!aiMenu) return
    onAi?.(aiMenu.start, aiMenu.end, custom)
    setAiMenu(null)
  }
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
    getPosition: () => {
      const start = input.current?.selectionStart ?? 0
      const before = value.slice(0, start)
      return { line: before.split('\n').length, column: start - before.lastIndexOf('\n') }
    },
    revealLine: (target, select = false) => {
      const index = Math.max(0, Math.min(lines.length - 1, target - 1))
      const start = lines.slice(0, index).reduce((sum, text) => sum + text.length + 1, 0)
      reveal(start, select ? start + lines[index].length : start)
    },
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
    {aiMenu && createPortal(<div ref={aiMenuElement} className="latex-ai-selection-menu" role="dialog" aria-label={t('latex.aiSelection')} style={{ left: aiMenu.x, top: aiMenu.y }} onMouseDown={event => event.stopPropagation()}>
      <button type="button" className="latex-ai-proofread" onClick={() => requestAi()}><Eye size={19} />{t('latex.proofread')}</button>
      <form onSubmit={event => { event.preventDefault(); if (instruction.trim()) requestAi(instruction.trim()) }}><input aria-label={t('latex.editWithAi')} placeholder={t('latex.editWithAi')} value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={4000} /><button type="submit" aria-label={t('latex.sendAiEdit')} disabled={!instruction.trim()}><ArrowUp size={20} /></button></form>
    </div>, document.body)}
    {searchContainer ? createPortal(searchControls, searchContainer) : find && searchControls}
    <div className="latex-source-body"><div ref={gutter} className="latex-line-numbers" aria-hidden="true">{lines.map((_, index) => <span key={index} data-active={line === index + 1}>{index + 1}</span>)}</div><div className="latex-source-stack">
      <pre aria-hidden="true" ref={highlights} className="latex-highlight"><code dangerouslySetInnerHTML={{ __html: html + '\n' }} /></pre>
      <textarea ref={input} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} aria-label={t('latex.source')} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" onSelect={notifyPosition} onKeyUp={(event) => { notifyPosition(); if (event.shiftKey || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a')) showAiMenu() }} onMouseUp={(event) => showAiMenu(event.clientX, event.clientY + 12)} onContextMenu={(event) => { if (onAi && event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) { event.preventDefault(); event.stopPropagation(); showAiMenu(event.clientX, event.clientY) } }} onClick={notifyPosition} onScroll={() => { syncScroll(); setAiMenu(null) }} onKeyDown={(event) => {
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
