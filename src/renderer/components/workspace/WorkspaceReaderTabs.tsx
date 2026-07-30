import { ArrowsInSimple, ArrowsOutSimple, X } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'

export interface WorkspaceReaderTab {
  id: string
  title: string
  kind: 'workspace' | 'markdown' | 'pdf'
  active: boolean
  onSelect: () => void
  onClose: () => void
}

interface WorkspaceReaderTabsProps {
  tabs: WorkspaceReaderTab[]
  fullscreen: boolean
  onToggleFullscreen: () => void
}

export default function WorkspaceReaderTabs({
  tabs,
  fullscreen,
  onToggleFullscreen
}: WorkspaceReaderTabsProps) {
  const { t } = useTranslation()

  return (
    <div
      className="drag-region relative z-30 flex h-9 shrink-0 items-stretch border-b border-border bg-panel"
      data-testid="workspace-reader-tab-header"
    >
      <div
        className="workspace-reader-tabs-scroll no-drag flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
        role="tablist"
        aria-label={t('workspace.readerTabs')}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`group relative flex h-full min-w-40 max-w-72 shrink-0 items-center rounded-tr-xl border-r border-border/70 pl-4 pr-1 transition-colors duration-150 ${
              tab.active
                ? 'bg-background text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent'
                : 'bg-panel text-muted hover:bg-hover hover:text-foreground'
            }`}
            data-testid="workspace-reader-tab"
            data-reader-tab-kind={tab.kind}
            data-active={tab.active}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              className="h-full min-w-0 flex-1 truncate text-left text-sm font-medium"
              title={tab.title}
              onClick={tab.onSelect}
            >
              {tab.title}
            </button>
            <button
              type="button"
              className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-active hover:text-foreground"
              title={t('workspace.closeReaderTab', { title: tab.title })}
              aria-label={t('workspace.closeReaderTab', { title: tab.title })}
              onClick={tab.onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="no-drag mx-3 my-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
        title={fullscreen ? t('workspace.exitFullscreen') : t('workspace.enterFullscreen')}
        aria-label={fullscreen ? t('workspace.exitFullscreen') : t('workspace.enterFullscreen')}
        onClick={onToggleFullscreen}
      >
        {fullscreen
          ? <ArrowsInSimple className="h-4 w-4" />
          : <ArrowsOutSimple className="h-4 w-4" />}
      </button>
    </div>
  )
}
