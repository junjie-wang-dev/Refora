import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { BookOpen, Copy, PencilSimple, SelectionAll, List, MagnifyingGlass, Columns, DownloadSimple, ClockCounterClockwise, X, FilePdf } from '@phosphor-icons/react'
import ReactMarkdown from 'react-markdown'
import { REMARK_PLUGINS, REHYPE_PLUGINS, createReforaDocMarkdownComponents, urlTransform } from '../../utils/markdown'
import { useDocumentStore } from '../../store/documentStore'
import { formatDate } from '../../utils/format'
import { IconTooltip, Input, PanelTabHeader } from '../ui'
import WorkspaceNavigationControls from './WorkspaceNavigationControls'
import { openDocumentPdf } from '../../utils/openPdf'
import i18n from '../../i18n'
import { useMarkdownDraft } from '../../hooks/useMarkdownDraft'
import { useMarkdownViewState } from '../../hooks/useMarkdownViewState'
import { useModalDialog } from '../../hooks/useModalDialog'
import MarkdownEditor, { type MarkdownEditorHandle } from '../markdown/MarkdownEditor'
import MarkdownNavigation from '../markdown/MarkdownNavigation'
import { downloadMarkdown, exportMarkdownPdf, markdownDocument } from '../../utils/markdownExport'
import '../markdown/markdownWorkspace.css'

export type WorkspaceMarkdownViewKind = 'note' | 'report' | 'summary'
export type WorkspaceMarkdownViewMode = 'read' | 'edit'

const MARKDOWN_COMPONENTS = createReforaDocMarkdownComponents(openDocumentPdf, () => useDocumentStore.getState().showToast(i18n.t('workspace.openDocFailed')))

interface WorkspaceMarkdownViewProps {
  kind: WorkspaceMarkdownViewKind
  id: string
  title: string
  contentMd: string
  timestamp: number
  initialMode?: WorkspaceMarkdownViewMode
  fullscreen?: boolean
  embedded?: boolean
  onBack: () => void
  onClose?: () => void
  onUpdate?: (id: string, patch: { title: string; contentMd: string }) => Promise<boolean>
}

export interface WorkspaceMarkdownViewHandle {
  requestClose: () => Promise<boolean>
}

const WorkspaceMarkdownView = forwardRef<WorkspaceMarkdownViewHandle, WorkspaceMarkdownViewProps>(function WorkspaceMarkdownView({ kind, id, title, contentMd, timestamp, initialMode = 'read', fullscreen = false, embedded = false, onBack, onClose, onUpdate }, ref) {
  const { t } = useTranslation()
  const [view, updateView, viewReady] = useMarkdownViewState(`${kind}.${id}`, initialMode)
  const editable = kind !== 'summary' && Boolean(onUpdate)
  const mode = editable ? view.mode : 'read'
  const [findOpen, setFindOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [dialog, setDialog] = useState<'history' | 'conflict' | null>(null)
  const [versionId, setVersionId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [pendingPdf, setPendingPdf] = useState(false)
  const articleRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const dialogRef = useModalDialog<HTMLDivElement>(Boolean(dialog), () => setDialog(null))
  const pendingOffset = useRef<number | null>(null)
  const isReport = kind === 'report'
  const titleLabel = t(isReport ? 'workspace.reportTitleLabel' : 'workspace.noteTitleLabel')
  const contentLabel = t(isReport ? 'workspace.reportContentLabel' : 'workspace.noteContentLabel')
  const typeLabel = t(kind === 'summary' ? 'workspace.aiSummary' : isReport ? 'workspace.cardTypeReport' : 'workspace.cardTypeNote')
  const draft = useMarkdownDraft({ kind, id, title, contentMd, editable, autoSave: mode === 'edit', onUpdate, messages: {
    saveFailed: t(isReport ? 'workspace.reportSaveFailed' : 'workspace.noteSaveFailed'),
    titleRequired: t('workspace.titleRequired'),
    externalConflict: t('workspace.externalUpdateConflict'),
    recoveryFailed: t('markdown.recoveryFailed')
  } })

  useImperativeHandle(ref, () => ({ requestClose: () => exporting ? Promise.resolve(false) : draft.requestClose() }), [draft.requestClose, exporting])

  const openFind = useCallback(() => {
    if (mode === 'edit') editorRef.current?.openFind()
    else setFindOpen(true)
  }, [mode])

  useEffect(() => {
    const surface = surfaceRef.current
    const handler = () => openFind()
    surface?.addEventListener('refora-markdown-find', handler)
    return () => surface?.removeEventListener('refora-markdown-find', handler)
  }, [openFind])

  useEffect(() => {
    if (!viewReady) return
    if (mode === 'read' && scrollRef.current) scrollRef.current.scrollTop = view.scrollTop
    if (mode === 'edit' && pendingOffset.current !== null) {
      editorRef.current?.revealOffset(pendingOffset.current)
      pendingOffset.current = null
    }
  }, [mode, viewReady])

  const changeMode = async (nextMode: WorkspaceMarkdownViewMode) => {
    if (nextMode === mode) return
    if (nextMode === 'read') {
      const position = editorRef.current?.getPosition()
      if (!await draft.flush()) return
      pendingOffset.current = position?.start ?? 0
      updateView({ mode: 'read', ...(position ? { position } : {}) })
    } else {
      const top = scrollRef.current?.getBoundingClientRect().top ?? 0
      const blocks = Array.from(articleRef.current?.querySelectorAll<HTMLElement>('[data-source-offset]') ?? [])
      const visible = blocks.filter((element) => { const rect = element.getBoundingClientRect(); return rect.top <= top && rect.bottom >= top }).at(-1) ?? blocks.find((element) => element.getBoundingClientRect().top >= top)
      pendingOffset.current = visible ? Number(visible.dataset.sourceOffset) : view.position.start
      updateView({ mode: 'edit' })
    }
    setFindOpen(false)
  }

  useEffect(() => {
    if (mode !== 'read' || pendingOffset.current === null) return
    const offset = pendingOffset.current
    pendingOffset.current = null
    const targets = Array.from(articleRef.current?.querySelectorAll<HTMLElement>('[data-source-offset]') ?? [])
    const target = targets.filter((element) => Number(element.dataset.sourceOffset) <= offset).at(-1)
    target?.scrollIntoView?.({ block: 'start' })
  }, [mode])

  useEffect(() => {
    if (mode !== 'edit' || !view.preview) return
    const preview = previewRef.current
    const offset = editorRef.current?.getPosition().start ?? 0
    const target = Array.from(articleRef.current?.querySelectorAll<HTMLElement>('[data-source-offset]') ?? []).filter((element) => Number(element.dataset.sourceOffset) <= offset).at(-1)
    if (preview && target) preview.scrollTop += target.getBoundingClientRect().top - preview.getBoundingClientRect().top - 16
  }, [mode, view.preview])

  useEffect(() => {
    if (!pendingPdf || mode !== 'read') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      const article = articleRef.current
      if (!article) return
      void exportMarkdownPdf(article, draft.draftTitle).catch(() => {
        useDocumentStore.getState().showToast(t('markdown.exportFailed'))
      }).finally(() => { if (!cancelled) { setExporting(false); setPendingPdf(false) } })
    }, 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [draft.draftTitle, mode, pendingPdf, t])

  const copyDraft = async (version = { title: draft.draftTitle, contentMd: draft.draftContent }) => {
    try {
      await window.api.clipboard.writeText(markdownDocument(version.title, version.contentMd))
      useDocumentStore.getState().showToast(t('markdown.copied'))
    } catch {
      useDocumentStore.getState().showToast(t('common.copyFailed'))
    }
  }

  const handleReadContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault()
    const article = articleRef.current
    if (!article) return
    const selection = window.getSelection()
    const selectionInsideArticle = Boolean(
      selection?.rangeCount
      && selection.anchorNode
      && selection.focusNode
      && (selection.anchorNode === article || article.contains(selection.anchorNode))
      && (selection.focusNode === article || article.contains(selection.focusNode))
    )
    const selectedText = selectionInsideArticle ? selection?.toString() ?? '' : ''
    const items: ContextMenuItem[] = [
      {
        key: 'copy',
        label: t('workspace.markdownCopy'),
        icon: <Copy className="h-3.5 w-3.5" />,
        disabled: !selectedText,
        onClick: () => {
          if (!selectedText) return
          void window.api.clipboard.writeText(selectedText).catch(() => {
            useDocumentStore.getState().showToast(i18n.t('common.copyFailed'))
          })
        }
      },
      {
        key: 'selectAll',
        label: t('workspace.markdownSelectAll'),
        icon: <SelectionAll className="h-3.5 w-3.5" />,
        disabled: !article.textContent,
        onClick: () => {
          const nextSelection = window.getSelection()
          if (!nextSelection) return
          const range = document.createRange()
          range.selectNodeContents(article)
          nextSelection.removeAllRanges()
          nextSelection.addRange(range)
        }
      }
    ]
    if (editable) {
      items.push(
        { type: 'divider', key: 'divider' },
        {
          key: 'edit',
          label: t('workspace.markdownEdit'),
          icon: <PencilSimple className="h-3.5 w-3.5" />,
          onClick: () => void changeMode('edit')
        }
      )
    }
    showContextMenu(items)
  }

  const handleBack = async () => { if (!exporting && await draft.flush()) onBack() }
  const handleClose = async () => { if (!exporting && await draft.flush()) onClose?.() }
  const button = (label: string, icon: React.ReactNode, action: () => void, pressed?: boolean, disabled = false) => <IconTooltip label={label} appearance="sidebar"><button type="button" className="sidebar-header-btn" aria-label={label} aria-pressed={pressed} disabled={disabled || exporting} onClick={action}>{icon}</button></IconTooltip>
  const modeActions = editable ? <div className="flex shrink-0 items-center gap-1" role="group" aria-label={t('workspace.markdownMode')}>
    {button(t('workspace.markdownRead'), <BookOpen size={17} />, () => void changeMode('read'), mode === 'read')}
    {button(t('workspace.markdownEdit'), <PencilSimple size={17} />, () => void changeMode('edit'), mode === 'edit')}
  </div> : null
  const renderedContent = mode === 'edit' ? draft.draftContent : draft.savedDraft.contentMd
  const renderArticle = () => <article ref={articleRef} className="markdown-body" onContextMenu={handleReadContextMenu}>
    <header className="markdown-document-heading">
      <p>{typeLabel}</p><h1>{mode === 'edit' ? draft.draftTitle : draft.savedDraft.title}</h1><p>{formatDate(timestamp)}</p>
    </header>
    {renderedContent ? <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={urlTransform}>{renderedContent}</ReactMarkdown> : <p className="italic text-muted">{t('workspace.markdownEmpty')}</p>}
  </article>
  const selectedVersion = draft.history.find((version) => version.id === versionId) ?? draft.history[0]
  const externalLines = draft.latestExternalDraft?.contentMd.split('\n') ?? []
  const localLines = draft.draftContent.split('\n')

  return <div ref={surfaceRef} data-markdown-surface className={`markdown-workspace ${fullscreen ? 'workspace-fullscreen' : ''}`} onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); openFind() }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void draft.flush() }
  }}>
    {!embedded && <PanelTabHeader title={draft.draftTitle || draft.savedDraft.title} onClose={onClose ? () => void handleClose() : undefined} closeLabel={t('workspace.close')} leading={<WorkspaceNavigationControls onBack={() => void handleBack()} />} actions={modeActions} />}
    <div className="markdown-workspace-toolbar" data-testid={embedded ? 'markdown-floating-actions' : undefined}>
      <div className="markdown-toolbar-group">
        {embedded && modeActions}
        {button(t('markdown.findDocument'), <MagnifyingGlass size={17} />, openFind)}
        {(mode === 'read' || view.preview) && button(t('markdown.outline'), <List size={17} />, () => setOutlineOpen((open) => !open), outlineOpen)}
        {mode === 'edit' && button(t('markdown.livePreview'), <Columns size={17} />, () => updateView({ preview: !view.preview }), view.preview)}
      </div>
      <div className="markdown-toolbar-group">
        {editable && <span className={`markdown-save-state ${draft.status === 'error' || draft.status === 'conflict' ? 'text-error' : ''}`} role="status">{t(exporting ? 'markdown.exporting' : `markdown.saveState.${draft.status}`)}</span>}
        {editable && button(t('markdown.versionHistory'), <ClockCounterClockwise size={17} />, () => { setVersionId(null); setDialog('history') })}
        {button(t('markdown.copyMarkdown'), <Copy size={17} />, () => void copyDraft())}
        {button(t('markdown.exportMarkdown'), <DownloadSimple size={17} />, () => downloadMarkdown(draft.draftTitle, draft.draftContent))}
        {button(t('markdown.exportPdf'), <FilePdf size={17} />, () => {
          void (async () => {
            if (!await draft.flush()) return
            setExporting(true)
            updateView({ mode: 'read' })
            setPendingPdf(true)
          })()
        }, undefined, exporting)}
      </div>
    </div>
    {draft.saveError && <div className="markdown-save-alert" role="alert"><span>{draft.saveError}</span>
      {draft.externalConflict ? <>
        <button type="button" onClick={() => setDialog('conflict')}>{t('markdown.compareVersions')}</button>
        <button type="button" disabled={draft.saving} onClick={draft.reloadExternalDraft}>{t('workspace.reloadExternalUpdate')}</button>
      </> : <button type="button" onClick={() => void draft.retry()}>{t('markdown.retrySave')}</button>}
      <button type="button" onClick={() => { draft.backupDraft(); downloadMarkdown(draft.draftTitle, draft.draftContent) }}>{t('markdown.saveDraftCopy')}</button>
    </div>}
    {draft.recoveredDraft && <div className="markdown-recovery-notice">{t('markdown.draftRecovered')}{mode === 'read' && <button type="button" onClick={() => void changeMode('edit')}>{t('workspace.markdownEdit')}</button>}</div>}
    <div className="markdown-content-region">
      <MarkdownNavigation articleRef={articleRef} content={renderedContent} findOpen={findOpen} outlineOpen={outlineOpen && (mode === 'read' || view.preview)} onCloseFind={() => setFindOpen(false)} onCloseOutline={() => setOutlineOpen(false)} onNavigate={(offset) => { editorRef.current?.revealOffset(offset); setOutlineOpen(false) }} />
      {mode === 'edit' ? <div className={`markdown-edit-layout ${view.preview ? 'with-preview' : ''}`}>
        <div className="markdown-editor-pane">
          <Input variant="borderless" inputSize="md" className="h-11 px-0 text-xl font-semibold hover:bg-transparent focus:bg-transparent focus:ring-0 focus-visible:outline-none" value={draft.draftTitle} onChange={(event) => draft.setDraftTitle(event.target.value)} aria-label={titleLabel} />
          <MarkdownEditor ref={editorRef} value={draft.draftContent} onChange={draft.setDraftContent} ariaLabel={contentLabel} initialPosition={view.position} onPositionChange={(position) => updateView({ position })} onScroll={(ratio) => {
            const preview = previewRef.current
            if (preview) preview.scrollTop = ratio * Math.max(0, preview.scrollHeight - preview.clientHeight)
          }} />
        </div>
        {view.preview && <div ref={previewRef} className="markdown-preview-pane" aria-label={t('markdown.livePreview')}>{renderArticle()}</div>}
      </div> : <div ref={scrollRef} className="markdown-reading-scroll" onScroll={(event) => updateView({ scrollTop: event.currentTarget.scrollTop })}>{renderArticle()}</div>}
    </div>
    {dialog && createPortal(<div className="markdown-dialog-backdrop" onClick={() => setDialog(null)}><div ref={dialogRef} className="markdown-history-dialog" role="dialog" aria-modal="true" aria-label={t(dialog === 'history' ? 'markdown.versionHistory' : 'markdown.compareVersions')} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
      <div className="markdown-dialog-heading"><strong>{t(dialog === 'history' ? 'markdown.versionHistory' : 'markdown.compareVersions')}</strong><button type="button" aria-label={t('common.close')} onClick={() => setDialog(null)}><X size={20} /></button></div>
      {dialog === 'history' ? <>
        <p>{t('markdown.historyHint')}</p>
        <div className="markdown-history-layout"><div className="markdown-version-list">
          {draft.history.map((version) => <button type="button" key={version.id} aria-pressed={selectedVersion?.id === version.id} onClick={() => setVersionId(version.id)}><strong>{version.title}</strong><span>{new Date(version.createdAt).toLocaleString()} · {t(`markdown.versionReason.${version.reason}`)}</span></button>)}
          {!draft.history.length && <p>{t('markdown.noVersions')}</p>}
        </div>{selectedVersion && <pre>{selectedVersion.contentMd}</pre>}</div>
        <div className="markdown-dialog-footer"><button type="button" onClick={() => void copyDraft(selectedVersion)}>{t('markdown.copyMarkdown')}</button>{selectedVersion && <button type="button" className="markdown-primary-action" onClick={() => { draft.restoreVersion(selectedVersion.id); updateView({ mode: 'edit' }); setDialog(null) }}>{t('markdown.restoreVersion')}</button>}</div>
      </> : <>
        <p>{t('markdown.conflictHint')}</p>
        <div className="markdown-version-comparison"><section><h3>{t('markdown.localVersion')}</h3><strong>{draft.draftTitle}</strong><pre>{localLines.map((line, index) => <span className={externalLines[index] === line ? '' : 'markdown-line-added'} key={index}>{line || ' '}<br /></span>)}</pre></section><section><h3>{t('markdown.externalVersion')}</h3><strong>{draft.latestExternalDraft?.title}</strong><pre>{externalLines.map((line, index) => <span className={localLines[index] === line ? '' : 'markdown-line-removed'} key={index}>{line || ' '}<br /></span>)}</pre></section></div>
        <div className="markdown-dialog-footer"><button type="button" disabled={draft.saving} onClick={() => { draft.reloadExternalDraft(); setDialog(null) }}>{t('workspace.reloadExternalUpdate')}</button><button type="button" className="markdown-primary-action" disabled={draft.saving} onClick={() => { void draft.keepLocalDraft().then((saved) => { if (saved) setDialog(null) }) }}>{t('markdown.keepLocalVersion')}</button></div>
      </>}
    </div></div>, document.body)}
  </div>
})

export default WorkspaceMarkdownView
