import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText } from '@phosphor-icons/react'
import { Select } from '@lobehub/ui'
import { useTranslation } from 'react-i18next'
import { api } from '../ipc'
import { useOcrReaderStore } from '../store/ocrReaderStore'
import { errorMessage } from '../../shared/ipc-types'
import type { Document } from '../../shared/ipc-types'
import type {
  MineruInstallProgress,
  OcrCompletedEvent,
  OcrDocumentState,
  OcrErrorEvent,
  OcrProfile,
  OcrProgressEvent,
  OcrResult
} from '../../shared/mineru-types'
import { Button } from './ui'
import OcrProgressCard from './OcrProgressCard'

export default function OcrSection({ doc }: { doc: Document }) {
  const { t } = useTranslation()
  const openReader = useOcrReaderStore((state) => state.open)
  const [state, setState] = useState<OcrDocumentState | null>(null)
  const [profile, setProfile] = useState<OcrProfile>('balanced')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshGeneration = useRef(0)
  const stateRef = useRef<OcrDocumentState | null>(null)
  const eventRefreshPendingRef = useRef(false)
  const pendingEventRef = useRef<
    | { kind: 'progress'; job: OcrProgressEvent['job'] }
    | { kind: 'completed'; result: OcrResult }
    | null
  >(null)
  const readerFailedMessage = t('ocr.readerFailed')

  const refresh = useCallback(async () => {
    const generation = refreshGeneration.current + 1
    refreshGeneration.current = generation
    try {
      const next = await api.ocr.getState(doc.id)
      if (refreshGeneration.current !== generation) return
      const pending = pendingEventRef.current
      const merged = pending?.kind === 'progress'
        ? { ...next, activeJob: pending.job }
        : pending?.kind === 'completed'
          ? { ...next, activeJob: null, result: pending.result }
          : next
      pendingEventRef.current = null
      stateRef.current = merged
      setState(merged)
      setError(null)
    } catch (value) {
      if (refreshGeneration.current !== generation) return
      setError(errorMessage(value, readerFailedMessage))
    } finally {
      if (refreshGeneration.current === generation) setLoading(false)
    }
  }, [doc.id, readerFailedMessage])

  useEffect(() => {
    stateRef.current = null
    pendingEventRef.current = null
    eventRefreshPendingRef.current = false
    setState(null)
    setError(null)
    setLoading(true)
    void refresh()
    const refreshAfterEvent = () => {
      if (eventRefreshPendingRef.current) return
      eventRefreshPendingRef.current = true
      refreshGeneration.current += 1
      void refresh().finally(() => {
        eventRefreshPendingRef.current = false
      })
    }
    const onProgress = (payload: OcrProgressEvent) => {
      if (payload.job.documentId !== doc.id) return
      const current = stateRef.current
      if (current) {
        refreshGeneration.current += 1
        const next = { ...current, activeJob: payload.job }
        stateRef.current = next
        setState(next)
        setLoading(false)
      } else {
        pendingEventRef.current = { kind: 'progress', job: payload.job }
        refreshAfterEvent()
      }
      setError(null)
    }
    const onCompleted = (payload: OcrCompletedEvent) => {
      if (payload.documentId !== doc.id) return
      const current = stateRef.current
      if (current) {
        refreshGeneration.current += 1
        const next = { ...current, activeJob: null, result: payload.result }
        stateRef.current = next
        setState(next)
        setLoading(false)
      } else {
        pendingEventRef.current = { kind: 'completed', result: payload.result }
        refreshAfterEvent()
      }
      setError(null)
    }
    const onError = (payload: OcrErrorEvent) => {
      if (payload.documentId !== doc.id) return
      refreshGeneration.current += 1
      pendingEventRef.current = null
      const current = stateRef.current
      if (current) {
        const next = { ...current, activeJob: null }
        stateRef.current = next
        setState(next)
      }
      setLoading(false)
      setError(t('ocr.failed', { message: payload.message }))
    }
    const onInstallProgress = (payload: MineruInstallProgress) => {
      if (payload.stage === 'completed') void refresh()
    }
    const disposers = [
      api.events.onOcrProgress(onProgress),
      api.events.onOcrCompleted(onCompleted),
      api.events.onOcrError(onError),
      api.events.onMineruInstallProgress(onInstallProgress)
    ]
    return () => {
      refreshGeneration.current += 1
      stateRef.current = null
      pendingEventRef.current = null
      eventRefreshPendingRef.current = false
      disposers.forEach((dispose) => dispose())
    }
  }, [doc.id, refresh])

  const start = async () => {
    setError(null)
    try {
      const job = await api.ocr.start(doc.id, profile)
      const current = stateRef.current
      if (current) {
        const next = { ...current, activeJob: job }
        stateRef.current = next
        setState(next)
      }
    } catch (value) {
      setError(errorMessage(value, readerFailedMessage))
    }
  }

  const cancel = async () => {
    if (!state?.activeJob) return
    try {
      await api.ocr.cancel(state.activeJob.id)
      await refresh()
    } catch (value) {
      setError(errorMessage(value, readerFailedMessage))
    }
  }

  if (loading) return null
  const installed = state?.engine.state === 'installed'
  const job = state?.activeJob
  const result = state?.result

  return (
    <div className="mt-5 flex flex-col gap-3 border-t border-border pt-5">
      <div>
        <div className="text-label font-semibold uppercase tracking-wide text-muted">
          {t('ocr.title')}
        </div>
        <p className="mb-0 mt-1 text-xs leading-5 text-muted">{t('ocr.description')}</p>
      </div>

      {job ? (
        <OcrProgressCard job={job} onCancel={() => void cancel()} />
      ) : (
        <>
          {result && (
            <div className="flex flex-col gap-2">
              {result.stale && (
                <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                  {t('ocr.stale')}
                </div>
              )}
              <Button
                variant="primary"
                size="sm"
                className="self-start"
                icon={<FileText className="h-3.5 w-3.5" />}
                onClick={() => openReader(doc.id, result.resultKey, doc.title || doc.fileName)}
              >
                {t('ocr.open')}
              </Button>
            </div>
          )}
          {installed ? (
            <div className="flex items-center gap-2">
              <Select
                value={profile}
                onChange={(value) => setProfile(value as OcrProfile)}
                options={(['compatible', 'balanced', 'quality'] as OcrProfile[]).map((value) => ({
                  value,
                  label: t(`ocr.profiles.${value}`)
                }))}
                size="small"
                style={{ minWidth: 150 }}
                aria-label={t('ocr.profile')}
              />
              <Button variant="ghost" size="sm" onClick={() => void start()}>
                {result ? t('ocr.rebuild') : t('ocr.convert')}
              </Button>
            </div>
          ) : (
            <div className="rounded-lg bg-panel-2 px-3 py-2 text-xs text-muted">
              {t('ocr.engineRequired')}
            </div>
          )}
        </>
      )}

      {error && <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{error}</div>}
    </div>
  )
}
