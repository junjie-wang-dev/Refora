import type { RefObject } from 'react'
import { CaretLeft, CaretRight, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'

interface Props {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  total: number
  index: number
  label: string
  previousLabel: string
  nextLabel: string
  closeLabel: string
  onQueryChange: (query: string) => void
  onNavigate: (direction: number) => void
  onClose: () => void
  closable?: boolean
}

export default function MarkdownSearchControls({ inputRef, query, total, index, label, previousLabel, nextLabel, closeLabel, onQueryChange, onNavigate, onClose, closable = true }: Props) {
  const { t } = useTranslation()
  return <form className="markdown-search-controls" role="search" aria-label={label} onSubmit={(event) => { event.preventDefault(); onNavigate(1) }} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onQueryChange(''); onClose() }
    if (event.key === 'Enter' && event.target === inputRef.current) { event.preventDefault(); event.stopPropagation(); onNavigate(event.shiftKey ? -1 : 1) }
  }}>
    <div className="markdown-search-input">
      <MagnifyingGlass size={16} aria-hidden="true" />
      <input ref={inputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} aria-label={label} placeholder={t('markdown.findDocument')} />
      {query && <button type="button" aria-label={t('common.clearSearch')} title={t('common.clearSearch')} onPointerDown={(event) => event.preventDefault()} onClick={() => { onQueryChange(''); inputRef.current?.focus() }}><X size={14} /></button>}
    </div>
    <span role="status" aria-live="polite">{query ? total ? `${index + 1}/${total}` : t('pdfReader.noResults') : ''}</span>
    <button type="button" disabled={!total} aria-label={previousLabel} title={previousLabel} onClick={() => onNavigate(-1)}><CaretLeft size={14} /></button>
    <button type="button" disabled={!total} aria-label={nextLabel} title={nextLabel} onClick={() => onNavigate(1)}><CaretRight size={14} /></button>
    {closable && <button type="button" aria-label={closeLabel} title={closeLabel} onClick={() => { onQueryChange(''); onClose() }}><X size={16} /></button>}
  </form>
}
