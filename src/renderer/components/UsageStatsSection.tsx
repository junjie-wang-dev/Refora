import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiUsageActivity, AiUsageModel, AiUsageStats } from '../../shared/ipc-types'
import { errorMessage } from '../../shared/ipc-types'
import { api } from '../ipc'

const MODEL_COLORS = ['#1677ff', '#22a559', '#8b5cf6', '#ef4444', '#f59e0b', '#06b6d4']

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function heatmapDates(today: Date): Date[] {
  const start = new Date(today)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - start.getDay() - 51 * 7)
  return Array.from({ length: 52 * 7 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function compactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value)
}

function exactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value)
}

function modelRows(models: AiUsageModel[]): AiUsageModel[] {
  if (models.length <= MODEL_COLORS.length) return models
  const visible = models.slice(0, MODEL_COLORS.length - 1)
  const remaining = models.slice(MODEL_COLORS.length - 1)
  return [
    ...visible,
    {
      model: 'other',
      tokens: remaining.reduce((sum, model) => sum + model.tokens, 0),
      calls: remaining.reduce((sum, model) => sum + model.calls, 0)
    }
  ]
}

function SummaryCard({
  label,
  value,
  hint
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-panel px-4 py-3">
      <div className="text-label text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-label text-muted">{hint}</div>}
    </div>
  )
}

function ActivityHeatmap({
  activity,
  locale
}: {
  activity: AiUsageActivity[]
  locale: string
}) {
  const { t } = useTranslation()
  const today = useMemo(() => new Date(), [])
  const dates = useMemo(() => heatmapDates(today), [today])
  const activityByDate = useMemo(
    () => new Map(activity.map((entry) => [entry.date, entry])),
    [activity]
  )
  const scrollerRef = useRef<HTMLDivElement>(null)
  const maxTokens = Math.max(0, ...activity.map((entry) => entry.tokens))

  useEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollLeft = scroller.scrollWidth
  }, [activity])

  return (
    <section className="rounded-xl border border-border bg-panel p-4">
      <div className="flex items-center justify-between gap-4">
        <h4 className="text-sm font-semibold text-foreground">
          {t('settings.usage.activityTitle')}
        </h4>
        <div className="flex items-center gap-1.5 text-label text-muted">
          <span>{t('settings.usage.less')}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className="h-3 w-3 rounded-[3px] border border-border"
              style={{
                background: level === 0
                  ? 'var(--color-panel-2)'
                  : `color-mix(in srgb, var(--color-accent) ${level * 20 + 15}%, var(--color-panel-2))`
              }}
            />
          ))}
          <span>{t('settings.usage.more')}</span>
        </div>
      </div>
      <div ref={scrollerRef} className="usage-heatmap-scroll mt-4 overflow-x-auto">
        <div
          className="grid w-max grid-flow-col grid-rows-7 gap-[3px]"
          style={{
            gridTemplateColumns: 'repeat(52, 11px)',
            gridAutoRows: '11px'
          }}
          role="img"
          aria-label={t('settings.usage.activityLabel')}
        >
          {dates.map((date) => {
            const key = localDateKey(date)
            const entry = activityByDate.get(key)
            const future = date.getTime() > today.getTime()
            const ratio = !entry?.tokens || maxTokens === 0
              ? 0
              : Math.log1p(entry.tokens) / Math.log1p(maxTokens)
            const level = future ? 0 : Math.max(entry ? 1 : 0, Math.ceil(ratio * 4))
            const dateLabel = new Intl.DateTimeFormat(locale, {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            }).format(date)
            const title = entry
              ? t('settings.usage.activityTooltip', {
                  date: dateLabel,
                  tokens: exactNumber(entry.tokens, locale),
                  turns: exactNumber(entry.turns, locale)
                })
              : t('settings.usage.noActivityTooltip', { date: dateLabel })
            return (
              <span
                key={key}
                className="h-[11px] w-[11px] rounded-[3px]"
                title={title}
                style={{
                  background: level === 0
                    ? 'var(--color-panel-2)'
                    : `color-mix(in srgb, var(--color-accent) ${level * 20 + 15}%, var(--color-panel-2))`
                }}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}

function ModelUsage({
  models,
  totalTokens,
  locale
}: {
  models: AiUsageModel[]
  totalTokens: number
  locale: string
}) {
  const { t } = useTranslation()
  const rows = modelRows(models)
  let offset = 0
  const segments = rows.map((model, index) => {
    const start = totalTokens > 0 ? offset / totalTokens * 100 : 0
    offset += model.tokens
    const end = totalTokens > 0 ? offset / totalTokens * 100 : 0
    return `${MODEL_COLORS[index]} ${start}% ${end}%`
  })

  return (
    <section className="rounded-xl border border-border bg-panel p-4">
      <h4 className="text-sm font-semibold text-foreground">
        {t('settings.usage.modelTitle')}
      </h4>
      {rows.length === 0 ? (
        <div className="mt-4 rounded-lg bg-panel-2 px-4 py-8 text-center text-xs text-muted">
          {t('settings.usage.empty')}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-[minmax(150px,0.8fr)_minmax(0,1.5fr)] items-center gap-6 rounded-lg bg-panel-2 p-4">
          <div className="relative mx-auto aspect-square w-full max-w-48">
            <div
              className="absolute inset-0 rounded-full"
              style={{ background: `conic-gradient(${segments.join(', ')})` }}
            />
            <div className="absolute inset-[24%] flex flex-col items-center justify-center rounded-full bg-panel text-center">
              <strong className="text-xl tabular-nums text-foreground">
                {compactNumber(totalTokens, locale)}
              </strong>
              <span className="text-xs text-muted">{t('settings.usage.tokens')}</span>
            </div>
          </div>
          <div className="min-w-0">
            {rows.map((model, index) => {
              const percentage = totalTokens > 0 ? model.tokens / totalTokens * 100 : 0
              return (
                <div
                  key={model.model}
                  className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: MODEL_COLORS[index] }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground">
                      {model.model === 'other' ? t('settings.usage.otherModels') : model.model}
                    </div>
                    <div className="text-label text-muted">
                      {t('settings.usage.modelDetails', {
                        tokens: compactNumber(model.tokens, locale),
                        calls: exactNumber(model.calls, locale)
                      })}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted">
                    {percentage < 0.1 && percentage > 0
                      ? '<0.1%'
                      : `${percentage.toFixed(percentage >= 10 ? 0 : 1)}%`}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}

export function UsageStatsSection({ onError }: { onError: (message: string | null) => void }) {
  const { t, i18n } = useTranslation()
  const [stats, setStats] = useState<AiUsageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const locale = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api.ai.usageStats().then((result) => {
      if (!cancelled) {
        setStats(result)
        onError(null)
      }
    }).catch((error) => {
      if (!cancelled) {
        onError(errorMessage(error, t('settings.usage.loadFailed')))
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [onError, t])

  if (loading) {
    return (
      <div className="flex min-h-52 items-center justify-center text-xs text-muted" role="status">
        {t('settings.usage.loading')}
      </div>
    )
  }

  if (!stats) return null

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('settings.usage.title')}</h3>
        <p className="mt-0.5 text-label text-muted">{t('settings.usage.desc')}</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard
          label={t('settings.usage.totalTokens')}
          value={compactNumber(stats.totalTokens, locale)}
          hint={t('settings.usage.inputOutput', {
            input: compactNumber(stats.inputTokens, locale),
            output: compactNumber(stats.outputTokens, locale)
          })}
        />
        <SummaryCard
          label={t('settings.usage.conversations')}
          value={exactNumber(stats.conversationCount, locale)}
          hint={t('settings.usage.turnsHint', {
            count: exactNumber(stats.turnCount, locale)
          })}
        />
        <SummaryCard
          label={t('settings.usage.modelCalls')}
          value={exactNumber(stats.modelCallCount, locale)}
          hint={t('settings.usage.activeDaysHint', {
            count: exactNumber(stats.activeDays, locale)
          })}
        />
      </div>
      <ActivityHeatmap activity={stats.activity} locale={locale} />
      <ModelUsage models={stats.models} totalTokens={stats.totalTokens} locale={locale} />
      <p className="text-label text-muted">{t('settings.usage.localHint')}</p>
    </div>
  )
}
