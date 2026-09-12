import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowsClockwise, CaretDown, Check, CheckCircle, Code, Columns, Copy, DotsThree, DownloadSimple, FileCode, FilePdf, FolderOpen, GearSix, Play, Plus, SidebarSimple, WarningCircle, X } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import type { LatexEngine, LatexFile, LatexProject, LatexRequest, LatexResponse } from '../../../shared/latex-types'
import { errorMessage } from '../../../shared/ipc-types'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { registerRendererFlushTask } from '../../persistence'
import LatexSourceEditor, { type LatexSourceHandle } from './LatexSourceEditor'
import LatexExplorer, { type LatexExplorerTab } from './LatexExplorer'
import { latexDiagnostics } from './latexNavigation'
import { useModalDialog } from '../../hooks/useModalDialog'
import LatexPdfPreview from './LatexPdfPreview'
import { ReaderToolbarButton } from '../ui'
import './latex.css'

function download(name: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface WorkspaceLatexViewHandle { requestClose: () => Promise<boolean> }
interface WorkspaceLatexViewProps {
  workspaceId: string
  active: boolean
  initialProject?: LatexProject
  onOpenProject?: (project: LatexProject) => Promise<void>
  onFileChange?: (projectId: string, path: string) => void
  manageActiveContext?: boolean
}

const WorkspaceLatexView = forwardRef<WorkspaceLatexViewHandle, WorkspaceLatexViewProps>(function WorkspaceLatexView({ workspaceId, active, initialProject, onOpenProject, onFileChange, manageActiveContext = true }, ref) {
  const { t } = useTranslation()
  const assets = useWorkspaceStore((state) => state.assets)
  const [projects, setProjects] = useState<LatexProject[]>([])
  const [project, setProject] = useState<LatexProject | null>(initialProject ?? null)
  const initial = useRef(initialProject)
  const [file, setFile] = useState<LatexFile | null>(null)
  const [draft, setDraft] = useState('')
  const [title, setTitle] = useState('')
  const [newPath, setNewPath] = useState('')
  const [engine, setEngine] = useState<LatexEngine>('pdflatex')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [pdf, setPdf] = useState('')
  const [view, setView] = useState<'source' | 'split' | 'preview'>('split')
  const [compact, setCompact] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [explorerTab, setExplorerTab] = useState<LatexExplorerTab>('files')
  const [menu, setMenu] = useState<'projects' | 'more' | null>(null)
  const [dialog, setDialog] = useState<'create' | 'file' | 'settings' | null>(null)
  const [position, setPosition] = useState({ line: 1, column: 1 })
  const [stale, setStale] = useState(false)
  const [builtAt, setBuiltAt] = useState<string | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [rawLog, setRawLog] = useState(false)
  const editor = useRef<LatexSourceHandle>(null)
  const menuElement = useRef<HTMLDivElement>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const [searchContainer, setSearchContainer] = useState<HTMLDivElement | null>(null)
  const navigatorTrigger = useRef<HTMLButtonElement>(null)
  const dialogElement = useModalDialog<HTMLDivElement>(Boolean(dialog), () => setDialog(null))
  const surface = useRef<HTMLDivElement>(null)
  const [log, setLog] = useState('')
  const [showLog, setShowLog] = useState(false)
  const session = useRef({ project, file, draft, conflict })
  session.current = { project, file, draft, conflict }
  const saveTask = useRef<Promise<boolean> | null>(null)
  const alive = useRef(true)
  const effectiveView = compact && view === 'split' ? 'source' : view
  const diagnostics = useMemo(() => latexDiagnostics(log), [log])

  useEffect(() => {
    const element = surface.current
    if (!element) return
    let wasCompact: boolean | null = null
    const measure = () => {
      if (element.clientWidth === 0) return
      const next = element.clientWidth < 800
      setCompact(next)
      if (wasCompact !== next) { setSidebarOpen(!next); wasCompact = next }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!menu) return
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Element && !menuElement.current?.contains(event.target) && !event.target.closest('.latex-menu-trigger')) setMenu(null)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(null); menuTrigger.current?.focus() } }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key) }
  }, [menu])
  const execute = useCallback((request: LatexRequest) => window.api.latex.execute(workspaceId, request), [workspaceId])
  const recoveryKey = useCallback((id: string, path: string) => `refora.latex.draft.${workspaceId}.${id}.${path}`, [workspaceId])

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback(async () => {
    const result = await execute({ action: 'list' })
    if (alive.current) setProjects(result.projects ?? [])
  }, [execute])
  useEffect(() => { void refresh().catch((reason) => setError(errorMessage(reason))) }, [refresh])
  useEffect(() => { if (menu === 'projects') void refresh().catch((reason) => setError(errorMessage(reason))) }, [menu, refresh])

  const save = useCallback(async (): Promise<boolean> => {
    if (saveTask.current) { if (!await saveTask.current) return false }
    const current = session.current
    if (!current.project || !current.file || current.draft === current.file.content) return true
    if (current.conflict) return false
    const task = (async () => {
      setSaving(true)
      try {
        const result = await execute({ action: 'write', projectId: current.project!.id, path: current.file!.path, content: current.draft, expectedHash: current.file!.hash })
        if (!result.file) throw new Error('Missing saved file')
        if (alive.current) {
          session.current.file = result.file
          setFile(result.file)
          setError('')
        }
        if (session.current.draft === current.draft) localStorage.removeItem(recoveryKey(current.project!.id, current.file!.path))
        return true
      } catch (reason) {
        setError(errorMessage(reason))
        if ((reason as { code?: string }).code === 'conflict') { session.current.conflict = true; setConflict(true) }
        return false
      } finally { setSaving(false) }
    })()
    saveTask.current = task
    try { return await task } finally { if (saveTask.current === task) saveTask.current = null }
  }, [execute, recoveryKey])

  useImperativeHandle(ref, () => ({ requestClose: async () => !busy && await save() }), [busy, save])

  useEffect(() => registerRendererFlushTask(async () => { if (!await save()) throw new Error(t('latex.unsaved')) }), [save, t])
  useEffect(() => {
    if (!file || !project || draft === file.content || conflict) return
    const timer = window.setTimeout(() => void save(), 700)
    return () => window.clearTimeout(timer)
  }, [draft, file, project, conflict, save])

  const changeDraft = (content: string) => {
    setStale(true)
    session.current.draft = content
    setDraft(content)
    const current = session.current
    if (current.file && current.project) {
      try { localStorage.setItem(recoveryKey(current.project.id, current.file.path), JSON.stringify({ content, hash: current.file.hash })) }
      catch { setError(t('latex.recoveryFailed')) }
    }
  }

  const loadFile = async (next: LatexProject, path: string, discard = false) => {
    if (!discard && !await save()) return
    const result = await execute({ action: 'read', projectId: next.id, path })
    if (!result.file || !alive.current) return
    let content = result.file.content
    let recoveredConflict = false
    const key = recoveryKey(next.id, path)
    if (discard) localStorage.removeItem(key)
    else {
      try {
        const recovered = JSON.parse(localStorage.getItem(key) || 'null') as { content?: string; hash?: string } | null
        if (typeof recovered?.content === 'string' && recovered.content !== content) { content = recovered.content; recoveredConflict = recovered.hash !== result.file.hash }
      } catch { setError(t('latex.recoveryFailed')) }
    }
    if (session.current.project?.id !== next.id) {
      setPdf(''); setLog(''); setView('split'); setBuiltAt(null); setStale(false)
    }
    setPosition({ line: 1, column: 1 })
    if (compact) setSidebarOpen(false)
    if (view === 'preview') setView('source')
    session.current = { project: next, file: result.file, draft: content, conflict: recoveredConflict }
    setProject(next); setFile(result.file); setDraft(content); setConflict(recoveredConflict)
    setError(recoveredConflict ? t('latex.conflict') : '')
    requestAnimationFrame(() => { if (active) editor.current?.focus() })
  }

  const loadFileRef = useRef(loadFile)
  loadFileRef.current = loadFile
  useEffect(() => {
    if (!initial.current) return
    let cancelled = false
    void execute({ action: 'project', projectId: initial.current.id }).then(async (result) => {
      if (!cancelled && result.project) await loadFileRef.current(result.project, result.project.rootFile)
    }).catch((reason) => { if (!cancelled) setError(errorMessage(reason)) })
    return () => { cancelled = true }
  }, [execute])

  useEffect(() => {
    if (project && file) onFileChange?.(project.id, file.path)
  }, [project?.id, file?.path, onFileChange])

  useEffect(() => {
    if (!manageActiveContext) return
    const request: LatexRequest = active && project && file ? { action: 'activate', projectId: project.id, path: file.path } : { action: 'activate' }
    void execute(request).catch((reason) => setError(errorMessage(reason)))
  }, [active, project?.id, file?.path, execute, manageActiveContext])
  useEffect(() => () => { if (manageActiveContext) void execute({ action: 'activate' }).catch(() => undefined) }, [execute, manageActiveContext])

  useEffect(() => {
    if (!project || !file || !active) return
    let cancelled = false
    let polling = false
    const timer = window.setInterval(() => {
      if (polling || saveTask.current || busy) return
      polling = true
      const baseHash = session.current.file?.hash
      void execute({ action: 'read', projectId: project.id, path: file.path }).then((result) => {
        if (cancelled || saveTask.current || !result.file) return
        const current = session.current
        if (current.project?.id !== project.id || current.file?.hash !== baseHash || current.file?.path !== result.file.path || current.file.hash === result.file.hash) return
        if (current.draft !== current.file.content) {
          session.current.conflict = true
          setConflict(true); setError(t('latex.conflict'))
        } else {
          session.current.file = result.file; session.current.draft = result.file.content
          setFile(result.file); setDraft(result.file.content); setStale(true)
        }
      }).catch((reason) => { if (!cancelled) setError(errorMessage(reason)) }).finally(() => { polling = false })
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [active, busy, execute, file?.path, project?.id, t])

  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    try { await operation() } catch (reason) { setError(errorMessage(reason)) } finally { setBusy(false) }
  }
  const chooseProject = async (result: LatexResponse) => {
    if (!result.project) return
    await refresh()
    if (onOpenProject) await onOpenProject(result.project)
    else await loadFile(result.project, result.project.rootFile)
  }
  const compile = () => run(async () => {
    if (!project || !await save()) return
    setError('')
    setCompiling(true)
    try {
      const result = await execute({ action: 'compile', projectId: project.id, engine })
      const compilation = result.compilation
      if (!compilation) return
      setLog(compilation.log)
      setShowLog(!compilation.success)
      if (compilation.success && compilation.pdfBase64) {
        setPdf(compilation.pdfBase64)
        setBuiltAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        setStale(false)
        if (compact) { setView('preview'); setSidebarOpen(false) }
      } else setError(t('latex.compileFailed'))
    } finally { setCompiling(false) }
  })
  const editable = project?.files.filter((path) => /\.(tex|bib|bst|cls|sty|cfg|def|clo|txt|bbl|bbx|cbx|lbx|ist|fd)$/i.test(path)) ?? []
  const changeView = (next: typeof view) => { setView(next); if (compact) setSidebarOpen(false) }
  const openProject = (next: LatexProject) => run(async () => {
    const result = await execute({ action: 'project', projectId: next.id })
    if (!await save()) return
    if (onOpenProject) await onOpenProject(result.project ?? next)
    else await loadFile(result.project ?? next, result.project?.rootFile ?? next.rootFile)
    setMenu(null)
  })
  const importProject = () => run(async () => { setMenu(null); if (await save()) await chooseProject(await execute({ action: 'import' })) })
  const insertAsset = (assetId: string) => run(async () => {
    if (!project) return
    const result = await execute({ action: 'asset', projectId: project.id, assetId })
    if (result.project) setProject(result.project)
    if (!result.assetPath) return
    const block = '\n\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{' + result.assetPath + '}\n  \\caption{}\n\\end{figure}\n'
    setView(compact ? 'source' : 'split')
    if (compact) setSidebarOpen(false)
    requestAnimationFrame(() => editor.current?.insert(block))
  })
  const jumpToLine = (line: number) => {
    setView(compact ? 'source' : 'split')
    if (compact) setSidebarOpen(false)
    requestAnimationFrame(() => editor.current?.revealLine(line))
  }
  const goToDiagnostic = (path: string, line: number) => run(async () => {
    if (!project) return
    const rootFolder = project.rootFile.split('/').slice(0, -1).join('/')
    const candidates = [path, rootFolder ? `${rootFolder}/${path}` : path]
    const target = candidates.find((candidate) => editable.includes(candidate))
    if (!target) return
    await loadFile(project, target)
    if (session.current.file?.path === target) jumpToLine(line)
  })
  const downloadPdf = () => {
    if (!project || !pdf) return
    download(project.rootFile.replace(/\.tex$/, '.pdf').split('/').at(-1) ?? 'paper.pdf', Uint8Array.from(atob(pdf), (character) => character.charCodeAt(0)), 'application/pdf')
  }
  const createProject = () => run(async () => {
    if (!title.trim() || !await save()) return
    await chooseProject(await execute({ action: 'create', title: title.trim() }))
    setTitle(''); setDialog(null)
  })
  const createFile = () => run(async () => {
    if (!project || !newPath.trim() || !await save()) return
    const result = await execute({ action: 'write', projectId: project.id, path: newPath.trim(), content: '', expectedHash: '' })
    if (result.project && result.file) { await loadFile(result.project, result.file.path); setNewPath(''); setDialog(null); setStale(true) }
  })

  const openFind = () => {
    changeView('source')
    if (compact) setSidebarOpen(false)
    requestAnimationFrame(() => editor.current?.openFind())
  }

  return <div ref={surface} className="latex-workspace" data-compact={compact || undefined} onKeyDown={(event) => {
    if (event.key === 'Escape' && compact && sidebarOpen && !menu && !dialog) { event.preventDefault(); event.stopPropagation(); setSidebarOpen(false); navigatorTrigger.current?.focus() }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); openFind() }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!busy) void compile() }
  }}>
    <header className="latex-topbar" data-editor={Boolean(project) || undefined}>
      {project ? <>
        <ReaderToolbarButton ref={navigatorTrigger} label={t('latex.toggleSidebar')} active={sidebarOpen} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><SidebarSimple size={16} /></ReaderToolbarButton>
        <span className="latex-toolbar-divider" />
        <button type="button" className="latex-current-file" title={file?.path} aria-label={t('latex.currentFile', { path: file?.path ?? '' })} aria-expanded={sidebarOpen && explorerTab === 'files'} onClick={() => { setExplorerTab('files'); setSidebarOpen(!(sidebarOpen && explorerTab === 'files')) }}><FileCode size={13} />{file?.path.includes('/') && <span className="latex-file-directory">{file.path.slice(0, file.path.lastIndexOf('/') + 1)}</span>}<span className="latex-file-basename">{file?.path.split('/').at(-1)}</span><CaretDown size={11} /></button>
        <div className="latex-view-switch" role="group" aria-label={t('latex.layout')}>
          <ReaderToolbarButton label={t('latex.edit')} active={effectiveView === 'source'} onClick={() => changeView('source')}><Code size={17} /></ReaderToolbarButton>
          <ReaderToolbarButton label={t('latex.preview')} active={effectiveView === 'preview'} onClick={() => changeView('preview')}><FilePdf size={17} /></ReaderToolbarButton>
          {!compact && <ReaderToolbarButton label={t('latex.split')} active={effectiveView === 'split'} onClick={() => changeView('split')}><Columns size={17} /></ReaderToolbarButton>}
        </div>
        <div ref={setSearchContainer} className="latex-search-slot" />

      </> : <button type="button" className="latex-project-trigger latex-menu-trigger" aria-label={t('latex.project')} aria-expanded={menu === 'projects'} onClick={(event) => { menuTrigger.current = event.currentTarget; setMenu(menu === 'projects' ? null : 'projects') }}><span className="latex-document-mark"><FileCode size={18} /></span><span>{t('latex.chooseProject')}</span><CaretDown size={12} /></button>}
      <div className="latex-topbar-actions">{project && <ReaderToolbarButton className="latex-compile-button" label={t('latex.compile')} shortcut="⌘Enter" disabled={busy || conflict || !file} onClick={() => void compile()}>{compiling ? <ArrowsClockwise size={16} className="latex-spin" /> : <Play size={16} />}<span>{t(compiling ? 'latex.compiling' : 'latex.compileLabel')}</span></ReaderToolbarButton>}<ReaderToolbarButton className="latex-menu-trigger" label={t('latex.moreActions')} aria-expanded={menu === 'more'} title={t('latex.moreActions')} onClick={(event) => { menuTrigger.current = event.currentTarget; setMenu(menu === 'more' ? null : 'more') }}><DotsThree size={20} /></ReaderToolbarButton></div>
    </header>
    {menu && <div ref={menuElement} className={`latex-popover is-${menu} ${project ? 'is-editor' : ''}`} role="dialog" aria-label={t(menu === 'projects' ? 'latex.projects' : 'latex.moreActions')}>
      {menu === 'projects' ? <><div className="latex-popover-heading">{t('latex.projects')}</div><div className="latex-project-list">{projects.map((entry) => <button type="button" key={entry.id} disabled={busy} onClick={() => void openProject(entry)}><FileCode size={17} /><span><strong>{entry.title}</strong><small>{entry.rootFile}</small></span>{project?.id === entry.id && <Check size={15} />}</button>)}{!projects.length && <p>{t('latex.noProjects')}</p>}</div><div className="latex-menu-divider" /><button type="button" disabled={busy} onClick={() => { setMenu(null); setDialog('create') }}><Plus size={16} />{t('latex.create')}</button><button type="button" disabled={busy} onClick={() => void importProject()}><FolderOpen size={16} />{t('latex.import')}</button></> : <>
        <button type="button" disabled={busy} onClick={() => setMenu('projects')}><FolderOpen size={16} />{t('latex.openProject')}</button>
        <button type="button" disabled={busy} onClick={() => { setMenu(null); setDialog('create') }}><Plus size={16} />{t('latex.create')}</button><button type="button" disabled={busy} onClick={() => void importProject()}><FolderOpen size={16} />{t('latex.import')}</button><div className="latex-menu-divider" />
        <button type="button" disabled={!file} onClick={() => { download(file?.path.split('/').at(-1) ?? 'draft.tex', draft, 'text/plain;charset=utf-8'); setMenu(null) }}><DownloadSimple size={16} />{t('latex.downloadDraft')}</button><button type="button" disabled={!pdf} onClick={() => { downloadPdf(); setMenu(null) }}><FilePdf size={16} />{t('latex.exportPdf')}</button><div className="latex-menu-divider" />
        <button type="button" onClick={() => { setMenu(null); setDialog('settings') }}><GearSix size={16} />{t('latex.buildSettings')}</button>
      </>}
    </div>}
    {error && <div className="latex-alert" role="alert"><WarningCircle size={17} /><span>{error}</span>{conflict && project && file && <button type="button" disabled={busy || saving} onClick={() => void run(() => loadFile(project, file.path, true))}>{t('latex.reload')}</button>}{file && <button type="button" onClick={() => download(file.path.split('/').at(-1) ?? 'draft.tex', draft, 'text/plain;charset=utf-8')}>{t('latex.downloadDraft')}</button>}</div>}
    {!project ? <div className="latex-start-screen"><div className="latex-welcome-icon"><FileCode size={32} weight="duotone" /></div><span className="latex-eyebrow">LATEX STUDIO</span><h1>{t('latex.welcomeTitle')}</h1><p>{t('latex.welcomeDescription')}</p><div className="latex-start-actions"><button type="button" className="latex-primary-action" disabled={busy} onClick={() => setDialog('create')}><Plus size={17} />{t('latex.create')}</button><button type="button" className="latex-secondary-action" disabled={busy} onClick={() => void importProject()}><FolderOpen size={17} />{t('latex.import')}</button></div>{projects.length > 0 && <section className="latex-recent-projects"><h2>{t('latex.recentProjects')}</h2>{projects.slice(0, 6).map((entry) => <button type="button" key={entry.id} disabled={busy} onClick={() => void openProject(entry)}><FileCode size={19} /><span><strong>{entry.title}</strong><small>{entry.rootFile} · {t('latex.fileCount', { count: entry.files.length })}</small></span><span className="latex-recent-arrow">↗</span></button>)}</section>}<div className="latex-welcome-note"><span className="latex-local-dot" />{t('latex.localOnly')}</div></div> : <>
      <div className="latex-workbench" data-view={effectiveView} data-sidebar={sidebarOpen || undefined}>
        {sidebarOpen && <>{compact && <button type="button" className="latex-explorer-scrim" aria-label={t('latex.closeSidebar')} onClick={() => setSidebarOpen(false)} />}<LatexExplorer tab={explorerTab} onTabChange={setExplorerTab} files={editable} currentFile={file?.path ?? ''} rootFile={project.rootFile} source={draft} assets={assets} busy={busy} onClose={() => setSidebarOpen(false)} onCreate={() => setDialog('file')} onOpen={(path) => void run(() => loadFile(project, path))} onInsert={(id) => void insertAsset(id)} onNavigate={jumpToLine} /></>}
        <div className="latex-editing-surfaces"><section className="latex-editor-region" aria-label={t('latex.edit')}>{file && <LatexSourceEditor ref={editor} key={`${project.id}:${file.path}`} value={draft} onChange={changeDraft} disabled={busy} searchContainer={searchContainer} onSearchFocus={() => { if (effectiveView === 'preview') changeView('source'); if (compact) setSidebarOpen(false) }} onPositionChange={(line, column) => setPosition({ line, column })} />}</section>
          <section className="latex-preview-region" aria-label={t('latex.previewPane')}>{pdf ? <LatexPdfPreview data={pdf} stale={stale} onDownload={downloadPdf} /> : <div className="latex-preview-empty"><div className="latex-preview-sheet"><FilePdf size={30} weight="thin" /><span /><span /><span /></div><h3>{t('latex.previewReady')}</h3><p>{t('latex.previewDescription')}</p><button type="button" className="latex-text-button" disabled={busy || conflict} onClick={() => void compile()}><Play size={13} />{t('latex.compileLabel')}</button><kbd>⌘ ↵</kbd></div>}</section>
        </div>
      </div>
      {showLog && <section className="latex-build-panel" aria-label={t('latex.log')}><div className="latex-build-heading"><span>{error ? <WarningCircle size={15} /> : <CheckCircle size={15} />}{t('latex.log')}{diagnostics.length > 0 && <small>{diagnostics.length}</small>}</span><div><button type="button" className="latex-text-button" aria-pressed={rawLog} onClick={() => setRawLog(!rawLog)}>{t('latex.rawLog')}</button><button type="button" className="latex-icon-button" aria-label={t('latex.copyLog')} onClick={() => void window.api.clipboard.writeText(log).catch((reason) => setError(errorMessage(reason)))}><Copy size={14} /></button><button type="button" className="latex-icon-button" aria-label={t('latex.closeLog')} onClick={() => setShowLog(false)}><X size={15} /></button></div></div>{rawLog || !diagnostics.length ? <pre className="latex-log">{log || t('latex.noLog')}</pre> : <div className="latex-diagnostics">{diagnostics.map((item, index) => <button type="button" key={index} onClick={() => void goToDiagnostic(item.file, item.line)}><WarningCircle size={14} /><span>{item.message}</span><small>{item.file}:{item.line}</small></button>)}</div>}</section>}
      <footer className="latex-statusbar"><button type="button" aria-label={t('latex.save')} title={t('latex.save')} className="latex-save-indicator" data-dirty={draft !== file?.content || undefined} disabled={saving || conflict || busy} onClick={() => void save()}>{saving ? <ArrowsClockwise size={12} className="latex-spin" /> : error ? <WarningCircle size={12} /> : <Check size={12} />}<span role="status">{t(saving ? 'latex.saving' : draft !== file?.content ? 'latex.unsaved' : 'latex.saved')}</span></button><button type="button" className="latex-build-status" data-error={Boolean(error) || undefined} onClick={() => setShowLog(!showLog)} aria-label={t('latex.log')} aria-expanded={showLog}>{compiling ? t('latex.compiling') : stale && pdf ? t('latex.previewStale') : builtAt ? t('latex.builtAt', { time: builtAt }) : t('latex.ready')}</button><span className="latex-cursor-position">{t('latex.position', position)}</span><button type="button" className="latex-engine-label" title={t('latex.buildSettings')} onClick={() => setDialog('settings')}>{engine === 'pdflatex' ? 'pdfLaTeX' : engine === 'xelatex' ? 'XeLaTeX' : 'LuaLaTeX'}</button></footer>
    </>}
    {dialog && createPortal(<div className="latex-modal-backdrop" onClick={() => { if (!busy) setDialog(null) }}><div ref={dialogElement} className="latex-dialog" role="dialog" aria-modal="true" aria-label={t(dialog === 'create' ? 'latex.create' : dialog === 'file' ? 'latex.newFile' : 'latex.buildSettings')} tabIndex={-1} onClick={(event) => event.stopPropagation()}><div className="latex-dialog-heading"><span className="latex-dialog-icon">{dialog === 'settings' ? <GearSix size={21} /> : <FileCode size={21} />}</span><div><h2>{t(dialog === 'create' ? 'latex.create' : dialog === 'file' ? 'latex.newFile' : 'latex.buildSettings')}</h2><p>{t(dialog === 'create' ? 'latex.createHint' : dialog === 'file' ? 'latex.newFileHint' : 'latex.settingsHint')}</p></div><button type="button" className="latex-icon-button" aria-label={t('common.close')} disabled={busy} onClick={() => setDialog(null)}><X size={18} /></button></div>
      {dialog === 'settings' ? <div className="latex-settings-fields">{project && <label>{t('latex.root')}<select aria-label={t('latex.root')} disabled={busy} value={project.rootFile} onChange={(event) => { const path = event.target.value; void run(async () => { if (!await save()) return; const result = await execute({ action: 'root', projectId: project.id, path }); if (result.project) { setProject(result.project); setStale(true) } }) }}>{project.files.filter((path) => path.endsWith('.tex')).map((path) => <option key={path}>{path}</option>)}</select></label>}<label>{t('latex.engine')}<select aria-label={t('latex.engine')} value={engine} disabled={busy} onChange={(event) => { setEngine(event.target.value as LatexEngine); setStale(true) }}><option value="pdflatex">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option></select></label><div className="latex-runtime-setting"><span><strong>{t('latex.localCompiler')}</strong><p>{t('latex.runtimeHint')}</p></span><button type="button" className="latex-secondary-action" disabled={busy} onClick={() => void run(async () => { await execute({ action: 'configure' }); setError('') })}>{t('latex.configure')}</button></div><div className="latex-dialog-footer"><button type="button" className="latex-primary-action" onClick={() => setDialog(null)}>{t('latex.done')}</button></div></div> : <form onSubmit={(event) => { event.preventDefault(); void (dialog === 'create' ? createProject() : createFile()) }}><label className="latex-dialog-label">{t(dialog === 'create' ? 'latex.projectTitle' : 'latex.fileName')}<input data-autofocus aria-label={t(dialog === 'create' ? 'latex.projectTitle' : 'latex.newFile')} placeholder={dialog === 'create' ? t('latex.titlePlaceholder') : 'sections/introduction.tex'} value={dialog === 'create' ? title : newPath} onChange={(event) => dialog === 'create' ? setTitle(event.target.value) : setNewPath(event.target.value)} disabled={busy} /></label>{error && <p className="latex-dialog-error" role="alert">{error}</p>}<div className="latex-dialog-footer"><button type="button" className="latex-secondary-action" disabled={busy} onClick={() => setDialog(null)}>{t('common.cancel')}</button><button type="submit" className="latex-primary-action" disabled={busy || !(dialog === 'create' ? title : newPath).trim()}>{busy && <ArrowsClockwise size={14} className="latex-spin" />}{t(dialog === 'create' ? 'latex.create' : 'latex.newFile')}</button></div></form>}
    </div></div>, document.body)}
  </div>
})

export default WorkspaceLatexView
