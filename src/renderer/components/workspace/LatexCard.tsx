import { ArrowSquareOut, FileCode, Files, MinusCircle } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import type { LatexProject } from '../../../shared/latex-types'
import { cardClassName } from '../ui'
import './latexCard.css'

export default function LatexCard({ project, onOpen, onRemove }: { project: LatexProject; onOpen: () => void; onRemove: () => void }) {
  const { t } = useTranslation()
  const sources = project.files.filter((path) => /\.(tex|bib|sty|cls)$/i.test(path))
  const figures = project.files.filter((path) => /\.(png|jpe?g|pdf|eps)$/i.test(path))
  return <div data-card-kind="latex" className={`${cardClassName('default', false)} workspace-latex-card group/card`} onClick={onOpen}>
    <div className="workspace-latex-card-heading"><span className="workspace-card-type-label">LATEX</span><button type="button" className="workspace-latex-remove" aria-label={t('latex.removeCard')} title={t('latex.removeCard')} onClick={(event) => { event.stopPropagation(); onRemove() }}><MinusCircle size={16} /></button></div>
    <h3 className="workspace-card-title"><button type="button" onClick={(event) => { event.stopPropagation(); onOpen() }}>{project.title}</button></h3>
    <div className="workspace-latex-document"><FileCode size={25} weight="duotone" /><div><strong>{project.rootFile}</strong><span>{t('latex.sourceFiles', { count: sources.length }) + ' · ' + t('latex.figureCount', { count: figures.length })}</span></div></div>
    <div className="workspace-latex-files">{project.files.filter((file) => file !== project.rootFile).slice(0, 2).map((file) => <span key={file} title={file}><Files size={11} />{file.split('/').at(-1)}</span>)}</div>
    <footer><span>{t('latex.workspaceDocument')}</span><span>{t('latex.openDocument')}<ArrowSquareOut size={13} /></span></footer>
  </div>
}
