import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CaretRight, FileCode, FilePdf, Folder, Image, List, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import type { WorkspaceAsset } from '../../../shared/ipc-types'
import { latexFileTree, latexOutline, type LatexFileTree } from './latexNavigation'

export type LatexExplorerTab = 'files' | 'outline' | 'images'

interface Props {
  tab: LatexExplorerTab
  onTabChange: (tab: LatexExplorerTab) => void
  files: string[]
  currentFile: string
  rootFile: string
  source: string
  assets: WorkspaceAsset[]
  busy: boolean
  onOpen: (path: string) => void
  onInsert: (id: string) => void
  onNavigate: (line: number) => void
  onCreate: () => void
  onClose: () => void
}

export default function LatexExplorer({ tab, onTabChange, files, currentFile, rootFile, source, assets, busy, onOpen, onInsert, onNavigate, onCreate, onClose }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  useEffect(() => setQuery(''), [tab])
  const visibleFiles = useMemo(() => files.filter((file) => file.toLowerCase().includes(query.toLowerCase())), [files, query])
  const tree = useMemo(() => latexFileTree(visibleFiles), [visibleFiles])
  const headings = useMemo(() => latexOutline(source), [source])
  const figures = assets.filter((asset) => /\.(png|jpe?g|pdf|eps)$/i.test(asset.fileName) && asset.fileName.toLowerCase().includes(query.toLowerCase()))
  const renderTree = (node: LatexFileTree, prefix = '') => <>
    {Object.entries(node.folders).sort(([a], [b]) => a.localeCompare(b)).map(([folder, child]) => <details key={folder} className="latex-tree-folder" open>
      <summary><CaretRight size={12} /><Folder size={15} /><span>{folder}</span></summary>
      <div>{renderTree(child, `${prefix}${folder}/`)}</div>
    </details>)}
    {node.files.map((path) => <button key={path} type="button" className="latex-tree-file" aria-current={path === currentFile ? 'page' : undefined} disabled={busy} title={path} onClick={() => onOpen(path)}><FileCode size={15} /><span>{path.slice(prefix.length)}</span>{path === rootFile && <span className="latex-root-mark" title={t('latex.root')}>●</span>}</button>)}
  </>
  return <aside className="latex-explorer" aria-label={t('latex.files')}>
    <div className="latex-explorer-tabs" role="tablist" aria-label={t('latex.navigation')}>
      {([['files', Folder], ['outline', List], ['images', Image]] as const).map(([key, Icon]) => <button key={key} type="button" role="tab" aria-selected={tab === key} aria-label={t(`latex.${key}`)} title={t(`latex.${key}`)} onClick={() => { onTabChange(key); setQuery('') }}><Icon size={17} /></button>)}
      <button type="button" className="latex-icon-button latex-explorer-close" onClick={onClose} aria-label={t('latex.closeSidebar')}><X size={15} /></button>
    </div>
    <div className="latex-explorer-heading"><span>{t(`latex.${tab}`)}</span>{tab === 'files' && <button type="button" className="latex-icon-button" disabled={busy} aria-label={t('latex.newFile')} title={t('latex.newFile')} onClick={onCreate}><Plus size={15} /></button>}</div>
    {tab !== 'outline' && <label className="latex-filter"><MagnifyingGlass size={14} /><input aria-label={t('latex.filterFiles')} placeholder={t(tab === 'images' ? 'latex.filterImages' : 'latex.filterFiles')} value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
    <div className="latex-explorer-content" role="tabpanel">
      {tab === 'files' && <div className="latex-file-tree">{renderTree(tree)}{!visibleFiles.length && <p className="latex-panel-empty">{t('latex.noMatches')}</p>}</div>}
      {tab === 'outline' && <nav className="latex-outline">{headings.map((heading) => <button key={heading.line} type="button" style={{ paddingLeft: 12 + Math.max(0, heading.level - 1) * 12 }} onClick={() => onNavigate(heading.line)}><span>{heading.title}</span><small>{heading.line}</small></button>)}{!headings.length && <p className="latex-panel-empty">{t('latex.outlineEmpty')}</p>}</nav>}
      {tab === 'images' && <><p className="latex-asset-help">{t('latex.insertImageHint')}</p><div className="latex-asset-grid">{figures.map((asset) => <button key={asset.id} type="button" className="latex-asset-tile" aria-label={asset.fileName} title={t('latex.insertFigure', { name: asset.fileName })} disabled={busy} onClick={() => onInsert(asset.id)}><span className="latex-asset-thumbnail">{asset.previewKind === 'image' && !asset.fileMissing ? <img src={window.api.workspaceAssets.previewUrl(asset.id)} alt="" loading="lazy" /> : <FilePdf size={26} />}<span className="latex-asset-insert"><Plus size={16} /></span></span><span className="latex-asset-name">{asset.fileName}</span></button>)}</div>{!figures.length && <p className="latex-panel-empty">{t('latex.imagesEmpty')}</p>}</>}
    </div>
    <div className="latex-explorer-footer"><span className="latex-local-dot" />{t('latex.localProject')}</div>
  </aside>
}
