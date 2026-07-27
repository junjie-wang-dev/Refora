import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OcrJob } from '../../shared/mineru-types'
import { formatElapsedClock } from '../utils/format'
import { Button } from './ui'

export default function OcrProgressCard({
  job,
  onCancel,
  className = ''
}: {
  job: OcrJob
  onCancel?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setNow(Date.now())
    if (job.status !== 'queued' && job.status !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [job.id, job.status])

  const elapsed = formatElapsedClock(now - (job.startedAt ?? job.createdAt))
  const percentage = job.progress == null ? null : Math.round(job.progress * 100)

  return (
    <div className={`flex flex-col gap-3 rounded-lg bg-panel-2 px-3 py-3 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">
            {t(`ocr.stage.${job.stage}`)}
          </div>
          <div className="mt-0.5 text-[11px] leading-4 text-muted">
            {t(`ocr.stageDescription.${job.stage}`)}
          </div>
        </div>
        <div className="shrink-0 text-right text-[11px] leading-4 text-muted tabular-nums">
          {percentage != null ? `${percentage}% · ` : ''}
          {t('ocr.elapsed', { time: elapsed })}
        </div>
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-background"
        role="progressbar"
        aria-label={t('ocr.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage ?? undefined}
      >
        <div
          className={`h-full rounded-full bg-accent ${
            job.progress == null
              ? 'mineru-progress-indeterminate'
              : 'transition-[width] duration-300'
          }`}
          style={job.progress == null
            ? undefined
            : { width: `${Math.max(2, Math.min(100, job.progress * 100))}%` }}
        />
      </div>

      {onCancel ? (
        <div className="border-t border-border/70 pt-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('ocr.cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
