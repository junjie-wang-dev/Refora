import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CaretRight, File, FileCode, FilePdf, Folder, Image, List, MagnifyingGlass, Plus, PencilSimple, Trash, UploadSimple, X } from '@phosphor-icons/react'
import type { WorkspaceAsset } from '../../../shared/ipc-types'
import { isEditableLatexFile, latexFileTree, latexOutline, latexProjectOutline, type LatexProjectSource, type LatexFileTree } from './latexNavigation'

export type LatexExplorerTab = 'files' | 'outline' | 'images' | 'search'

interface Props {
  tab: LatexExplorerTab
  onTabChange: (tab: LatexExplorerTab) => void
  files: string[]
  reviewFiles?: string[]
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
  projectSources?: LatexProjectSource[]
  onNavigateFile?: (path: string, line: number) => void
  onRename?: (path: string, newPath: string) => void | Promise<void>
  onDelete?: (path: string) => void | Promise<void>
  onImport?: () => void
  onPreview?: (path: string) => void
}

export default function LatexExplorer({ tab, onTabChange, files, currentFile, rootFile, source, assets, busy, onOpen, onInsert, onNavigate, onCreate, onClose, reviewFiles = [], projectSources, onNavigateFile, onRename, onDelete, onImport, onPreview }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [operation, setOperation] = useState<{ kind: 'rename' | 'delete'; path: string } | null>(null)
  const [newPath, setNewPath] = useState('')
  const [operationError, setOperationError] = useState('')
  const [pending, setPending] = useState(false)
  const runOperation = async () => {
    if (!operation) return
    setPending(true)
    setOperationError('')
    try {
      if (operation.kind === 'rename') await onRename?.(operation.path, newPath.trim())
      else await onDelete?.(operation.path)
      setOperation(null)
    } catch (reason) { setOperationError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setPending(false) }
  }
  const beginOperation = (kind: 'rename' | 'delete', path: string) => { setOperation({ kind, path }); setNewPath(path); setOperationError('') }
  const navigate = (path: string, line: number) => { if (onNavigateFile) onNavigateFile(path, line); else if (path === currentFile) onNavigate(line) }

  useEffect(() => setQuery(''), [tab])
  const visibleFiles = useMemo(() => files.filter((file) => file.toLowerCase().includes(query.toLowerCase())), [files, query])
  const tree = useMemo(() => latexFileTree(visibleFiles), [visibleFiles])
  const headings = useMemo(() => projectSources ? latexProjectOutline(projectSources.map((entry) => entry.path === currentFile ? { ...entry, content: source } : entry), rootFile) : latexOutline(source), [projectSources, currentFile, rootFile, source])
  const searchResults = useMemo(() => {
    if (!query.trim()) return []
    const needle = query.toLocaleLowerCase()
    return (projectSources ?? [{ path: currentFile, content: source }]).flatMap((entry) => (entry.path === currentFile ? source : entry.content).split('\n').flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [{ path: entry.path, line: index + 1, text: line.trim() }] : []))
  }, [query, projectSources, currentFile, source])
  const figures = assets.filter((asset) => /\.(png|jpe?g|pdf|eps)$/i.test(asset.fileName) && asset.fileName.toLowerCase().includes(query.toLowerCase()))
  const renderTree = (node: LatexFileTree, prefix = '') => <>
    {Object.entries(node.folders).sort(([a], [b]) => a.localeCompare(b)).map(([folder, child]) => <details key={folder} className="latex-tree-folder" open>
      <summary><CaretRight size={12} /><Folder size={15} /><span>{folder}</span></summary>
      <div>{renderTree(child, `${prefix}${folder}/`)}</div>
    </details>)}
    {node.files.map((path) => {
      const editable = isEditableLatexFile(path)
      const Icon = editable ? FileCode : /\.(png|jpe?g|eps|svg|webp)$/i.test(path) ? Image : /\.pdf$/i.test(path) ? FilePdf : File
      const content = <><Icon size={15} /><span>{path.slice(prefix.length)}</span>{reviewFiles.includes(path) && <span className="latex-review-file" title={t('latex.aiReview')}>AI</span>}{path === rootFile && <span className="latex-root-mark" title={t('latex.root')}>●</span>}</>
      return <div className="latex-tree-row" key={path}><button type="button" className="latex-tree-file" aria-current={path === currentFile ? 'page' : undefined} disabled={busy || (!editable && !onPreview)} title={path} onClick={() => editable ? onOpen(path) : onPreview?.(path)}>{content}</button><span className="latex-file-actions">{onRename && <button type="button" className="latex-icon-button" aria-label={t('latex.renameFile', { path })} title={t('latex.renameFile', { path })} disabled={busy || pending} onClick={() => beginOperation('rename', path)}><PencilSimple size={13} /></button>}{onDelete && <button type="button" className="latex-icon-button" aria-label={t('latex.deleteFile', { path })} title={t('latex.deleteFile', { path })} disabled={busy || pending || path === rootFile} onClick={() => beginOperation('delete', path)}><Trash size={13} /></button>}</span></div>
    })}
  </>
  return <aside className="latex-explorer" aria-label={t('latex.files')}>
    <div className="latex-explorer-tabs" role="tablist" aria-label={t('latex.navigation')}>
      {([['files', Folder], ['outline', List], ['images', Image], ['search', MagnifyingGlass]] as const).map(([key, Icon]) => <button key={key} type="button" role="tab" aria-selected={tab === key} aria-label={t(`latex.${key}`)} title={t(`latex.${key}`)} onClick={() => { onTabChange(key); setQuery('') }}><Icon size={17} /></button>)}
      <button type="button" className="latex-icon-button latex-explorer-close" onClick={onClose} aria-label={t('latex.closeSidebar')}><X size={15} /></button>
    </div>
    <div className="latex-explorer-heading"><span>{t(`latex.${tab}`)}</span>{tab === 'files' && <>{onImport && <button type="button" className="latex-icon-button" disabled={busy} aria-label={t('latex.importFiles')} title={t('latex.importFiles')} onClick={onImport}><UploadSimple size={15} /></button>}<button type="button" className="latex-icon-button" disabled={busy} aria-label={t('latex.newFile')} title={t('latex.newFile')} onClick={onCreate}><Plus size={15} /></button></>}</div>
    {tab !== 'outline' && <label className="latex-filter"><MagnifyingGlass size={14} /><input aria-label={t(tab === 'search' ? 'latex.searchProject' : 'latex.filterFiles')} placeholder={t(tab === 'search' ? 'latex.searchProject' : tab === 'images' ? 'latex.filterImages' : 'latex.filterFiles')} value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
    {operation && <form className="latex-file-operation" onSubmit={(event) => { event.preventDefault(); void runOperation() }}><strong>{t(operation.kind === 'rename' ? 'latex.renameMove' : 'latex.confirmDeleteFile', { path: operation.path })}</strong>{operation.kind === 'rename' && <p>{t('latex.renameReferencesHint')}</p>}{operation.kind === 'rename' && <input autoFocus aria-label={t('latex.filePath')} value={newPath} disabled={pending} onChange={(event) => setNewPath(event.target.value)} />}{operationError && <p role="alert">{operationError}</p>}<div><button type="submit" className="latex-text-button" disabled={busy || pending || (operation.kind === 'rename' && (!newPath.trim() || newPath.trim() === operation.path))}>{t(operation.kind === 'rename' ? 'latex.applyFileChange' : 'latex.deleteFileAction')}</button><button type="button" className="latex-text-button" disabled={pending} onClick={() => setOperation(null)}>{t('common.cancel')}</button></div></form>}
    <div className="latex-explorer-content" role="tabpanel">
      {tab === 'files' && <div className="latex-file-tree">{renderTree(tree)}{!visibleFiles.length && <p className="latex-panel-empty">{t('latex.noMatches')}</p>}</div>}
      {tab === 'outline' && <nav className="latex-outline">{headings.map((heading) => <button key={`${heading.file ?? currentFile}:${heading.line}`} type="button" style={{ paddingLeft: 12 + Math.max(0, heading.level - 1) * 12 }} title={heading.file} onClick={() => navigate(heading.file ?? currentFile, heading.line)}><span>{heading.title}</span><small>{heading.file && heading.file !== currentFile ? `${heading.file}:` : ''}{heading.line}</small></button>)}{!headings.length && <p className="latex-panel-empty">{t('latex.outlineEmpty')}</p>}</nav>}
      {tab === 'search' && <div className="latex-project-results">{searchResults.map((result) => <button type="button" key={`${result.path}:${result.line}`} onClick={() => navigate(result.path, result.line)}><small>{result.path}:{result.line}</small><span>{result.text}</span></button>)}{!searchResults.length && <p className="latex-panel-empty">{t(query.trim() ? 'latex.noMatches' : 'latex.searchProjectHint')}</p>}</div>}
      {tab === 'images' && <><p className="latex-asset-help">{t('latex.insertImageHint')}</p><div className="latex-asset-grid">{figures.map((asset) => <button key={asset.id} type="button" className="latex-asset-tile" aria-label={asset.fileName} title={t('latex.insertFigure', { name: asset.fileName })} disabled={busy} onClick={() => onInsert(asset.id)}><span className="latex-asset-thumbnail">{asset.previewKind === 'image' && !asset.fileMissing ? <img src={window.api.workspaceAssets.previewUrl(asset.id)} alt="" loading="lazy" /> : <FilePdf size={26} />}<span className="latex-asset-insert"><Plus size={16} /></span></span><span className="latex-asset-name">{asset.fileName}</span></button>)}</div>{!figures.length && <p className="latex-panel-empty">{t('latex.imagesEmpty')}</p>}</>}
    </div>
    <div className="latex-explorer-footer"><span className="latex-local-dot" />{t('latex.localProject')}</div>
  </aside>
}
