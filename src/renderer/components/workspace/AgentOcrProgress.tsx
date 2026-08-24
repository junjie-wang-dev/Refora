import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  OcrCompletedEvent,
  OcrErrorEvent,
  OcrJob,
  OcrProgressEvent
} from '../../../shared/mineru-types'
import { api } from '../../ipc'
import OcrProgressCard from '../OcrProgressCard'

export default function AgentOcrProgress({
  documentId,
  className,
  style
}: {
  documentId: string
  className?: string
  style?: CSSProperties
}) {
  const { t } = useTranslation()
  const [job, setJob] = useState<OcrJob | null>(null)

  useEffect(() => {
    let disposed = false
    let receivedLiveEvent = false
    setJob(null)

    const onProgress = (payload: OcrProgressEvent) => {
      if (payload.job.documentId !== documentId) return
      receivedLiveEvent = true
      setJob(payload.job)
    }
    const onCompleted = (payload: OcrCompletedEvent) => {
      if (payload.documentId !== documentId) return
      receivedLiveEvent = true
      setJob(null)
    }
    const onError = (payload: OcrErrorEvent) => {
      if (payload.documentId !== documentId) return
      receivedLiveEvent = true
      setJob(null)
    }
    const disposers = [
      api.events.onOcrProgress(onProgress),
      api.events.onOcrCompleted(onCompleted),
      api.events.onOcrError(onError)
    ]
    void api.ocr.getState(documentId).then((state) => {
      if (
        !disposed &&
        !receivedLiveEvent &&
        state.activeJob?.documentId === documentId
      ) {
        setJob(state.activeJob)
      }
    }).catch(() => undefined)
    return () => {
      disposed = true
      disposers.forEach((dispose) => dispose())
    }
  }, [documentId])

  if (!job) return null
  return (
    <section
      className={className}
      style={style}
      aria-label={t('workspace.chat.ocrProgress', 'OCR progress')}
    >
      <OcrProgressCard
        job={job}
        className="mx-auto w-full max-w-[768px] border border-border bg-panel shadow-lg"
      />
    </section>
  )
}
