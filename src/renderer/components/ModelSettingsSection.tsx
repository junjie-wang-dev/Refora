import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AiProvidersSection } from './AiProvidersSection'
import { AgentProfilesSection } from './AgentProfilesSection'

type ModelSettingsTab = 'cli' | 'api'

export function ModelSettingsSection() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<ModelSettingsTab>('cli')

  return (
    <div className="flex flex-col gap-5">
      <div
        className="grid grid-cols-2 rounded-xl border border-border bg-panel-2 p-1"
        role="tablist"
        aria-label={t('settings.modelSettings.tabsLabel')}
      >
        {(['cli', 'api'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              tab === item
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted hover:text-foreground'
            }`}
            onClick={() => setTab(item)}
          >
            {t(`settings.modelSettings.${item}`)}
          </button>
        ))}
      </div>

      {tab === 'cli' ? (
        <AgentProfilesSection mode="cli" />
      ) : (
        <div className="flex flex-col gap-5">
          <AiProvidersSection />
          <AgentProfilesSection mode="api" />
        </div>
      )}
    </div>
  )
}
