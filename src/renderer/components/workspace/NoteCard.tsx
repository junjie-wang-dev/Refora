import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, PencilSimple, Trash } from '@phosphor-icons/react'
import { motion, MotionConfig } from 'motion/react'
import {
  MARKDOWN_COMPONENTS,
  MarkdownCardModal,
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  ReactMarkdown,
  openMarkdownCardContextMenu,
  urlTransform,
  useMarkdownCardExport,
  useMarkdownCardEditor
} from './noteReportShared'
import { formatDate } from '../../utils/format'
import { boardCardPreview } from '../../utils/workspaceCardMarkdown'
import { Input as UiInput, Textarea as UiTextarea, cardClassName } from '../ui'
import type { WorkspaceNote } from '../../../shared/ipc-types'

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
  const editor = useMarkdownCardEditor({
    id: note.id,
    title: note.title,
    contentMd: note.contentMd,
    titleRequiredMessage: t('workspace.titleRequired'),
    saveFailedMessage: t('workspace.noteSaveFailed'),
    onUpdate
  })
  const boardPreview = useMemo(() => boardCardPreview(note.contentMd), [note.contentMd])
  const handleExportMarkdown = useMarkdownCardExport(note.title, note.contentMd, 'note')

  const enterEditMode = () => {
    editor.start()
  }

  const requestInternalEdit = () => {
    setExpanded(true)
    enterEditMode()
  }

  const requestDelete = () => {
    setExpanded(true)
    setConfirmDelete(true)
  }

  useEffect(() => {
    if (!autoEdit) return
    setExpanded(true)
    enterEditMode()
    onAutoEditHandled?.()
  }, [autoEdit, onAutoEditHandled])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openMarkdownCardContextMenu({
      copyLabel: t('workspace.cardCopy'),
      editLabel: t('workspace.noteEdit'),
      exportLabel: t('workspace.noteExportMd'),
      deleteLabel: t('workspace.noteDelete'),
      onCopy: () => onCopy?.(),
      onRequestEdit: () => {
        if (onEdit) onEdit()
        else requestInternalEdit()
      },
      onExport: handleExportMarkdown,
      onDelete: () => {
        setExpanded(true)
        setConfirmDelete(true)
      }
    })
  }

  const closeModal = () => {
    setExpanded(false)
    setConfirmDelete(false)
    editor.cancel()
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
                  else requestInternalEdit()
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
                  requestDelete()
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

      <MarkdownCardModal
        open={expanded}
        onCancel={closeModal}
        title={editor.editing ? t('workspace.noteEdit') : note.title}
        width={720}
        editing={editor.editing}
        saving={editor.saving}
        canSave={editor.draftTitle.trim().length > 0}
        confirmDelete={confirmDelete}
        deleteConfirmMessage={t('workspace.noteDeleteConfirm')}
        saveError={editor.saveError}
        labels={{
          delete: t('workspace.noteDelete'),
          confirm: t('common.confirm'),
          exportMd: t('workspace.noteExportMd'),
          edit: t('workspace.noteEdit'),
          cancelEdit: t('workspace.noteCancelEdit'),
          save: t('workspace.noteSave'),
          saving: t('workspace.saving')
        }}
        onRequestDelete={() => setConfirmDelete(true)}
        onConfirmDelete={() => {
          closeModal()
          onDelete()
        }}
        onExport={handleExportMarkdown}
        onStartEdit={enterEditMode}
        onCancelEdit={editor.cancel}
        onSave={() => void editor.save()}
      >
        {editor.editing ? (
          <div className="grid min-h-[360px] grid-cols-2 gap-3">
            <div className="flex min-w-0 flex-col gap-3">
              <UiInput
                variant="outlined"
                inputSize="md"
                value={editor.draftTitle}
                onChange={(e) => editor.setDraftTitle(e.target.value)}
                aria-label={t('workspace.noteTitleLabel')}
              />
              <UiTextarea
                variant="outlined"
                textareaSize="md"
                className="min-h-[320px] flex-1 resize-none font-mono"
                value={editor.draftContent}
                onChange={(e) => editor.setDraftContent(e.target.value)}
                aria-label={t('workspace.noteContentLabel')}
              />
            </div>
            <div className="min-w-0 overflow-y-auto rounded-lg border border-border bg-panel-2 p-3 text-sm text-foreground [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
              {editor.draftContent ? (
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                  urlTransform={urlTransform}
                >
                  {editor.draftContent}
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
      </MarkdownCardModal>
    </>
  )
}
