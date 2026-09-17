import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CaretDown, CaretUp, Check, Code, FileCode, X } from '@phosphor-icons/react'
import hljs from 'highlight.js/lib/core'
import latex from 'highlight.js/lib/languages/latex'
import type { LatexReview } from '../../../shared/latex-types'

hljs.registerLanguage('latex', latex)
const sourceLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

interface Props {
  review: LatexReview
  busy: boolean
  onResolve: (decision: 'accept' | 'reject', editId?: string) => void
}

export default function LatexReviewPanel({ review, busy, onResolve }: Props) {
  const { t } = useTranslation()
  const pending = useMemo(() => review.edits.filter(edit => edit.status === 'pending'), [review.edits])
  const [activeId, setActiveId] = useState(pending[0]?.id)
  const [fullFile, setFullFile] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const changes = useRef(new Map<string, HTMLElement>())
  const selected = Math.max(0, pending.findIndex(edit => edit.id === activeId))
  useEffect(() => {
    if (pending.some(edit => edit.id === activeId)) return
    const previous = review.edits.findIndex(edit => edit.id === activeId)
    const next = pending.find(edit => review.edits.indexOf(edit) >= previous) ?? pending[0]
    setActiveId(next?.id)
    if (next) requestAnimationFrame(() => changes.current.get(next.id)?.scrollIntoView?.({ block: 'nearest' }))
  }, [activeId, pending, review.edits])
  const navigate = (delta: number) => {
    const next = pending[(selected + delta + pending.length) % pending.length]
    if (!next) return
    setActiveId(next.id)
    const element = changes.current.get(next.id)
    element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    element?.focus({ preventScroll: true })
  }
  const added = pending.reduce((total, edit) => total + sourceLines(edit.after).length, 0)
  const removed = pending.reduce((total, edit) => total + sourceLines(edit.before).length, 0)
  const row = (text: string, oldLine: number | null, newLine: number | null, kind: '' | 'added' | 'removed', key: string) => <div className={`latex-diff-row ${kind ? `latex-review-${kind}` : ''}`} key={key}>
    <span className="latex-diff-number" aria-hidden="true">{oldLine}</span><span className="latex-diff-number" aria-hidden="true">{newLine}</span><span className="latex-diff-sign" aria-hidden="true">{kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '}</span>
    <code dangerouslySetInnerHTML={{ __html: hljs.highlight(text.replace(/\r?\n$/, ''), { language: 'latex' }).value || ' ' }} />
  </div>
  const original = sourceLines(review.baseContent)
  let cursor = 0
  let newLine = 1
  const unchanged = (start: number, end: number) => {
    const lines = original.slice(start, end)
    const firstNew = newLine
    newLine += lines.length
    const collapsed = !fullFile && !expanded.has(start) && lines.length > 8
    const renderLine = (index: number) => row(lines[index], start + index + 1, firstNew + index, '', `context-${index}`)
    return collapsed ? <div className="latex-diff-context" key={`context-${start}`}>
      {lines.slice(0, 3).map((_, index) => renderLine(index))}
      <button type="button" className="latex-diff-expand" onClick={() => setExpanded(current => new Set([...current, start]))}>{t('latex.showUnchanged', { count: lines.length - 6 })}</button>
      {lines.slice(-3).map((_, index) => renderLine(lines.length - 3 + index))}
    </div> : <div key={`context-${start}`}>{lines.map((_, index) => renderLine(index))}</div>
  }
  const blocks = review.edits.map(edit => {
    const context = unchanged(cursor, edit.startLine)
    cursor = edit.endLine
    const before = sourceLines(edit.before)
    const after = sourceLines(edit.status === 'rejected' ? edit.before : edit.after)
    const firstNew = newLine
    newLine += after.length
    return <div key={edit.id}>{context}{edit.status === 'pending' ? <section ref={element => { if (element) changes.current.set(edit.id, element); else changes.current.delete(edit.id) }} tabIndex={-1} className="latex-review-change" data-active={edit.id === pending[selected]?.id || undefined} aria-label={t('latex.aiChangeLine', { line: edit.startLine + 1 })} onFocusCapture={() => setActiveId(edit.id)}>
      <div className="latex-review-actions"><span>{t('latex.aiChangeLine', { line: edit.startLine + 1 })}</span><button type="button" className="latex-review-accept" disabled={busy} onClick={() => onResolve('accept', edit.id)}><Check size={14} />{t('latex.acceptChange')}</button><button type="button" disabled={busy} onClick={() => onResolve('reject', edit.id)}><X size={14} />{t('latex.rejectChange')}</button></div>
      {before.map((text, index) => row(text, edit.startLine + index + 1, null, 'removed', `old-${index}`))}
      {after.map((text, index) => row(text, null, firstNew + index, 'added', `new-${index}`))}
    </section> : after.map((text, index) => row(text, edit.status === 'rejected' ? edit.startLine + index + 1 : null, firstNew + index, '', `resolved-${index}`))}</div>
  })
  const tail = unchanged(cursor, original.length)
  return <section className="latex-review" aria-label={t('latex.aiReview')}>
    <div className="latex-review-toolbar"><div className="latex-review-title"><FileCode size={15} /><strong title={review.path}>{review.path}</strong><span className="latex-diff-added-count">+{added}</span><span className="latex-diff-removed-count">−{removed}</span></div><div className="latex-review-bulk"><button type="button" disabled={busy} className="latex-review-accept" onClick={() => onResolve('accept')}><Check size={14} />{t('latex.acceptAll')}</button><button type="button" disabled={busy} onClick={() => onResolve('reject')}>{t('latex.rejectAll')}</button></div></div>
    <div className="latex-review-navigation"><span>{t('latex.reviewProgress', { current: selected + 1, count: pending.length })}</span><button type="button" aria-label={t('latex.previousChange')} title={t('latex.previousChange')} disabled={pending.length < 2 || busy} onClick={() => navigate(-1)}><CaretUp size={14} /></button><button type="button" aria-label={t('latex.nextChange')} title={t('latex.nextChange')} disabled={pending.length < 2 || busy} onClick={() => navigate(1)}><CaretDown size={14} /></button><button type="button" className="latex-review-full" aria-pressed={fullFile} title={t('latex.showFullFile')} onClick={() => setFullFile(!fullFile)}><Code size={14} />{t('latex.showFullFile')}</button></div>
    <div className="latex-review-scroll" tabIndex={0}>{blocks}{tail}</div>
    <div className="latex-review-footer">{t('latex.reviewHint')}</div>
  </section>
}
