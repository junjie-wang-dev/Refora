import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { Clipboard, Copy, Scissors } from '@phosphor-icons/react'
import { Button as UiButton, Input } from './ui'
import { useDocumentStore } from '../store/documentStore'

interface ImportByIdentifierDialogProps {
  open: boolean
  onClose: () => void
}

export default function ImportByIdentifierDialog({ open, onClose }: ImportByIdentifierDialogProps) {
  const { t } = useTranslation()
  const [identifier, setIdentifier] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const importByIdentifier = useDocumentStore((s) => s.importByIdentifier)

  const handleClose = useCallback(() => {
    if (loading) return
    setIdentifier('')
    setError(null)
    onClose()
  }, [loading, onClose])

  const handleImport = useCallback(async () => {
    const trimmed = identifier.trim()
    if (!trimmed || loading) return
    setLoading(true)
    setError(null)
    const message = await importByIdentifier(trimmed)
    setLoading(false)
    if (message) {
      setError(message)
      return
    }
    setIdentifier('')
    onClose()
  }, [identifier, importByIdentifier, loading, onClose])

  const restoreSelection = useCallback((position: number) => {
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.selectionStart = input.selectionEnd = position
    })
  }, [])

  const handleContextMenu = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.preventDefault()
    const input = inputRef.current
    const start = input?.selectionStart ?? 0
    const end = input?.selectionEnd ?? 0
    const hasSelection = start !== end
    const items: ContextMenuItem[] = [
      {
        key: 'cut',
        label: t('identifierImport.cut'),
        icon: <Scissors className="h-3.5 w-3.5" />,
        disabled: loading || !hasSelection,
        onClick: async () => {
          const selected = identifier.slice(start, end)
          try {
            await navigator.clipboard.writeText(selected)
          } catch {
            return
          }
          setIdentifier(identifier.slice(0, start) + identifier.slice(end))
          setError(null)
          restoreSelection(start)
        }
      },
      {
        key: 'copy',
        label: t('identifierImport.copy'),
        icon: <Copy className="h-3.5 w-3.5" />,
        disabled: loading || !hasSelection,
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(identifier.slice(start, end))
          } catch {
            return
          }
        }
      },
      {
        key: 'paste',
        label: t('identifierImport.paste'),
        icon: <Clipboard className="h-3.5 w-3.5" />,
        disabled: loading,
        onClick: async () => {
          let text: string
          try {
            text = await navigator.clipboard.readText()
          } catch {
            return
          }
          if (!text) return
          setIdentifier(identifier.slice(0, start) + text + identifier.slice(end))
          setError(null)
          restoreSelection(start + text.length)
        }
      }
    ]
    showContextMenu(items)
  }, [identifier, loading, restoreSelection, t])

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      title={t('identifierImport.title')}
      destroyOnClose
      footer={
        <div className="flex justify-end gap-2">
          <UiButton variant="ghost" size="md" onClick={handleClose} disabled={loading}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            variant="primary"
            size="md"
            disabled={loading || !identifier.trim()}
            onClick={handleImport}
          >
            {loading ? t('identifierImport.importing') : t('identifierImport.import')}
          </UiButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          ref={inputRef}
          autoFocus
          focusRing={false}
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value)
            setError(null)
          }}
          placeholder={t('identifierImport.placeholder')}
          onPressEnter={handleImport}
          onContextMenu={handleContextMenu}
          disabled={loading}
        />
        <p className="text-xs text-muted leading-relaxed">
          {t('identifierImport.hint')}
        </p>
        {error && (
          <p role="alert" className="text-xs text-error leading-relaxed">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
