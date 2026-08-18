import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { BookOpen, Copy, PencilSimple, SelectionAll } from '@phosphor-icons/react'
import ReactMarkdown from 'react-markdown'
import {
  REMARK_PLUGINS,
  REHYPE_PLUGINS,
  createReforaDocMarkdownComponents,
  urlTransform
} from '../../utils/markdown'
import { useDocumentStore } from '../../store/documentStore'
import { formatDate } from '../../utils/format'
import { IconTooltip, Input, PanelTabHeader, Textarea } from '../ui'
import WorkspaceNavigationControls from './WorkspaceNavigationControls'
import { openDocumentPdf } from '../../utils/openPdf'

export type WorkspaceMarkdownViewKind = 'note' | 'report' | 'summary'
export type WorkspaceMarkdownViewMode = 'read' | 'edit'

interface MarkdownDraft {
  title: string
  contentMd: string
}

const MARKDOWN_COMPONENTS = createReforaDocMarkdownComponents(
  (docId) => openDocumentPdf(docId),
  () => useDocumentStore.getState().showToast(
    'Failed to open document. It may have been moved or deleted.'
  )
)

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

const WorkspaceMarkdownView = forwardRef<
  WorkspaceMarkdownViewHandle,
  WorkspaceMarkdownViewProps
>(function WorkspaceMarkdownView({
  kind,
  id,
  title,
  contentMd,
  timestamp,
  initialMode = 'read',
  fullscreen = false,
  embedded = false,
  onBack,
  onClose,
  onUpdate
}, ref) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<WorkspaceMarkdownViewMode>(
    kind === 'summary' ? 'read' : initialMode
  )
  const [draftTitle, setDraftTitle] = useState(title)
  const [draftContent, setDraftContent] = useState(contentMd)
  const [savedDraft, setSavedDraft] = useState({ title, contentMd })
  const [saveError, setSaveError] = useState<string | null>(null)
  const savedDraftRef = useRef<MarkdownDraft>({ title, contentMd })
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true))
  const articleRef = useRef<HTMLElement>(null)

  const isReport = kind === 'report'
  const editable = kind !== 'summary' && Boolean(onUpdate)
  const titleLabel = t(isReport ? 'workspace.reportTitleLabel' : 'workspace.noteTitleLabel')
  const contentLabel = t(isReport ? 'workspace.reportContentLabel' : 'workspace.noteContentLabel')
  const saveFailed = t(isReport ? 'workspace.reportSaveFailed' : 'workspace.noteSaveFailed')
  const typeLabel = t(kind === 'summary'
    ? 'workspace.aiSummary'
    : isReport ? 'workspace.cardTypeReport' : 'workspace.cardTypeNote')
  const isDirty = draftTitle !== savedDraft.title || draftContent !== savedDraft.contentMd

  const save = useCallback((draft: MarkdownDraft) => {
    if (!onUpdate) return Promise.resolve(true)
    const nextTitle = draft.title.trim()
    if (!nextTitle) {
      setSaveError(t('workspace.titleRequired'))
      return Promise.resolve(false)
    }

    const nextDraft = { title: nextTitle, contentMd: draft.contentMd }
    const run = async () => {
      if (
        savedDraftRef.current.title === nextDraft.title &&
        savedDraftRef.current.contentMd === nextDraft.contentMd
      ) {
        return true
      }
      setSaveError(null)
      let saved: boolean
      try {
        saved = await onUpdate(id, nextDraft)
      } catch {
        setSaveError(saveFailed)
        return false
      }
      if (!saved) {
        setSaveError(saveFailed)
        return false
      }
      savedDraftRef.current = nextDraft
      setSavedDraft(nextDraft)
      setDraftTitle((currentTitle) => currentTitle === draft.title ? nextTitle : currentTitle)
      return true
    }
    const queuedSave = saveQueueRef.current.then(run, run)
    saveQueueRef.current = queuedSave
    return queuedSave
  }, [id, onUpdate, saveFailed, t])

  useEffect(() => {
    if (!editable || mode !== 'edit' || !isDirty || !draftTitle.trim()) return
    const timeout = window.setTimeout(() => {
      void save({ title: draftTitle, contentMd: draftContent })
    }, 800)
    return () => window.clearTimeout(timeout)
  }, [draftContent, draftTitle, editable, isDirty, mode, save])

  const saveCurrentDraft = () => save({ title: draftTitle, contentMd: draftContent })

  const requestClose = async () => {
    if (!isDirty) return true
    return saveCurrentDraft()
  }

  useImperativeHandle(ref, () => ({ requestClose }))

  const changeMode = async (nextMode: WorkspaceMarkdownViewMode) => {
    if (nextMode === mode) return
    if (nextMode === 'read' && isDirty) {
      if (await saveCurrentDraft()) setMode('read')
      return
    }
    setSaveError(null)
    setMode(nextMode)
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
          void window.api.clipboard.writeText(selectedText).catch(() => {})
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

  const handleBack = async () => {
    if (isDirty) {
      if (await saveCurrentDraft()) onBack()
      return
    }
    onBack()
  }

  const handleClose = async () => {
    if (!onClose) return
    if (await requestClose()) onClose()
  }

  const modeActions = editable ? (
    <div
      className="flex shrink-0 items-center gap-1"
      role="group"
      aria-label={t('workspace.markdownMode')}
    >
      <IconTooltip label={t('workspace.markdownRead')} appearance="sidebar">
        <button
          type="button"
          className={[
            'sidebar-header-btn',
            mode === 'read' ? 'bg-active text-accent hover:bg-active' : ''
          ].filter(Boolean).join(' ')}
          aria-label={t('workspace.markdownRead')}
          aria-pressed={mode === 'read'}
          onClick={() => void changeMode('read')}
        >
          <BookOpen className="h-4 w-4" />
        </button>
      </IconTooltip>
      <IconTooltip label={t('workspace.markdownEdit')} appearance="sidebar">
        <button
          type="button"
          className={[
            'sidebar-header-btn',
            mode === 'edit' ? 'bg-active text-accent hover:bg-active' : ''
          ].filter(Boolean).join(' ')}
          aria-label={t('workspace.markdownEdit')}
          aria-pressed={mode === 'edit'}
          onClick={() => void changeMode('edit')}
        >
          <PencilSimple className="h-4 w-4" />
        </button>
      </IconTooltip>
    </div>
  ) : undefined

  const headerBar = !embedded ? (
    <PanelTabHeader
      title={draftTitle || savedDraft.title}
      onClose={onClose ? () => void handleClose() : undefined}
      closeLabel={t('workspace.close')}
      leading={<WorkspaceNavigationControls onBack={() => void handleBack()} />}
      actions={modeActions}
    />
  ) : null

  return (
    <div className={`relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background ${
      fullscreen ? 'workspace-fullscreen' : ''
    }`}>
      {headerBar}
      {embedded && modeActions ? (
        <div
          className="absolute right-5 top-5 z-20 flex items-center rounded-xl border border-border bg-background/95 p-1 shadow-lg backdrop-blur"
          data-testid="markdown-floating-actions"
        >
          {modeActions}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto flex min-h-full w-full max-w-4xl flex-col px-5 py-8 sm:px-10 ${
          embedded && modeActions ? 'pt-16' : ''
        }`}>
          {saveError && (
            <div className="mb-5 rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
              {saveError}
            </div>
          )}
          {mode === 'edit' ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <Input
                variant="borderless"
                inputSize="md"
                className="h-11 px-0 text-xl font-semibold hover:bg-transparent focus:bg-transparent focus:ring-0 focus-visible:outline-none"
                value={draftTitle}
                onChange={(event) => {
                  setDraftTitle(event.target.value)
                  setSaveError(null)
                }}
                aria-label={titleLabel}
              />
              <Textarea
                variant="borderless"
                textareaSize="md"
                className="min-h-[420px] flex-1 resize-none px-0 py-2 font-mono leading-6 hover:bg-transparent focus:bg-transparent focus:ring-0 focus-visible:outline-none"
                value={draftContent}
                onChange={(event) => {
                  setDraftContent(event.target.value)
                  setSaveError(null)
                }}
                aria-label={contentLabel}
              />
            </div>
          ) : (
            <article
              ref={articleRef}
              className="markdown-body select-text text-sm text-foreground [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-panel-2 [&_code]:px-1 [&_h1]:mt-0 [&_h1]:text-2xl [&_h2]:mt-8 [&_h3]:mt-6 [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-panel-2 [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5"
              onContextMenu={handleReadContextMenu}
            >
              <div className="mb-8 border-b border-border pb-5">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{typeLabel}</p>
                <h1 className="m-0 text-3xl font-semibold tracking-tight text-foreground">{savedDraft.title}</h1>
                <p className="mb-0 mt-3 text-xs text-muted">{formatDate(timestamp)}</p>
              </div>
              {savedDraft.contentMd ? (
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                  urlTransform={urlTransform}
                >
                  {savedDraft.contentMd}
                </ReactMarkdown>
              ) : (
                <p className="italic text-muted">{t('workspace.markdownEmpty')}</p>
              )}
            </article>
          )}
        </div>
      </div>
    </div>
  )
})

export default WorkspaceMarkdownView
