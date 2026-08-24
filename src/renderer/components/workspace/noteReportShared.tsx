import { useCallback } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { Copy, Download, PencilSimple, Trash } from '@phosphor-icons/react'
import ReactMarkdown from 'react-markdown'
import {
  REMARK_PLUGINS,
  REHYPE_PLUGINS,
  createReforaDocMarkdownComponents,
  urlTransform
} from '../../utils/markdown'
import { useDocumentStore } from '../../store/documentStore'
import { openDocumentPdf } from '../../utils/openPdf'
import i18n from '../../i18n'

export const MARKDOWN_COMPONENTS: ReturnType<typeof createReforaDocMarkdownComponents> =
  createReforaDocMarkdownComponents(
  (docId) => openDocumentPdf(docId),
  () => useDocumentStore.getState().showToast(
    i18n.t('workspace.openDocFailed') as string
  )
)

export function useMarkdownCardExport(title: string, contentMd: string, fallbackName: string) {
  return useCallback(() => {
    const blob = new Blob([`# ${title}\n\n${contentMd}`], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title.replace(/[^\w\u4e00-\u9fff\s-]/g, '').trim() || fallbackName}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [title, contentMd, fallbackName])
}

interface MarkdownCardContextMenuOptions {
  copyLabel: string
  editLabel: string
  exportLabel: string
  deleteLabel: string
  onCopy?: () => void
  onRequestEdit: () => void
  onExport: () => void
  onDelete: () => void
}

export function openMarkdownCardContextMenu({
  copyLabel,
  editLabel,
  exportLabel,
  deleteLabel,
  onCopy,
  onRequestEdit,
  onExport,
  onDelete
}: MarkdownCardContextMenuOptions) {
  const items: ContextMenuItem[] = [
    {
      key: 'copy',
      label: copyLabel,
      icon: <Copy className="h-3.5 w-3.5" />,
      onClick: () => onCopy?.()
    },
    {
      key: 'edit',
      label: editLabel,
      icon: <PencilSimple className="h-3.5 w-3.5" />,
      onClick: onRequestEdit
    },
    {
      key: 'export',
      label: exportLabel,
      icon: <Download className="h-3.5 w-3.5" />,
      onClick: onExport
    },
    {
      key: 'delete',
      label: deleteLabel,
      icon: <Trash className="h-3.5 w-3.5" />,
      onClick: onDelete,
      danger: true
    }
  ]
  showContextMenu(items)
}

export interface MarkdownCardModalLabels {
  delete: string
  confirm: string
  exportMd: string
  edit: string
  cancelEdit: string
  save: string
  saving: string
}

interface MarkdownCardModalProps {
  open: boolean
  title: ReactNode
  width: number
  editing: boolean
  saving: boolean
  canSave: boolean
  confirmDelete: boolean
  deleteConfirmMessage: ReactNode
  saveError: ReactNode
  labels: MarkdownCardModalLabels
  onCancel: () => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onExport: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  children: ReactNode
}

export function MarkdownCardModal({
  open,
  title,
  width,
  editing,
  saving,
  canSave,
  confirmDelete,
  deleteConfirmMessage,
  saveError,
  labels,
  onCancel,
  onRequestDelete,
  onConfirmDelete,
  onExport,
  onStartEdit,
  onCancelEdit,
  onSave,
  children
}: MarkdownCardModalProps) {
  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title={title}
      width={width}
      footer={
        <div className="flex items-center justify-between">
          <Button
            danger
            onClick={() => {
              if (confirmDelete) onConfirmDelete()
              else onRequestDelete()
            }}
          >
            <Trash className="mr-1.5 h-3.5 w-3.5" />
            {confirmDelete ? labels.confirm : labels.delete}
          </Button>
          <div className="flex gap-2">
            <Button onClick={onExport}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {labels.exportMd}
            </Button>
            {editing ? (
              <>
                <Button onClick={onCancelEdit}>{labels.cancelEdit}</Button>
                <Button
                  type="primary"
                  disabled={saving || !canSave}
                  onClick={() => onSave()}
                >
                  {saving ? labels.saving : labels.save}
                </Button>
              </>
            ) : (
              <Button onClick={onStartEdit}>
                <PencilSimple className="mr-1.5 h-3.5 w-3.5" />
                {labels.edit}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {confirmDelete && (
        <div className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
          {deleteConfirmMessage}
        </div>
      )}
      {saveError && (
        <div className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
          {saveError}
        </div>
      )}
      {children}
    </Modal>
  )
}

export { REMARK_PLUGINS, REHYPE_PLUGINS, urlTransform, ReactMarkdown }
