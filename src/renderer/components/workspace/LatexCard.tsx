import { FileCode, MinusCircle, PencilSimple } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import type { LatexProject } from '../../../shared/latex-types'
import { cardClassName } from '../ui'
import './latexCard.css'

export default function LatexCard({ project, onOpen, onRemove }: { project: LatexProject; onOpen: () => void; onRemove: () => void }) {
  const { t } = useTranslation()
  const sources = project.files.filter((path) => /\.(tex|bib|sty|cls)$/i.test(path))
  const figures = project.files.filter((path) => /\.(png|jpe?g|pdf|eps)$/i.test(path))
  return <div data-card-kind="latex" className={cardClassName('default', false, 'workspace-content-card workspace-latex-card group/card flex h-full w-full cursor-pointer flex-col gap-1.5 overflow-hidden p-3')} onClick={onOpen}>
    <div className="flex shrink-0 items-start gap-2">
      <div className="workspace-card-heading min-w-0 flex-1">
        <span className="workspace-card-type-label">LaTeX</span>
        <h3 className="workspace-card-title truncate text-base font-semibold text-foreground"><button type="button" title={project.title} className="max-w-full truncate rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={(event) => { event.stopPropagation(); onOpen() }}>{project.title}</button></h3>
        <p className="mt-0.5 text-xs text-muted">{t('latex.sourceFiles', { count: sources.length })} · {t('latex.figureCount', { count: figures.length })}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100">
        <button type="button" className="rounded p-1 text-muted transition-colors hover:text-accent" aria-label={t('latex.openDocument')} title={t('latex.openDocument')} onClick={(event) => { event.stopPropagation(); onOpen() }}><PencilSimple size={14} /></button>
        <button type="button" className="rounded p-1 text-muted transition-colors hover:text-error" aria-label={t('latex.removeCard')} title={t('latex.removeCard')} onClick={(event) => { event.stopPropagation(); onRemove() }}><MinusCircle size={14} /></button>
      </div>
    </div>
    <div data-card-scroll className="workspace-card-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain text-xs text-muted" onWheel={(event) => event.stopPropagation()}>
      <p className="workspace-latex-file" title={project.rootFile}><FileCode size={14} /><span>{project.rootFile}</span></p>
      {sources.filter((file) => file !== project.rootFile).slice(0, 3).map((file) => <p className="workspace-latex-file" key={file} title={file}><FileCode size={14} /><span>{file}</span></p>)}
    </div>
  </div>
}
