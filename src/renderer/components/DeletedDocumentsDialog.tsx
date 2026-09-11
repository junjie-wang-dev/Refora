import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from './ui/LobeControls'
import { Button } from './ui'
import { api } from '../ipc'
import { errorMessage, type DeletedDocumentBatch } from '../../shared/ipc-types'
import { useDocumentStore } from '../store/documentStore'

export default function DeletedDocumentsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<DeletedDocumentBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setEntries(await api.documents.listDeleted())
    } catch (cause) {
      setError(errorMessage(cause, t('recycle.loadFailed')))
    } finally {
      setLoading(false)
    }
  }, [t])
  useEffect(() => { void load() }, [load])
  useEffect(() => api.events.onLibrarySwitched(onClose), [onClose])
  const restore = async (entry: DeletedDocumentBatch) => {
    setRestoring(entry.id)
    setError(null)
    try {
      const result = await api.documents.restoreDeleted(entry.id)
      setEntries((current) => current.filter((item) => item.id !== entry.id))
      setNotice(t(result.skippedRelations ? 'recycle.restoredPartial' : 'recycle.restored', {
        count: result.documentIds.length
      }))
      const store = useDocumentStore.getState()
      await Promise.all([store.fetchDocuments(), store.fetchDocumentCounts(), store.fetchCategories()])
    } catch (cause) {
      setError(errorMessage(cause, t('recycle.restoreFailed')))
    } finally {
      setRestoring(null)
    }
  }
  return (
    <Modal open title={t('recycle.title')} onCancel={onClose} footer={null}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('recycle.description')}</p>
        {error && <div role="alert" className="text-sm text-error">{error}
          <Button variant="link" onClick={() => void load()}>{t('globalSearch.retry')}</Button>
        </div>}
        {notice && <p role="status" className="text-sm text-success">{notice}</p>}
        {loading ? <p role="status">{t('common.loading')}</p> : entries.length === 0 ? (
          <p className="py-8 text-center text-muted">{t('recycle.empty')}</p>
        ) : (
          <ul className="max-h-[55vh] overflow-auto">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 border-b border-border py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={entry.titles.join('\n')}>{entry.titles.join(' · ')}</p>
                  <p className="text-xs text-muted">{t('recycle.entry', { count: entry.count })} · {new Date(entry.deletedAt).toLocaleString()}</p>
                </div>
                <Button variant="secondary" disabled={restoring !== null} onClick={() => void restore(entry)}>
                  {t(restoring === entry.id ? 'recycle.restoring' : 'recycle.restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
