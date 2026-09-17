import { FolderOpen, MinusCircle, PencilSimple } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import type { LatexProject } from '../../../shared/latex-types'
import { cardClassName } from '../ui'
import './latexCard.css'

export default function LatexCard({ project, onOpen, onRemove }: { project: LatexProject; onOpen: () => void; onRemove: () => void }) {
  const { t } = useTranslation()
  const figures = project.files.filter((path) => /\.(png|jpe?g|pdf|eps)$/i.test(path))
  return <div data-card-kind="latex" className={cardClassName('default', false, 'workspace-content-card workspace-latex-card group/card flex h-full w-full cursor-pointer flex-col gap-1.5 overflow-hidden p-3')} onClick={onOpen}>
    <div className="flex shrink-0 items-start gap-2">
      <div className="workspace-card-heading min-w-0 flex-1">
        <span className="workspace-card-type-label">{t('latex.project')}</span>
        <h3 className="workspace-card-title truncate text-base font-semibold text-foreground"><button type="button" title={project.title} className="max-w-full truncate rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={(event) => { event.stopPropagation(); onOpen() }}>{project.title}</button></h3>
        <p className="mt-0.5 text-xs text-muted">{t('latex.fileCount', { count: project.files.length })} · {t('latex.figureCount', { count: figures.length })}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100">
        <button type="button" className="rounded p-1 text-muted transition-colors hover:text-accent" aria-label={t('latex.openDocument')} title={t('latex.openDocument')} onClick={(event) => { event.stopPropagation(); onOpen() }}><PencilSimple size={14} /></button>
        <button type="button" className="rounded p-1 text-muted transition-colors hover:text-error" aria-label={t('latex.removeCard')} title={t('latex.removeCard')} onClick={(event) => { event.stopPropagation(); onRemove() }}><MinusCircle size={14} /></button>
      </div>
    </div>
    <div className="workspace-latex-template" title={t('latex.template', { name: project.template || t('latex.unknownTemplate') })}>
      <FolderOpen size={14} /><span>{t('latex.template', { name: project.template || t('latex.unknownTemplate') })}</span>
    </div>
  </div>
}
