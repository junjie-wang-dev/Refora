import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowsClockwise, FileCode, FolderOpen, Plus, X } from '@phosphor-icons/react'
import type { LatexProject, LatexRequest } from '../../../shared/latex-types'
import type { WorkspaceItemPlacement } from '../../../shared/ipc-types'
import { errorMessage } from '../../../shared/ipc-types'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useModalDialog } from '../../hooks/useModalDialog'
import { availableCardPlacement } from './boardLayout'
import { clampCardSize } from './ResizableCard'
import '../latex/latex.css'

export default function WorkspaceLatexDialog({ workspaceId, placement, onClose, onOpen, onCreated }: { workspaceId: string; placement: WorkspaceItemPlacement; onClose: () => void; onOpen: (project: LatexProject) => Promise<void>; onCreated: (project: LatexProject) => void }) {
  const { t } = useTranslation()
  const projects = useWorkspaceStore((state) => state.latexProjects)
  const items = useWorkspaceStore((state) => state.items)
  const refresh = useWorkspaceStore((state) => state.fetchLatexProjects)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useModalDialog<HTMLDivElement>(true, () => { if (!busy) onClose() })
  useEffect(() => { void refresh() }, [refresh])
  const freePlacement = () => availableCardPlacement(useWorkspaceStore.getState().items.map((item) => ({ x: item.x, y: item.y, ...clampCardSize(item) })), placement, 300, 112)
  const create = async (action: 'create' | 'import') => {
    setBusy(true); setError('')
    try {
      const position = freePlacement()
      const request: LatexRequest = action === 'create' ? { action, title: title.trim(), placement: position } : { action, placement: position }
      const result = await window.api.latex.execute(workspaceId, request)
      if (!result.project) return
      await refresh()
      onCreated(result.project)
      onClose()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  const pin = async (project: LatexProject) => {
    setBusy(true)
    try {
      await window.api.workspaceItems.add(workspaceId, 'latex', [project.id], freePlacement())
      await useWorkspaceStore.getState().fetchItems()
      onCreated(project)
      onClose()
    } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  return createPortal(<div className="latex-modal-backdrop" onClick={() => { if (!busy) onClose() }}><div ref={dialog} className="latex-dialog" role="dialog" aria-modal="true" aria-label={t('latex.createInWorkspace')} tabIndex={-1} onClick={(event) => event.stopPropagation()}><div className="latex-dialog-heading"><span className="latex-dialog-icon"><FileCode size={22} /></span><div><h2>{t('latex.createInWorkspace')}</h2><p>{t('latex.workspaceCreateHint')}</p></div><button type="button" className="latex-icon-button" aria-label={t('common.close')} disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) void create('create') }}><label className="latex-dialog-label">{t('latex.projectTitle')}<input data-autofocus value={title} onChange={(event) => setTitle(event.target.value)} aria-label={t('latex.projectTitle')} placeholder={t('latex.titlePlaceholder')} disabled={busy} /></label><div className="latex-dialog-footer"><button type="button" className="latex-secondary-action" disabled={busy} onClick={() => void create('import')}><FolderOpen size={15} />{t('latex.import')}</button><button type="submit" className="latex-primary-action" disabled={busy || !title.trim()}>{busy ? <ArrowsClockwise size={15} className="latex-spin" /> : <Plus size={15} />}{t('latex.create')}</button></div></form>
    {error && <p className="latex-dialog-error" role="alert">{error}</p>}
    {(projects ?? []).length > 0 && <section className="latex-workspace-existing"><h3>{t('latex.workspaceProjects')}</h3>{projects.map((project) => <div key={project.id}><FileCode size={17} /><span><strong>{project.title}</strong><small>{project.rootFile}</small></span>{!items.some((item) => item.latexId === project.id) ? <button type="button" className="latex-text-button" disabled={busy} onClick={() => void pin(project)}>{t('latex.addCard')}</button> : <button type="button" className="latex-text-button" disabled={busy} onClick={() => { void onOpen(project).then(onClose).catch((reason) => setError(errorMessage(reason))) }}>{t('latex.openDocument')}</button>}</div>)}</section>}
  </div></div>, document.body)
}
