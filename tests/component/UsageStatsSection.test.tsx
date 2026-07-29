import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, params?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'settings.usage.title': 'AI Usage',
        'settings.usage.desc': 'Local token and conversation statistics',
        'settings.usage.loading': 'Loading usage statistics…',
        'settings.usage.loadFailed': 'Failed to load AI usage statistics',
        'settings.usage.totalTokens': 'Total tokens',
        'settings.usage.conversations': 'Conversations',
        'settings.usage.modelCalls': 'Model calls',
        'settings.usage.activityTitle': 'Activity heatmap',
        'settings.usage.activityLabel': 'AI activity during the last 52 weeks',
        'settings.usage.less': 'Less',
        'settings.usage.more': 'More',
        'settings.usage.modelTitle': 'Model usage',
        'settings.usage.tokens': 'tokens',
        'settings.usage.otherModels': 'Other models',
        'settings.usage.empty': 'No usage',
        'settings.usage.localHint': 'Stored locally'
      }
      if (key === 'settings.usage.inputOutput') return `${params?.input} input · ${params?.output} output`
      if (key === 'settings.usage.turnsHint') return `${params?.count} user turns`
      if (key === 'settings.usage.activeDaysHint') return `${params?.count} active days`
      if (key === 'settings.usage.modelDetails') return `${params?.tokens} tokens · ${params?.calls} calls`
      if (key === 'settings.usage.activityTooltip') return `${params?.date} · ${params?.tokens} tokens`
      if (key === 'settings.usage.noActivityTooltip') return `${params?.date} · No activity`
      return labels[key] ?? key
    }
  })
}))

import { api } from '../../src/renderer/ipc'
import { UsageStatsSection } from '../../src/renderer/components/UsageStatsSection'

describe('UsageStatsSection', () => {
  beforeEach(() => {
    cleanup()
    vi.spyOn(api.ai, 'usageStats').mockResolvedValue({
      totalTokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      conversationCount: 4,
      turnCount: 12,
      modelCallCount: 15,
      activeDays: 3,
      models: [
        { model: 'model-a', tokens: 1000, calls: 10 },
        { model: 'model-b', tokens: 500, calls: 5 }
      ],
      activity: [{ date: '2026-07-29', tokens: 1500, turns: 12 }]
    })
  })

  it('renders totals, a 52-week heatmap, and model distribution', async () => {
    const { container } = render(<UsageStatsSection onError={vi.fn()} />)

    expect(await screen.findByText('AI Usage')).toBeInTheDocument()
    expect(screen.getAllByText('1.5K')).toHaveLength(2)
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('model-a')).toBeInTheDocument()
    expect(screen.getByText('model-b')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'AI activity during the last 52 weeks' }).children)
      .toHaveLength(364)
    expect(container.querySelector('[style*="conic-gradient"]')).toBeInTheDocument()
  })
})
