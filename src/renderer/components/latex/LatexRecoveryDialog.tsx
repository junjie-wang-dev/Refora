import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { LatexFile, LatexResponse } from '../../../shared/latex-types'
import { useModalDialog } from '../../hooks/useModalDialog'
import LatexPdfPreview from './LatexPdfPreview'
import './latexRecovery.css'

interface ConflictProps {
  base: string
  draft: string
  remote: LatexFile
  busy: boolean
  onClose: () => void
  onMerge: (content: string, hash: string) => void
  onSaveAs: (path: string, content: string) => void
  onDownload: () => void
}

export function LatexConflictDialog({ base, draft, remote, busy, onClose, onMerge, onSaveAs, onDownload }: ConflictProps) {
  const { t } = useTranslation()
  const [merged, setMerged] = useState(draft)
  const [path, setPath] = useState(remote.path.replace(/(\.[^/.]+)$/, '-recovered$1'))
  const dialog = useModalDialog<HTMLDivElement>(true, () => { if (!busy) onClose() })
  return createPortal(<div className="latex-modal-backdrop"><div ref={dialog} role="dialog" aria-modal="true" aria-label={t('latex.resolveConflict')} className="latex-dialog latex-recovery-dialog" tabIndex={-1}>
    <h2>{t('latex.resolveConflict')}</h2><p>{t('latex.mergeHint')}</p>
    <div className="latex-conflict-versions">
      <label>{t('latex.baseVersion')}<textarea readOnly value={base} /></label>
      <label>{t('latex.localVersion')}<textarea readOnly value={draft} /></label>
      <label>{t('latex.diskVersion')}<textarea readOnly value={remote.content} /></label>
    </div>
    <label className="latex-merge-result">{t('latex.mergedVersion')}<textarea value={merged} onChange={event => setMerged(event.target.value)} spellCheck={false} disabled={busy} /></label>
    {remote.review && <p role="status">{t('latex.mergePendingReview')}</p>}
    <div className="latex-recovery-actions"><button type="button" disabled={busy} onClick={() => setMerged(remote.content)}>{t('latex.useDiskVersion')}</button><button type="button" onClick={onDownload}>{t('latex.downloadDraft')}</button><button type="button" disabled={busy || Boolean(remote.review)} onClick={() => onMerge(merged, remote.hash)}>{t('latex.saveMerge')}</button></div>
    <div className="latex-save-copy"><label>{t('latex.copyPath')}<input value={path} disabled={busy} onChange={event => setPath(event.target.value)} /></label><button type="button" disabled={busy || !path.trim() || path.trim() === remote.path} onClick={() => onSaveAs(path.trim(), merged)}>{t('latex.saveCopy')}</button></div>
    <div className="latex-dialog-footer"><button type="button" disabled={busy} onClick={onClose}>{t('common.close')}</button></div>
  </div></div>, document.body)
}

interface HistoryProps {
  entries: NonNullable<LatexResponse['history']>
  busy: boolean
  onRestore: (id: string) => void
  onClose: () => void
}

export function LatexHistoryDialog({ entries, busy, onRestore, onClose }: HistoryProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(entries[0]?.id ?? '')
  const entry = entries.find(item => item.id === selected)
  const dialog = useModalDialog<HTMLDivElement>(true, () => { if (!busy) onClose() })
  return createPortal(<div className="latex-modal-backdrop"><div ref={dialog} className="latex-dialog latex-recovery-dialog" role="dialog" aria-modal="true" aria-label={t('latex.history')} tabIndex={-1}>
    <h2>{t('latex.history')}</h2><p>{t('latex.historyHint')}</p>
    {entries.length ? <><label>{t('latex.version')}<select value={selected} onChange={event => setSelected(event.target.value)}>{entries.map((item, index) => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString()} · {entries.length - index}</option>)}</select></label><pre className="latex-history-content">{entry?.content}</pre></> : <p>{t('latex.historyEmpty')}</p>}
    <div className="latex-dialog-footer"><button type="button" disabled={busy} onClick={onClose}>{t('common.close')}</button><button type="button" disabled={busy || !entry} onClick={() => { if (entry) onRestore(entry.id) }}>{t('latex.restoreVersion')}</button></div>
  </div></div>, document.body)
}

export function LatexResourceDialog({ resource, onClose }: { resource: NonNullable<LatexResponse['resource']>; onClose: () => void }) {
  const { t } = useTranslation()
  const dialog = useModalDialog<HTMLDivElement>(true, onClose)
  return createPortal(<div className="latex-modal-backdrop"><div ref={dialog} className="latex-dialog latex-resource-dialog" role="dialog" aria-modal="true" aria-label={resource.path} tabIndex={-1}><div className="latex-dialog-heading"><h2>{resource.path}</h2><button type="button" onClick={onClose}>{t('common.close')}</button></div><div className="latex-resource-content">{resource.mimeType === 'application/pdf' ? <LatexPdfPreview data={resource.base64} documentId={`latex-resource:${resource.path}`} /> : resource.mimeType.startsWith('image/') ? <img src={`data:${resource.mimeType};base64,${resource.base64}`} alt={resource.path} /> : <p>{t('latex.resourceNoPreview')}</p>}</div></div></div>, document.body)
}
