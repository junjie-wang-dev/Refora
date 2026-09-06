import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Code, Image, Link, ListBullets, MagnifyingGlass, Sigma, Table, TextB, TextItalic, X } from '@phosphor-icons/react'
import ReactMarkdown from 'react-markdown'
import { api } from '../../ipc'
import { useModalDialog } from '../../hooks/useModalDialog'
import { REMARK_PLUGINS, REHYPE_PLUGINS } from '../../utils/markdown'
import { continueMarkdownList, indentMarkdown, markdownMatches, markdownTableAt, replaceMarkdown, serializeMarkdownTable, wrapMarkdown, type MarkdownEdit, type MarkdownSelection } from '../../utils/markdownEditing'
import MarkdownSearchControls from './MarkdownSearchControls'
import './markdownEditor.css'

export interface MarkdownEditorPosition extends MarkdownSelection { scrollTop: number }
export interface MarkdownEditorHandle {
  focus: () => void
  openFind: () => void
  getPosition: () => MarkdownEditorPosition
  restorePosition: (position: MarkdownEditorPosition) => void
  revealOffset: (offset: number) => void
}
interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  initialPosition?: MarkdownEditorPosition
  onPositionChange?: (position: MarkdownEditorPosition) => void
  onScroll?: (ratio: number) => void
  className?: string
  searchContainer?: HTMLElement | null
  searchOpen?: boolean
  onSearchOpenChange?: (open: boolean) => void
  compactSearch?: boolean
  disabled?: boolean
}
type InsertDialog = { type: 'formula'; selection: MarkdownSelection; formula: string } | { type: 'table'; selection: MarkdownSelection; rows: string[][]; alignments: string[] }

const MAX_IMAGE_SIZE = 15 * 1024 * 1024
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif)$/

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({ value, onChange, ariaLabel, initialPosition, onPositionChange, onScroll, className = '', disabled = false, searchContainer, searchOpen, onSearchOpenChange, compactSearch = true }, ref) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightsRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const imageSelectionRef = useRef<{ value: string; selection: MarkdownSelection } | null>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const selectionRef = useRef<MarkdownSelection>({ start: initialPosition?.start ?? 0, end: initialPosition?.end ?? 0 })
  const pendingSelection = useRef<MarkdownSelection | null>(null)
  const history = useRef<Array<MarkdownEdit>>([])
  const future = useRef<Array<MarkdownEdit>>([])
  const [localFindOpen, setLocalFindOpen] = useState(false)
  const findOpen = searchOpen ?? localFindOpen
  const setFindOpen = useCallback((open: boolean) => { setLocalFindOpen(open); onSearchOpenChange?.(open) }, [onSearchOpenChange])
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [dialog, setDialog] = useState<InsertDialog | null>(null)
  const [imageBusy, setImageBusy] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const aliveRef = useRef(true)
  const dialogRef = useModalDialog<HTMLDivElement>(dialog !== null, () => setDialog(null))
  const matches = markdownMatches(value, query)
  const matchIndex = Math.min(activeMatch, Math.max(0, matches.length - 1))

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  const getPosition = useCallback((): MarkdownEditorPosition => {
    const textarea = textareaRef.current
    return { start: textarea?.selectionStart ?? 0, end: textarea?.selectionEnd ?? 0, scrollTop: textarea?.scrollTop ?? 0 }
  }, [])

  const readSelection = (): MarkdownSelection => {
    const textarea = textareaRef.current
    if (textarea) selectionRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd }
    return { ...selectionRef.current }
  }

  const notifyPosition = () => {
    const position = getPosition()
    selectionRef.current = position
    onPositionChange?.(position)
  }

  const revealSelection = useCallback((start: number, end = start, focus = true) => {
    const textarea = textareaRef.current
    if (!textarea) return
    if (focus) textarea.focus()
    textarea.setSelectionRange(start, end)
    selectionRef.current = { start, end }
    const before = valueRef.current.slice(0, start)
    const style = window.getComputedStyle(textarea)
    const lineHeight = Number.parseFloat(style.lineHeight) || 24
    const columns = Math.max(10, Math.floor(textarea.clientWidth / ((Number.parseFloat(style.fontSize) || 13) * 0.61)))
    const visualLines = before.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / columns)), 0) - 1
    textarea.scrollTop = Math.max(0, visualLines * lineHeight - textarea.clientHeight / 3)
    if (highlightsRef.current) highlightsRef.current.scrollTop = textarea.scrollTop
    onPositionChange?.({ start, end, scrollTop: textarea.scrollTop })
  }, [onPositionChange])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    openFind: () => { setFindOpen(true); window.requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select() }) },
    getPosition,
    restorePosition: (position) => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.setSelectionRange(position.start, position.end)
      textarea.scrollTop = position.scrollTop
      if (highlightsRef.current) highlightsRef.current.scrollTop = position.scrollTop
      selectionRef.current = position
    },
    revealOffset: (offset) => revealSelection(offset)
  }), [getPosition, revealSelection])

  useLayoutEffect(() => {
    if (initialPosition && textareaRef.current) {
      textareaRef.current.setSelectionRange(initialPosition.start, initialPosition.end)
      textareaRef.current.scrollTop = initialPosition.scrollTop
    }
  }, [])

  useLayoutEffect(() => {
    if (highlightsRef.current && textareaRef.current) highlightsRef.current.scrollTop = textareaRef.current.scrollTop
  }, [findOpen, query, value])

  useLayoutEffect(() => {
    if (!pendingSelection.current || !textareaRef.current) return
    const selection = pendingSelection.current
    textareaRef.current.focus()
    textareaRef.current.setSelectionRange(selection.start, selection.end)
    pendingSelection.current = null
  }, [value])

  const applyEdit = (edit: MarkdownEdit, record = true) => {
    if (disabled) return
    if (record) {
      history.current.push({ value: valueRef.current, ...selectionRef.current })
      if (history.current.length > 100) history.current.shift()
      future.current = []
    }
    pendingSelection.current = { start: edit.start, end: edit.end }
    selectionRef.current = pendingSelection.current
    valueRef.current = edit.value
    onChange(edit.value)
    onPositionChange?.({ start: edit.start, end: edit.end, scrollTop: textareaRef.current?.scrollTop ?? 0 })
  }

  const format = (kind: 'bold' | 'italic' | 'link' | 'list' | 'code') => {
    const selected = readSelection()
    if (kind === 'bold') applyEdit(wrapMarkdown(valueRef.current, selected, '**', '**', t('markdown.editor.text')))
    if (kind === 'italic') applyEdit(wrapMarkdown(valueRef.current, selected, '*', '*', t('markdown.editor.text')))
    if (kind === 'link') applyEdit(wrapMarkdown(valueRef.current, selected, '[', '](https://)', t('markdown.editor.linkText')))
    if (kind === 'code') applyEdit(wrapMarkdown(valueRef.current, selected, '\n```\n', '\n```\n', t('markdown.editor.codeText')))
    if (kind === 'list') {
      const start = valueRef.current.lastIndexOf('\n', selected.start - 1) + 1
      const last = valueRef.current.indexOf('\n', Math.max(selected.start, selected.end - 1))
      const end = last < 0 ? valueRef.current.length : last
      const lines = valueRef.current.slice(start, end).split('\n')
      const remove = lines.every((line) => /^\s*[-+*] /.test(line))
      const text = lines.map((line) => remove ? line.replace(/^(\s*)[-+*] /, '$1') : line.replace(/^(\s*)/, '$1- ')).join('\n')
      applyEdit(replaceMarkdown(valueRef.current, { start, end }, text, text.length))
    }
  }

  const openTable = () => {
    const selection = readSelection()
    const existing = markdownTableAt(valueRef.current, selection.start)
    setDialog({ type: 'table', selection: existing ? { start: existing.start, end: existing.end } : selection, rows: existing?.rows ?? [[t('markdown.editor.column') + ' 1', t('markdown.editor.column') + ' 2'], ['', ''], ['', '']], alignments: existing?.alignments ?? [] })
  }

  const navigateMatch = (direction: number) => {
    if (!matches.length) return
    const next = (matchIndex + direction + matches.length) % matches.length
    setActiveMatch(next)
    revealSelection(matches[next], matches[next] + query.length, false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    readSelection()
    const key = event.key.toLowerCase()
    if (event.metaKey || event.ctrlKey) {
      if (key === 'f') { event.preventDefault(); event.stopPropagation(); setFindOpen(true); window.requestAnimationFrame(() => findRef.current?.focus()); return }
      if (key === 'b' || key === 'i' || key === 'k') { event.preventDefault(); format(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'link'); return }
      if (key === 'z') {
        event.preventDefault()
        const source = event.shiftKey ? future.current : history.current
        const target = event.shiftKey ? history.current : future.current
        const previous = source.pop()
        if (previous) { target.push({ value: valueRef.current, ...selectionRef.current }); applyEdit(previous, false) }
        return
      }
    }
    if (event.key === 'Tab') { event.preventDefault(); applyEdit(indentMarkdown(valueRef.current, selectionRef.current, event.shiftKey)) }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      const edit = continueMarkdownList(valueRef.current, selectionRef.current)
      if (edit) { event.preventDefault(); applyEdit(edit) }
    }
  }

  const insertImage = async (file: File, snapshot?: { value: string; selection: MarkdownSelection } | null) => {
    if (imageBusy || disabled) return
    if (!IMAGE_TYPES.test(file.type) || file.size > MAX_IMAGE_SIZE) { setImageError(t('markdown.editor.imageInvalid')); return }
    const source = snapshot?.value ?? valueRef.current
    const selection = snapshot?.selection ?? readSelection()
    setImageBusy(true)
    setImageError(null)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const resource = await api.ai.resolveMedia({ source: { type: 'inline', dataUrl }, kind: 'image', fileName: file.name })
      if (!aliveRef.current) return
      const currentSelection = valueRef.current === source ? selection : readSelection()
      const alt = file.name.replace(/[[\]\\\r\n]/g, '').replace(/\.[^.]+$/, '') || t('markdown.editor.image')
      applyEdit(replaceMarkdown(valueRef.current, currentSelection, `![${alt}](refora-asset://media/${resource.id})`))
    } catch { if (aliveRef.current) setImageError(t('markdown.editor.imageFailed')) }
    finally { if (aliveRef.current) setImageBusy(false) }
  }

  const toolbar = [
    { key: 'bold', Icon: TextB, shortcut: '⌘B', action: () => format('bold') },
    { key: 'italic', Icon: TextItalic, shortcut: '⌘I', action: () => format('italic') },
    { key: 'link', Icon: Link, shortcut: '⌘K', action: () => format('link') },
    { key: 'list', Icon: ListBullets, action: () => format('list') },
    { key: 'code', Icon: Code, action: () => format('code') },
    { key: 'formula', Icon: Sigma, action: () => { const selection = readSelection(); setDialog({ type: 'formula', selection, formula: valueRef.current.slice(selection.start, selection.end) || 'E = mc^2' }) } },
    { key: 'table', Icon: Table, action: openTable },
    { key: 'image', Icon: Image, action: () => { imageSelectionRef.current = { value: valueRef.current, selection: readSelection() }; fileRef.current?.click() } },
    { key: 'find', Icon: MagnifyingGlass, shortcut: '⌘F', action: () => { setFindOpen(true); window.requestAnimationFrame(() => findRef.current?.focus()) } }
  ]

  const search = <MarkdownSearchControls inputRef={findRef} query={query} total={matches.length} index={matchIndex} label={t('markdown.editor.findText')} previousLabel={t('markdown.editor.previous')} nextLabel={t('markdown.editor.next')} closeLabel={t('markdown.editor.closeFind')} closable={compactSearch} onQueryChange={(next) => { setQuery(next); setActiveMatch(0); const first = markdownMatches(value, next)[0]; if (first !== undefined) revealSelection(first, first + next.length, false) }} onNavigate={navigateMatch} onClose={() => { setFindOpen(false); textareaRef.current?.focus() }} />

  return <div className={`markdown-editor ${className}`}>
    <div className="markdown-editor-toolbar" role="toolbar" aria-label={t('markdown.editor.toolbar')}>
      {toolbar.filter(({ key }) => !searchContainer || key !== 'find').map(({ key, Icon, shortcut, action }) => <button key={key} type="button" disabled={disabled || (key === 'image' && imageBusy)} aria-label={t(`markdown.editor.${key}`)} title={`${t(`markdown.editor.${key}`)}${shortcut ? ` (${shortcut})` : ''}`} onMouseDown={(event) => event.preventDefault()} onClick={action}><Icon className="h-4 w-4" /></button>)}
      <input ref={fileRef} className="hidden" tabIndex={-1} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void insertImage(file, imageSelectionRef.current); imageSelectionRef.current = null; event.target.value = '' }} />
    </div>
    {findOpen && (searchContainer ? createPortal(search, searchContainer) : search)}
    {findOpen && query && <div className="markdown-editor-find">
      <div><input aria-label={t('markdown.editor.replaceText')} placeholder={t('markdown.editor.replaceText')} value={replacement} onChange={(event) => setReplacement(event.target.value)} />
        <button type="button" disabled={!matches.length || disabled} onClick={() => { const start = matches[matchIndex]; applyEdit(replaceMarkdown(value, { start, end: start + query.length }, replacement)) }}>{t('markdown.editor.replace')}</button>
        <button type="button" disabled={!matches.length || disabled} onClick={() => {
          let next = value
          for (const start of [...matches].reverse()) next = next.slice(0, start) + replacement + next.slice(start + query.length)
          applyEdit({ value: next, start: matches[0], end: matches[0] + replacement.length })
          setActiveMatch(0)
        }}>{t('markdown.editor.replaceAll')}</button>
      </div>
    </div>}
    {imageBusy && <p className="markdown-editor-status" role="status">{t('markdown.editor.imageSaving')}</p>}
    {imageError && <p className="markdown-editor-status text-error" role="alert">{imageError}</p>}
    <div className="markdown-editor-input-region">
      {findOpen && query && <div ref={highlightsRef} className="markdown-editor-highlights" aria-hidden="true">{matches.map((start, index) => <span key={start}>{value.slice(index === 0 ? 0 : matches[index - 1] + query.length, start)}<mark data-active={index === matchIndex}>{value.slice(start, start + query.length)}</mark></span>)}{value.slice(matches.length ? matches[matches.length - 1] + query.length : 0)}{'\n'}</div>}
    <textarea ref={textareaRef} disabled={disabled} aria-label={ariaLabel} spellCheck={false} value={value} onChange={(event) => {
      history.current.push({ value: valueRef.current, ...selectionRef.current })
      if (history.current.length > 100) history.current.shift()
      future.current = []
      valueRef.current = event.target.value
      selectionRef.current = { start: event.target.selectionStart, end: event.target.selectionEnd }
      onChange(event.target.value)
      notifyPosition()
    }} onSelect={notifyPosition} onKeyDown={onKeyDown} onScroll={(event) => { notifyPosition(); const el = event.currentTarget; if (highlightsRef.current) highlightsRef.current.scrollTop = el.scrollTop; onScroll?.(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)) }} onPaste={(event) => {
      const file = Array.from(event.clipboardData.items).find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile()
      if (file) { event.preventDefault(); void insertImage(file) }
    }} />
    </div>
    {dialog && createPortal(<div className="markdown-editor-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(null) }}>
      <div ref={dialogRef} className="markdown-editor-dialog" role="dialog" aria-modal="true" aria-label={t(`markdown.editor.${dialog.type}`)} tabIndex={-1}>
        <div className="markdown-editor-dialog-title"><h2>{t(`markdown.editor.${dialog.type}`)}</h2><button type="button" onClick={() => setDialog(null)} aria-label={t('markdown.editor.cancel')}><X className="h-4 w-4" /></button></div>
        {dialog.type === 'formula' ? <>
          <textarea data-autofocus aria-label={t('markdown.editor.formulaSource')} value={dialog.formula} onChange={(event) => setDialog({ ...dialog, formula: event.target.value })} rows={4} />
          <div className="markdown-editor-formula-preview" aria-label={t('markdown.editor.preview')}><ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{`$$\n${dialog.formula}\n$$`}</ReactMarkdown></div>
        </> : <>
          <p className="text-xs text-muted">{t('markdown.editor.tableHint')}</p>
          <div className="markdown-editor-table-scroll"><table><tbody>{dialog.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, colIndex) => <td key={colIndex}><input data-autofocus={rowIndex === 0 && colIndex === 0 ? true : undefined} aria-label={`${t('markdown.editor.cell')} ${rowIndex + 1}, ${colIndex + 1}`} value={cell} onChange={(event) => setDialog({ ...dialog, rows: dialog.rows.map((existing, i) => i === rowIndex ? existing.map((content, j) => j === colIndex ? event.target.value : content) : existing) })} /></td>)}<td>{rowIndex > 0 && <button type="button" disabled={dialog.rows.length < 3} aria-label={`${t('markdown.editor.removeRow')} ${rowIndex + 1}`} onClick={() => setDialog({ ...dialog, rows: dialog.rows.filter((_, i) => i !== rowIndex) })}>−</button>}</td></tr>)}</tbody></table></div>
          <div className="markdown-editor-table-actions"><button type="button" disabled={dialog.rows.length >= 100} onClick={() => setDialog({ ...dialog, rows: [...dialog.rows, dialog.rows[0].map(() => '')] })}>{t('markdown.editor.addRow')}</button><button type="button" disabled={dialog.rows[0].length >= 20} onClick={() => setDialog({ ...dialog, rows: dialog.rows.map((row) => [...row, '']) })}>{t('markdown.editor.addColumn')}</button><button type="button" disabled={dialog.rows[0].length <= 1} onClick={() => setDialog({ ...dialog, rows: dialog.rows.map((row) => row.slice(0, -1)), alignments: dialog.alignments.slice(0, -1) })}>{t('markdown.editor.removeColumn')}</button></div>
        </>}
        <div className="markdown-editor-dialog-actions"><button type="button" onClick={() => setDialog(null)}>{t('markdown.editor.cancel')}</button><button type="button" disabled={dialog.type === 'formula' && !dialog.formula.trim()} onClick={() => {
          const content = dialog.type === 'formula' ? `$$\n${dialog.formula.trim()}\n$$` : serializeMarkdownTable(dialog.rows, dialog.alignments)
          const prefix = dialog.selection.start > 0 && value[dialog.selection.start - 1] !== '\n' ? '\n\n' : ''
          const suffix = dialog.selection.end < value.length && value[dialog.selection.end] !== '\n' ? '\n\n' : '\n'
          applyEdit(replaceMarkdown(value, dialog.selection, prefix + content + suffix))
          setDialog(null)
        }}>{t('markdown.editor.insert')}</button></div>
      </div>
    </div>, document.body)}
  </div>
})

export default MarkdownEditor
