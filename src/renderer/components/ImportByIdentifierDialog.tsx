import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@lobehub/ui'
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
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestVersionRef = useRef(0)
  const importByIdentifier = useDocumentStore((s) => s.importByIdentifier)

  const handleClose = useCallback(() => {
    requestVersionRef.current += 1
    setIdentifier('')
    setLoading(false)
    setSlow(false)
    setError(null)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!loading) return
    const timer = window.setTimeout(() => setSlow(true), 5_000)
    return () => window.clearTimeout(timer)
  }, [loading])

  const handleImport = useCallback(async () => {
    const trimmed = identifier.trim()
    if (!trimmed || loading) return
    const requestVersion = requestVersionRef.current + 1
    requestVersionRef.current = requestVersion
    setLoading(true)
    setSlow(false)
    setError(null)
    const message = await importByIdentifier(trimmed)
    if (requestVersionRef.current !== requestVersion) return
    setLoading(false)
    setSlow(false)
    if (message) {
      setError(message)
      return
    }
    setIdentifier('')
    onClose()
  }, [identifier, importByIdentifier, loading, onClose])

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      title={t('identifierImport.title')}
      destroyOnClose
      footer={
        <div className="flex justify-end gap-2">
          <UiButton variant="ghost" size="md" onClick={handleClose}>
            {loading ? t('common.close') : t('common.cancel')}
          </UiButton>
          <UiButton
            variant="primary"
            size="md"
            disabled={loading || !identifier.trim()}
            onClick={handleImport}
          >
            {loading
              ? t('identifierImport.importing')
              : error
                ? t('identifierImport.retry')
                : t('identifierImport.import')}
          </UiButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          autoFocus
          focusRing={false}
          value={identifier}
          onChange={(e) => {
            setIdentifier(e.target.value)
            setError(null)
          }}
          placeholder={t('identifierImport.placeholder')}
          onPressEnter={handleImport}
          disabled={loading}
        />
        <p className="text-xs text-muted leading-relaxed">
          {t('identifierImport.hint')}
        </p>
        {loading && (
          <p role="status" className="text-xs text-muted leading-relaxed">
            {slow ? t('identifierImport.slowNetwork') : t('identifierImport.backgroundHint')}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-error leading-relaxed">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
