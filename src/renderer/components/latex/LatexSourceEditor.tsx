import { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import hljs from 'highlight.js/lib/core'
import latex from 'highlight.js/lib/languages/latex'
import { ArrowUp, CaretDown, CaretRight, Check, Eye, SlidersHorizontal, TextAlignLeft } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'

import MarkdownSearchControls from '../markdown/MarkdownSearchControls'
import '../markdown/markdownWorkspace.css'
import './latexSource.css'

hljs.registerLanguage('latex', latex)

export interface LatexSourceHandle {
  focus: () => void
  getPosition: () => { line: number; column: number }
  revealLine: (line: number, select?: boolean) => void
  insert: (text: string) => void
  openFind: () => void
  closeFind: () => void
}
interface Snapshot { value: string; start: number; end: number }
interface Session { snapshot: Snapshot; undo: Snapshot[]; redo: Snapshot[]; top: number; left: number; query: string; replacement: string; find: boolean; replaceOpen: boolean; matchCase: boolean; wholeWord: boolean; regex: boolean; wrap: boolean }
const sessions = new Map<string, Session>()

interface Props {
  sessionKey?: string
  projectSources?: string[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  searchContainer?: HTMLDivElement | null
  statusContainer?: HTMLDivElement | null
  onSearchFocus?: () => void
  onAi?: (start: number, end: number, instruction?: string) => void
  onPositionChange?: (line: number, column: number) => void
}

const LatexSourceEditor = forwardRef<LatexSourceHandle, Props>(function LatexSourceEditor({ value, onChange, disabled = false, searchContainer, statusContainer, onSearchFocus, onPositionChange, onAi, sessionKey, projectSources = [] }, ref) {
  const { t } = useTranslation()
  const input = useRef<HTMLTextAreaElement>(null)
  const highlights = useRef<HTMLPreElement>(null)
  const selectionLayer = useRef<HTMLPreElement>(null)
  const [focused, setFocused] = useState(false)
  const [retainedSelection, setRetainedSelection] = useState({ start: 0, end: 0, value })
  const gutter = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const [lineHeights, setLineHeights] = useState<number[]>([])
  const search = useRef<HTMLInputElement>(null)
  const replacementInput = useRef<HTMLInputElement>(null)
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
  const saved = useRef(sessionKey ? sessions.get(sessionKey) : undefined).current
  const history = useRef({ undo: saved?.snapshot.value === value ? saved.undo : [], redo: saved?.snapshot.value === value ? saved.redo : [] })
  const previous = useRef<Snapshot>({ value, start: saved?.snapshot.start ?? 0, end: saved?.snapshot.end ?? 0 })
  const ownEdit = useRef(false)
  const [wrap, setWrap] = useState(saved?.wrap ?? true)
  const [matchCase, setMatchCase] = useState(saved?.matchCase ?? false)
  const [wholeWord, setWholeWord] = useState(saved?.wholeWord ?? false)
  const [regex, setRegex] = useState(saved?.regex ?? false)
  const [scope, setScope] = useState<{ start: number; end: number } | null>(null)
  const [completion, setCompletion] = useState<{ start: number; end: number; options: string[] } | null>(null)
  const pushUndo = (snapshot: Snapshot) => {
    history.current.undo.push(snapshot)
    while (history.current.undo.length > 100 || history.current.undo.reduce((total, entry) => total + entry.value.length, 0) > 4_000_000 && history.current.undo.length > 1) history.current.undo.shift()
    history.current.redo = []
  }
  const change = (next: string, start = input.current?.selectionStart ?? 0, end = start) => {
    if (disabled || next === value) return
    pushUndo({ value, start: selection.current.start, end: selection.current.end })
    ownEdit.current = true
    previous.current = { value: next, start, end }
    onChange(next)
    requestAnimationFrame(() => { input.current?.setSelectionRange(start, end); notifyPosition() })
  }
  const [replaceOpen, setReplaceOpen] = useState(saved?.replaceOpen ?? false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsPanel = useRef<HTMLDivElement>(null)
  const optionsButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!optionsOpen && !replaceOpen) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !optionsPanel.current?.contains(event.target) && !optionsButton.current?.contains(event.target)) { setOptionsOpen(false); setReplaceOpen(false) }
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOptionsOpen(false); optionsButton.current?.focus() } }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [optionsOpen, replaceOpen])
  const [query, setQuery] = useState(saved?.query ?? '')
  const [replacement, setReplacement] = useState(saved?.replacement ?? '')
  const [find, setFind] = useState(saved?.find ?? false)
  const [line, setLine] = useState(1)
  const [matchIndex, setMatchIndex] = useState(-1)
  const [highlightValue, setHighlightValue] = useState(value)
  useEffect(() => { const timer = window.setTimeout(() => setHighlightValue(value), 100); return () => window.clearTimeout(timer) }, [value])
  const html = useMemo(() => highlightValue.length < 200_000 ? hljs.highlight(highlightValue, { language: 'latex' }).value : '', [highlightValue])
  const lines = useMemo(() => value.split('\n'), [value])
  useLayoutEffect(() => {
    if (!wrap || !measure.current) return
    const update = () => setLineHeights(Array.from(measure.current?.children ?? []).map(child => child.getBoundingClientRect().height || 23))
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(measure.current)
    return () => observer?.disconnect()
  }, [value, wrap])
  const pattern = useMemo(() => {
    if (!query) return null
    try { return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi') } catch { return null }
  }, [query, regex, matchCase])
  const matches = useMemo(() => {
    if (!pattern) return []
    pattern.lastIndex = 0
    return [...value.matchAll(pattern)].filter(match => {
      const start = match.index
      const end = start + match[0].length
      return match[0].length > 0 && (!scope || start >= scope.start && end <= scope.end) && (!wholeWord || !/[\p{L}\p{N}_]/u.test(value[start - 1] ?? '') && !/[\p{L}\p{N}_]/u.test(value[end] ?? ''))
    }).map(match => ({ start: match.index, end: match.index + match[0].length, text: match[0] }))
  }, [pattern, value, scope, wholeWord])
  const selection = useRef({ start: saved?.snapshot.start ?? 0, end: saved?.snapshot.end ?? 0 })
  const syncScroll = () => {
    if (!input.current) return
    if (highlights.current) { highlights.current.scrollTop = input.current.scrollTop; highlights.current.scrollLeft = input.current.scrollLeft }
    if (selectionLayer.current) { selectionLayer.current.scrollTop = input.current.scrollTop; selectionLayer.current.scrollLeft = input.current.scrollLeft }
    if (gutter.current) gutter.current.scrollTop = input.current.scrollTop
  }
  const notifyPosition = () => {
    if (!input.current) return
    const { selectionStart: start, selectionEnd: end } = input.current
    setCompletion(current => current && (start !== end || end !== current.end) ? null : current)
    selection.current = { start, end }
    previous.current = { value: input.current.value, start, end }
    setRetainedSelection({ start, end, value: input.current.value })
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
    const targetLine = textarea.value.slice(0, start).split('\n').length - 1
    const offset = wrap ? lineHeights.slice(0, targetLine).reduce((sum, height) => sum + height, 0) : targetLine * 23
    textarea.scrollTop = Math.max(0, offset + 23 - textarea.clientHeight / 3)
    syncScroll()
    notifyPosition()
  }
  const closeFind = () => { setOptionsOpen(false); setFind(false); setQuery(''); setMatchIndex(-1); setReplaceOpen(false); input.current?.focus() }
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
      change(value.slice(0, start) + text + value.slice(end), start + text.length)
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
    reveal(matches[index].start, matches[index].end)
    if (keepSearchFocus) search.current?.focus()
  }
  useLayoutEffect(() => {
    if (saved && input.current) {
      input.current.setSelectionRange(saved.snapshot.start, saved.snapshot.end)
      input.current.scrollTop = saved.top
      input.current.scrollLeft = saved.left
      syncScroll()
      notifyPosition()
    }
  }, [saved])
  useLayoutEffect(() => {
    if (previous.current.value !== value && !ownEdit.current) {
      pushUndo(previous.current)
      input.current?.setSelectionRange(Math.min(previous.current.start, value.length), Math.min(previous.current.end, value.length))
      notifyPosition()
      setRetainedSelection({ start: 0, end: 0, value })
    }
    previous.current = { ...previous.current, value }
    ownEdit.current = false
  }, [value])
  const sessionState = useRef<Session | null>(null)
  useLayoutEffect(() => { sessionState.current = { snapshot: previous.current, ...history.current, top: input.current?.scrollTop ?? 0, left: input.current?.scrollLeft ?? 0, query, replacement, find, replaceOpen, matchCase, wholeWord, regex, wrap } })
  useLayoutEffect(() => () => {
    if (!sessionKey || !sessionState.current) return
    sessions.delete(sessionKey)
    sessions.set(sessionKey, { ...sessionState.current, snapshot: previous.current, ...history.current, top: input.current?.scrollTop ?? 0, left: input.current?.scrollLeft ?? 0 })
    while (sessions.size > 30) sessions.delete(sessions.keys().next().value!)
  }, [sessionKey])
  const replaceMatches = (all: boolean) => {
    const targets = all ? matches : matches.slice(Math.max(0, matchIndex), Math.max(0, matchIndex) + 1)
    if (!targets.length) return
    let next = value
    let delta = 0
    for (const match of [...targets].reverse()) {
      let text = replacement
      if (regex && pattern) {
        const single = new RegExp(pattern.source, matchCase ? 'y' : 'iy')
        single.lastIndex = match.start
        const replaced = value.replace(single, replacement)
        text = replaced.slice(match.start, replaced.length - (value.length - match.end))
      }
      next = next.slice(0, match.start) + text + next.slice(match.end)
      delta += text.length - (match.end - match.start)
    }
    if (scope) setScope({ ...scope, end: scope.end + delta })
    change(next, targets[0].start)
    setMatchIndex(-1)
  }
  const suggest = (text: string, caret: number) => {
    const prefix = text.slice(0, caret)
    const argument = /\\(cite[a-zA-Z*]*|(?:eq|auto|page)?ref|begin)\{([^{}]*)$/.exec(prefix)
    let options: string[] = []
    let start = caret
    if (argument) {
      const fragment = argument[2].split(',').at(-1) ?? ''
      start = caret - fragment.length
      const source = [text, ...projectSources].join('\n')
      options = argument[1] === 'begin' ? ['document', 'figure', 'table', 'equation', 'align', 'itemize', 'enumerate', 'abstract', 'theorem'] : argument[1].startsWith('cite') ? [...source.matchAll(/@\w+\s*\{\s*([^,\s]+)|\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)].map(match => match[1] ?? match[2]) : [...source.matchAll(/\\label\{([^}]+)\}/g)].map(match => match[1])
      options = [...new Set(options)].filter(option => option.startsWith(fragment) && option !== fragment).map(option => argument[1] === 'begin' ? option + '}\n  \n\\end{' + option + '}' : option)
    } else {
      const command = /\\([a-zA-Z]{2,})$/.exec(prefix)
      if (command) { start = caret - command[1].length; options = ['section{}', 'subsection{}', 'textbf{}', 'textit{}', 'emph{}', 'includegraphics{}', 'label{}', 'ref{}', 'cite{}', 'begin{}', 'item ', 'frac{}{}'].filter(option => option.startsWith(command[1]) && option !== command[1]) }
    }
    setCompletion(options.length ? { start, end: caret, options: options.slice(0, 8) } : null)
  }
  const acceptCompletion = (option: string) => {
    if (!completion || input.current?.selectionStart !== completion.end || input.current?.selectionEnd !== completion.end) { setCompletion(null); return }
    const tail = option.endsWith('}') && value[completion.end] === '}' ? completion.end + 1 : completion.end
    const empty = option.indexOf('{}')
    change(value.slice(0, completion.start) + option + value.slice(tail), completion.start + (empty >= 0 ? empty + 1 : option.includes('\n  \n') ? option.indexOf('\n') + 3 : option.length))
    setCompletion(null)
    input.current?.focus()
  }
  const editorOptions = <div className="latex-editor-options"><button type="button" aria-label={t('latex.softWrap')} aria-pressed={wrap} title={t('latex.softWrap')} onClick={() => setWrap(!wrap)}><TextAlignLeft size={14} aria-hidden="true" />{t('latex.softWrap')}<span className="latex-wrap-switch" aria-hidden="true"><span /></span></button></div>
  const searchControls = <div ref={optionsPanel} className="latex-find" data-panel={optionsOpen || replaceOpen || undefined} data-query={Boolean(query) || undefined} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind() } }} onFocusCapture={onSearchFocus}>
      <div className="latex-find-row"><button type="button" className="latex-icon-button" aria-label={t('latex.toggleReplace')} title={t('latex.toggleReplace')} aria-expanded={replaceOpen} onClick={() => { setReplaceOpen(!replaceOpen); if (!replaceOpen) requestAnimationFrame(() => replacementInput.current?.focus()) }}>{replaceOpen ? <CaretDown size={14} /> : <CaretRight size={14} />}</button><MarkdownSearchControls inputRef={search} inputPlaceholder={t('latex.find')} query={query} total={matches.length} index={Math.min(matchIndex, Math.max(0, matches.length - 1))} label={t('latex.find')} previousLabel={t('latex.previousMatch')} nextLabel={t('latex.next')} closeLabel={t('common.close')} onQueryChange={(next) => { setQuery(next); setMatchIndex(-1) }} onNavigate={selectMatch} onClose={closeFind} closable={!searchContainer} /><button ref={optionsButton} type="button" className="latex-icon-button latex-search-options-toggle" aria-label={t('latex.searchOptions')} title={t('latex.searchOptions')} data-active={matchCase || wholeWord || regex || Boolean(scope) || undefined} aria-expanded={optionsOpen} onClick={() => { setOptionsOpen(!optionsOpen) }}><SlidersHorizontal size={15} /></button></div>
      {(optionsOpen || replaceOpen || Boolean(query && !pattern)) && <div className="latex-search-panel">
      {optionsOpen && <div className="latex-search-options" role="group" aria-label={t('latex.searchOptions')}>{([['matchCase', matchCase, () => setMatchCase(!matchCase)], ['wholeWord', wholeWord, () => setWholeWord(!wholeWord)], ['regexSearch', regex, () => setRegex(!regex)], ['selectionOnly', Boolean(scope), () => setScope(scope ? null : { ...selection.current })]] as const).map(([key, active, toggle]) => <button type="button" key={key} aria-pressed={active} disabled={key === 'selectionOnly' && !scope && selection.current.start === selection.current.end} onClick={() => { toggle(); setMatchIndex(-1) }}><span className="latex-option-check" aria-hidden="true">{active && <Check size={13} weight="bold" />}</span>{t('latex.' + key)}</button>)}</div>}
      {query && !pattern && <span className="latex-search-error" role="alert">{t('latex.invalidRegex')}</span>}
      {replaceOpen && <div className="latex-replace-row"><input ref={replacementInput} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); replaceMatches(event.metaKey || event.ctrlKey) } }} aria-label={t('latex.replacement')} placeholder={t('latex.replacement')} value={replacement} onChange={(event) => setReplacement(event.target.value)} /><div className="latex-replace-actions"><button type="button" className="latex-text-button" disabled={!matches.length || disabled} onClick={() => replaceMatches(false)}>{t('latex.replaceOne')}</button><button type="button" className="latex-text-button" disabled={!matches.length || disabled} onClick={() => replaceMatches(true)}>{t('latex.replaceAll')}</button></div></div>}
      </div>}
    </div>
  return <div className="latex-source" data-wrap={wrap} data-plain={highlightValue !== value || !html} onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); openFind() }
    if (event.key === 'Escape' && find) { event.preventDefault(); event.stopPropagation(); closeFind() }
  }}>
    {aiMenu && createPortal(<div ref={aiMenuElement} className="latex-ai-selection-menu" role="dialog" aria-label={t('latex.aiSelection')} style={{ left: aiMenu.x, top: aiMenu.y }} onMouseDown={event => event.stopPropagation()}>
      <button type="button" className="latex-ai-proofread" onClick={() => requestAi()}><Eye size={19} />{t('latex.proofread')}</button>
      <form onSubmit={event => { event.preventDefault(); if (instruction.trim()) requestAi(instruction.trim()) }}><input aria-label={t('latex.editWithAi')} placeholder={t('latex.editWithAi')} value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={4000} /><button type="submit" aria-label={t('latex.sendAiEdit')} disabled={!instruction.trim()}><ArrowUp size={20} /></button></form>
    </div>, document.body)}
    {searchContainer ? createPortal(searchControls, searchContainer) : find && searchControls}
    {completion && <div className="latex-completions" role="listbox" aria-label={t('latex.completions')}>{completion.options.map(option => <button type="button" role="option" aria-selected={false} key={option} onMouseDown={event => event.preventDefault()} onClick={() => acceptCompletion(option)}>{option.split('\n')[0]}</button>)}</div>}
    <div className="latex-source-body"><div ref={gutter} className="latex-line-numbers" aria-hidden="true">{lines.map((_, index) => <span key={index} style={wrap ? { height: lineHeights[index] ?? 23 } : undefined} data-active={line === index + 1}>{index + 1}</span>)}</div><div className="latex-source-stack">
      {wrap && <div aria-hidden="true" ref={measure} className="latex-line-measure">{lines.map((text, index) => <div key={index}>{text || '\u200b'}</div>)}</div>}
      <pre aria-hidden="true" ref={highlights} className="latex-highlight"><code dangerouslySetInnerHTML={{ __html: html + '\n' }} /></pre>
      <pre aria-hidden="true" ref={selectionLayer} className="latex-selection-layer" data-visible={!focused && retainedSelection.value === value && retainedSelection.start !== retainedSelection.end || undefined}>{value.slice(0, retainedSelection.start)}<mark>{value.slice(retainedSelection.start, retainedSelection.end)}</mark>{value.slice(retainedSelection.end) + '\n'}</pre>
      <textarea onFocus={() => setFocused(true)} onBlur={() => { notifyPosition(); setFocused(false); setCompletion(null) }} ref={input} value={value} onChange={(event) => { change(event.target.value, event.target.selectionStart, event.target.selectionEnd); if (!('isComposing' in event.nativeEvent && event.nativeEvent.isComposing)) suggest(event.target.value, event.target.selectionStart) }} disabled={disabled} aria-label={t('latex.source')} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap={wrap ? "soft" : "off"} onSelect={notifyPosition} onKeyUp={(event) => { notifyPosition(); if (event.shiftKey || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a')) showAiMenu() }} onMouseUp={(event) => showAiMenu(event.clientX, event.clientY + 12)} onContextMenu={(event) => { if (onAi && event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) { event.preventDefault(); event.stopPropagation(); showAiMenu(event.clientX, event.clientY) } }} onClick={notifyPosition} onScroll={() => { syncScroll(); setAiMenu(null) }} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        const textarea = event.currentTarget
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault()
          const from = event.shiftKey ? history.current.redo : history.current.undo
          const to = event.shiftKey ? history.current.undo : history.current.redo
          const snapshot = from.pop()
          if (snapshot && !disabled) { to.push({ value, start, end }); ownEdit.current = true; previous.current = snapshot; onChange(snapshot.value); requestAnimationFrame(() => { textarea.setSelectionRange(snapshot.start, snapshot.end); notifyPosition() }) }
          return
        }
        if (event.key === 'Escape' && completion) { event.preventDefault(); setCompletion(null); return }
        if (event.key === 'Tab' && completion && !event.shiftKey) { event.preventDefault(); acceptCompletion(completion.options[0]); return }
        if ((event.metaKey || event.ctrlKey) && event.key === '/') {
          event.preventDefault()
          const first = value.lastIndexOf('\n', start - 1) + 1
          const lastBreak = value.indexOf('\n', end)
          const last = lastBreak < 0 ? value.length : lastBreak
          const block = value.slice(first, last).split('\n')
          const uncomment = block.every(text => /^\s*%/.test(text))
          const next = block.map(text => uncomment ? text.replace(/^(\s*)% ?/, '$1') : '% ' + text).join('\n')
          change(value.slice(0, first) + next + value.slice(last), first, first + next.length)
          return
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter') {
          event.preventDefault()
          const before = value.slice(value.lastIndexOf('\n', start - 1) + 1, start)
          const indent = /^\s*/.exec(before)?.[0] ?? ''
          const extra = /\\begin\{[^}]+\}\s*$/.test(before) ? '  ' : ''
          change(value.slice(0, start) + '\n' + indent + extra + value.slice(end), start + 1 + indent.length + extra.length)
          setCompletion(null)
          return
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && ['{', '[', '('].includes(event.key) && value[start - 1] !== '\\') {
          event.preventDefault()
          const close = { '{': '}', '[': ']', '(': ')' }[event.key]
          change(value.slice(0, start) + event.key + value.slice(start, end) + close + value.slice(end), start + 1, end + 1)
          return
        }
        if (start === end && ['}', ']', ')'].includes(event.key) && value[start] === event.key) { event.preventDefault(); textarea.setSelectionRange(start + 1, end + 1); return }
        if (event.key === 'Tab') {
          event.preventDefault()
          const textarea = event.currentTarget
          const start = textarea.selectionStart
          const end = textarea.selectionEnd
          if (event.shiftKey || value.slice(start, end).includes('\n')) {
            const lineStart = value.lastIndexOf('\n', start - 1) + 1
            const block = value.slice(lineStart, end)
            const modified = block.split('\n').map((text) => event.shiftKey ? text.replace(/^ {1,2}|^\t/, '') : '  ' + text).join('\n')
            change(value.slice(0, lineStart) + modified + value.slice(end), lineStart, lineStart + modified.length)
            requestAnimationFrame(() => textarea.setSelectionRange(lineStart, lineStart + modified.length))
          } else {
            change(value.slice(0, start) + '  ' + value.slice(end), start + 2)
            requestAnimationFrame(() => textarea.setSelectionRange(start + 2, start + 2))
          }
        }
      }} />
    </div></div>
    {statusContainer ? createPortal(editorOptions, statusContainer) : statusContainer === undefined && editorOptions}
  </div>
})
export default LatexSourceEditor
