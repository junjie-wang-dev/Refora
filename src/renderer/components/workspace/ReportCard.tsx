import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, Button } from '@lobehub/ui'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { BookOpen, Copy, Trash, PencilSimple, Download } from '@phosphor-icons/react'
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
import type { AiReport, Document } from '../../../shared/ipc-types'
import { openDocumentPdf } from '../../utils/openPdf'

const MARKDOWN_COMPONENTS = createReforaDocMarkdownComponents(
  (docId) => openDocumentPdf(docId),
  () => useDocumentStore.getState().showToast(
    'Failed to open document. It may have been moved or deleted.'
  )
)

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
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(report.title)
  const [editContent, setEditContent] = useState(report.contentMd)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const boardPreview = useMemo(() => boardCardPreview(report.contentMd), [report.contentMd])

  const handleExportMarkdown = () => {
    const header = `# ${report.title}\n\n`
    const blob = new Blob([header + report.contentMd], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${report.title.replace(/[^\w\u4e00-\u9fff\s-]/g, '').trim() || 'report'}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const enterEditMode = () => {
    setEditTitle(report.title)
    setEditContent(report.contentMd)
    setEditing(true)
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const menuItems: ContextMenuItem[] = [
      {
        key: 'copy',
        label: t('workspace.cardCopy'),
        icon: <Copy className="h-3.5 w-3.5" />,
        onClick: () => onCopy?.()
      },
      {
        key: 'edit',
        label: t('workspace.reportEdit'),
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
        label: t('workspace.reportExportMd'),
        icon: <Download className="h-3.5 w-3.5" />,
        onClick: handleExportMarkdown
      },
      {
        key: 'delete',
        label: t('workspace.reportDelete'),
        icon: <Trash className="h-3.5 w-3.5" />,
        onClick: () => {
          setExpanded(true)
          setConfirmDelete(true)
        },
        danger: true
      }
    ]
    showContextMenu(menuItems)
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
    const saved = await onUpdate(report.id, { title: editTitle.trim(), contentMd: editContent })
    setSaving(false)
    if (saved) setEditing(false)
    else setSaveError(t('workspace.reportSaveFailed'))
  }

  const handleCancelEdit = () => {
    setEditTitle(report.title)
    setEditContent(report.contentMd)
    setEditing(false)
    setSaveError(null)
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
        onClick={() => {
          if (onOpen) onOpen()
          else setExpanded(true)
        }}
        onContextMenu={handleContextMenu}
      >
        <div className="flex shrink-0 items-start gap-2">
          <div className="workspace-card-heading min-w-0 flex-1">
            <span className="workspace-card-type-label">{t('workspace.cardTypeReport')}</span>
            <h3 className="workspace-card-title line-clamp-2 text-base font-semibold text-foreground">{report.title}</h3>
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
                else {
                  setExpanded(true)
                  enterEditMode()
                }
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
              onClick={(e) => { e.stopPropagation(); setExpanded(true); setConfirmDelete(true) }}
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

      <Modal
        open={expanded}
        onCancel={closeModal}
        title={editing ? t('workspace.reportEdit') : report.title}
        width={640}
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
              {confirmDelete ? t('common.confirm') : t('workspace.reportDelete')}
            </Button>
            <div className="flex gap-2">
              <Button onClick={handleExportMarkdown}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t('workspace.reportExportMd')}
              </Button>
              {editing ? (
                <>
                  <Button onClick={handleCancelEdit}>
                    {t('workspace.reportCancelEdit')}
                  </Button>
                  <Button type="primary" disabled={saving || !editTitle.trim()} onClick={() => void handleSave()}>
                    {saving ? t('workspace.saving') : t('workspace.reportSave')}
                  </Button>
                </>
              ) : (
                <Button onClick={enterEditMode}>
                  <PencilSimple className="mr-1.5 h-3.5 w-3.5" />
                  {t('workspace.reportEdit')}
                </Button>
              )}
            </div>
          </div>
        }
      >
        {confirmDelete && (
          <div className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
            {t('workspace.reportDeleteConfirm')}
          </div>
        )}
        {saveError && (
          <div className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
            {saveError}
          </div>
        )}
        {editing ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">{t('workspace.reportTitleLabel')}</label>
              <UiInput
                variant="outlined"
                inputSize="md"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">{t('workspace.reportContentLabel')}</label>
              <UiTextarea
                variant="outlined"
                textareaSize="md"
                className="min-h-[300px] resize-y font-mono"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
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
      </Modal>
    </>
  )
}
