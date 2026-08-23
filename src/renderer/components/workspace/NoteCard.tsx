import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Button, showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { Copy, Download, PencilSimple, Trash } from '@phosphor-icons/react'
import { motion, MotionConfig } from 'motion/react'
import ReactMarkdown from 'react-markdown'
import {
  REMARK_PLUGINS,
  REHYPE_PLUGINS,
  createReforaDocMarkdownComponents,
  urlTransform
} from '../../utils/markdown'
import { useDocumentStore } from '../../store/documentStore'
import { formatDate } from '../../utils/format'
import { boardCardPreview } from '../../utils/workspaceCardMarkdown'
import { Input as UiInput, Textarea as UiTextarea, cardClassName } from '../ui'
import type { WorkspaceNote } from '../../../shared/ipc-types'
import { openDocumentPdf } from '../../utils/openPdf'
import i18n from '../../i18n'

const MARKDOWN_COMPONENTS = createReforaDocMarkdownComponents(
  (docId) => openDocumentPdf(docId),
  () => useDocumentStore.getState().showToast(
    i18n.t('workspace.openDocFailed') as string
  )
)

interface NoteCardProps {
  note: WorkspaceNote
  autoEdit?: boolean
  onAutoEditHandled?: () => void
  onDelete: () => void
  onUpdate: (id: string, patch: { title?: string; contentMd?: string }) => Promise<boolean>
  onOpen?: () => void
  onEdit?: () => void
  onCopy?: () => void
}

export default function NoteCard({
  note,
  autoEdit = false,
  onAutoEditHandled,
  onDelete,
  onUpdate,
  onOpen,
  onEdit,
  onCopy
}: NoteCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(note.title)
  const [editContent, setEditContent] = useState(note.contentMd)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const boardPreview = useMemo(() => boardCardPreview(note.contentMd), [note.contentMd])

  const enterEditMode = () => {
    setEditTitle(note.title)
    setEditContent(note.contentMd)
    setSaveError(null)
    setEditing(true)
  }

  useEffect(() => {
    if (!autoEdit) return
    setExpanded(true)
    enterEditMode()
    onAutoEditHandled?.()
  }, [autoEdit, onAutoEditHandled])

  const handleExportMarkdown = () => {
    const blob = new Blob([`# ${note.title}\n\n${note.contentMd}`], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${note.title.replace(/[^\w\u4e00-\u9fff\s-]/g, '').trim() || 'note'}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const items: ContextMenuItem[] = [
      {
        key: 'copy',
        label: t('workspace.cardCopy'),
        icon: <Copy className="h-3.5 w-3.5" />,
        onClick: () => onCopy?.()
      },
      {
        key: 'edit',
        label: t('workspace.noteEdit'),
        icon: <PencilSimple className="h-3.5 w-3.5" />,
        onClick: () => {
          if (onEdit) onEdit()
          else {
            setExpanded(true)
            enterEditMode()
          }
        }
      },
      {
        key: 'export',
        label: t('workspace.noteExportMd'),
        icon: <Download className="h-3.5 w-3.5" />,
        onClick: handleExportMarkdown
      },
      {
        key: 'delete',
        label: t('workspace.noteDelete'),
        icon: <Trash className="h-3.5 w-3.5" />,
        onClick: () => {
          setExpanded(true)
          setConfirmDelete(true)
        },
        danger: true
      }
    ]
    showContextMenu(items)
  }

  const closeModal = () => {
    setExpanded(false)
    setConfirmDelete(false)
    setEditing(false)
    setSaveError(null)
  }

  const handleSave = async () => {
    if (!editTitle.trim()) {
      setSaveError(t('workspace.titleRequired'))
      return
    }
    setSaving(true)
    setSaveError(null)
    const saved = await onUpdate(note.id, { title: editTitle.trim(), contentMd: editContent })
    setSaving(false)
    if (saved) setEditing(false)
    else setSaveError(t('workspace.noteSaveFailed'))
  }

  const handleCancelEdit = () => {
    setEditTitle(note.title)
    setEditContent(note.contentMd)
    setEditing(false)
    setSaveError(null)
  }

  const openCard = () => {
    if (onOpen) onOpen()
    else setExpanded(true)
  }

  return (
    <>
      <MotionConfig reducedMotion="user">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          data-card-kind="note"
          className={cardClassName('default', false, 'workspace-content-card workspace-content-card--note group/card flex h-full w-full cursor-pointer flex-col gap-2 overflow-hidden p-3')}
          onClick={openCard}
          onContextMenu={handleContextMenu}
        >
          <div className="flex shrink-0 items-start gap-2">
            <div className="workspace-card-heading min-w-0 flex-1">
              <span className="workspace-card-type-label">{t('workspace.cardTypeNote')}</span>
              <h3 className="workspace-card-title line-clamp-2 text-base font-semibold text-foreground">
                <button
                  type="button"
                  className="rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  onClick={(event) => {
                    event.stopPropagation()
                    openCard()
                  }}
                >
                  {note.title}
                </button>
              </h3>
              <p className="mt-0.5 text-xs text-muted">{formatDate(note.updatedAt)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100">
              <button
                type="button"
                className="rounded p-1 text-muted transition-colors duration-150 hover:text-accent"
                onClick={(e) => {
                  e.stopPropagation()
                  if (onEdit) onEdit()
                  else {
                    setExpanded(true)
                    enterEditMode()
                  }
                }}
                title={t('workspace.noteEdit')}
                aria-label={t('workspace.noteEdit')}
              >
                <PencilSimple className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted transition-colors duration-150 hover:text-accent"
                onClick={(e) => {
                  e.stopPropagation()
                  handleExportMarkdown()
                }}
                title={t('workspace.noteExportMd')}
                aria-label={t('workspace.noteExportMd')}
              >
                <Download className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted transition-colors duration-150 hover:text-error"
                onClick={(e) => {
                  e.stopPropagation()
                  setExpanded(true)
                  setConfirmDelete(true)
                }}
                title={t('workspace.noteDelete')}
                aria-label={t('workspace.noteDelete')}
              >
                <Trash className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div
            data-card-scroll
            className="workspace-card-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain text-xs text-muted [&_p]:my-0.5 [&_ul]:my-0.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0"
            onWheel={(event) => event.stopPropagation()}
          >
            {note.contentMd ? (
              <div>
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                  urlTransform={urlTransform}
                >
                  {boardPreview}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="italic">{t('workspace.noteEmpty')}</p>
            )}
          </div>
        </motion.div>
      </MotionConfig>

      <Modal
        open={expanded}
        onCancel={closeModal}
        title={editing ? t('workspace.noteEdit') : note.title}
        width={720}
        footer={
          <div className="flex items-center justify-between">
            <Button
              danger
              onClick={() => {
                if (confirmDelete) {
                  closeModal()
                  onDelete()
                } else {
                  setConfirmDelete(true)
                }
              }}
            >
              <Trash className="mr-1.5 h-3.5 w-3.5" />
              {confirmDelete ? t('common.confirm') : t('workspace.noteDelete')}
            </Button>
            <div className="flex gap-2">
              <Button onClick={handleExportMarkdown}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t('workspace.noteExportMd')}
              </Button>
              {editing ? (
                <>
                  <Button onClick={handleCancelEdit}>{t('workspace.noteCancelEdit')}</Button>
                  <Button type="primary" disabled={saving || !editTitle.trim()} onClick={() => void handleSave()}>
                    {saving ? t('workspace.saving') : t('workspace.noteSave')}
                  </Button>
                </>
              ) : (
                <Button onClick={enterEditMode}>
                  <PencilSimple className="mr-1.5 h-3.5 w-3.5" />
                  {t('workspace.noteEdit')}
                </Button>
              )}
            </div>
          </div>
        }
      >
        {confirmDelete && (
          <div className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
            {t('workspace.noteDeleteConfirm')}
          </div>
        )}
        {saveError && (
          <div className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
            {saveError}
          </div>
        )}
        {editing ? (
          <div className="grid min-h-[360px] grid-cols-2 gap-3">
            <div className="flex min-w-0 flex-col gap-3">
              <UiInput
                variant="outlined"
                inputSize="md"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                aria-label={t('workspace.noteTitleLabel')}
              />
              <UiTextarea
                variant="outlined"
                textareaSize="md"
                className="min-h-[320px] flex-1 resize-none font-mono"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                aria-label={t('workspace.noteContentLabel')}
              />
            </div>
            <div className="min-w-0 overflow-y-auto rounded-lg border border-border bg-panel-2 p-3 text-sm text-foreground [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
              {editContent ? (
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                  urlTransform={urlTransform}
                >
                  {editContent}
                </ReactMarkdown>
              ) : (
                <p className="italic text-muted">{t('workspace.notePreviewEmpty')}</p>
              )}
            </div>
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">{formatDate(note.updatedAt)}</p>
            <div className="max-h-[65vh] overflow-y-auto text-sm text-foreground [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-panel-2 [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={MARKDOWN_COMPONENTS}
                urlTransform={urlTransform}
              >
                {note.contentMd}
              </ReactMarkdown>
            </div>
          </>
        )}
      </Modal>
    </>
  )
}
