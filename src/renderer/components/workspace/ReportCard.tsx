import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Download, PencilSimple, Trash } from '@phosphor-icons/react'
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
import type { AiReport, Document } from '../../../shared/ipc-types'

interface ReportCardProps {
  report: AiReport
  onDelete: () => void
  onUpdate: (id: string, patch: { title?: string; contentMd?: string }) => Promise<boolean>
  onOpen?: () => void
  onEdit?: () => void
  onCopy?: () => void
  sourceDocuments?: Map<string, Document>
  onOpenSource?: (docId: string) => void
}

export default function ReportCard({
  report,
  onDelete,
  onUpdate,
  onOpen,
  onEdit,
  onCopy,
  sourceDocuments = new Map(),
  onOpenSource
}: ReportCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const editor = useMarkdownCardEditor({
    id: report.id,
    title: report.title,
    contentMd: report.contentMd,
    titleRequiredMessage: t('workspace.titleRequired'),
    saveFailedMessage: t('workspace.reportSaveFailed'),
    onUpdate
  })
  const boardPreview = useMemo(() => boardCardPreview(report.contentMd), [report.contentMd])
  const handleExportMarkdown = useMarkdownCardExport(report.title, report.contentMd, 'report')

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

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openMarkdownCardContextMenu({
      copyLabel: t('workspace.cardCopy'),
      editLabel: t('workspace.reportEdit'),
      exportLabel: t('workspace.reportExportMd'),
      deleteLabel: t('workspace.reportDelete'),
      onCopy: () => onCopy?.(),
      onRequestEdit: () => {
        if (onEdit) onEdit()
        else requestInternalEdit()
      },
      onExport: handleExportMarkdown,
      onDelete: requestDelete
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
        data-card-kind="report"
        className={cardClassName('default', false, 'workspace-content-card workspace-content-card--report group/card flex h-full w-full cursor-pointer flex-col gap-2 overflow-hidden p-3')}
        onClick={openCard}
        onContextMenu={handleContextMenu}
      >
        <div className="flex shrink-0 items-start gap-2">
          <div className="workspace-card-heading min-w-0 flex-1">
            <span className="workspace-card-type-label">{t('workspace.cardTypeReport')}</span>
            <h3 className="workspace-card-title line-clamp-2 text-base font-semibold text-foreground">
              <button
                type="button"
                className="rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={(event) => {
                  event.stopPropagation()
                  openCard()
                }}
              >
                {report.title}
              </button>
            </h3>
            <p className="mt-0.5 text-xs text-muted">{formatDate(report.createdAt)}</p>
            {report.sourceDocIds.length > 0 && (
              <p className="mt-0.5 text-xs text-muted">
                {t('workspace.reportSourceCount', { count: report.sourceDocIds.length })}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100">
            <button
              type="button"
              className="rounded p-1 text-muted transition-colors duration-150 hover:text-accent"
              onClick={(e) => {
                e.stopPropagation()
                if (onEdit) onEdit()
                else requestInternalEdit()
              }}
              title={t('workspace.reportEdit')}
              aria-label={t('workspace.reportEdit')}
            >
              <PencilSimple className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-1 text-muted transition-colors duration-150 hover:text-accent"
              onClick={(e) => { e.stopPropagation(); handleExportMarkdown() }}
              title={t('workspace.reportExportMd')}
              aria-label={t('workspace.reportExportMd')}
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-1 text-muted transition-colors duration-150 hover:text-error"
              onClick={(e) => { e.stopPropagation(); requestDelete() }}
              title={t('workspace.reportDelete')}
              aria-label={t('workspace.reportDelete')}
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
        </div>
      </motion.div>
      </MotionConfig>

      <MarkdownCardModal
        open={expanded}
        onCancel={closeModal}
        title={editor.editing ? t('workspace.reportEdit') : report.title}
        width={640}
        editing={editor.editing}
        saving={editor.saving}
        canSave={editor.draftTitle.trim().length > 0}
        confirmDelete={confirmDelete}
        deleteConfirmMessage={t('workspace.reportDeleteConfirm')}
        saveError={editor.saveError}
        labels={{
          delete: t('workspace.reportDelete'),
          confirm: t('common.confirm'),
          exportMd: t('workspace.reportExportMd'),
          edit: t('workspace.reportEdit'),
          cancelEdit: t('workspace.reportCancelEdit'),
          save: t('workspace.reportSave'),
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
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">{t('workspace.reportTitleLabel')}</label>
              <UiInput
                variant="outlined"
                inputSize="md"
                value={editor.draftTitle}
                onChange={(e) => editor.setDraftTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">{t('workspace.reportContentLabel')}</label>
              <UiTextarea
                variant="outlined"
                textareaSize="md"
                className="min-h-[300px] resize-y font-mono"
                value={editor.draftContent}
                onChange={(e) => editor.setDraftContent(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">{formatDate(report.createdAt)}</p>
            {report.sourceDocIds.length > 0 && (
              <section className="mb-4">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  {t('workspace.reportSources')}
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {report.sourceDocIds.map((docId) => {
                    const doc = sourceDocuments.get(docId)
                    const label = doc?.title || doc?.fileName || docId
                    return (
                      <button
                        key={docId}
                        type="button"
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-panel-2 px-2 py-1 text-xs text-foreground transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={!doc || !onOpenSource}
                        onClick={() => onOpenSource?.(docId)}
                        title={doc ? label : t('workspace.reportSourceMissing')}
                      >
                        <BookOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
                        <span className="truncate">{label}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )}
            <div className="max-h-[60vh] overflow-y-auto text-sm text-foreground [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-panel-2 [&_pre]:p-2 [&_code]:rounded [&_code]:bg-panel-2 [&_code]:px-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:text-accent [&_a]:underline [&_h1]:mb-2 [&_h1]:font-bold [&_h1]:text-base [&_h2]:mb-2 [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:font-medium [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={MARKDOWN_COMPONENTS}
                urlTransform={urlTransform}
              >
                {report.contentMd}
              </ReactMarkdown>
            </div>
          </>
        )}
      </MarkdownCardModal>
    </>
  )
}
