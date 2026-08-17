import { useTranslation } from 'react-i18next'
import { useState, useEffect, type ReactNode } from 'react'
import { Modal, Button, Select } from '@lobehub/ui'
import { Brain, ChartDonut, FolderOpen, Globe, HardDrives, Palette, Sparkle } from '@phosphor-icons/react'
import { useTheme } from '../hooks/useTheme'
import { api } from '../ipc'
import { changeLanguage, type AppLanguage } from '../i18n'
import { errorMessage, type WorkspaceAgentMemory } from '../../shared/ipc-types'
import { Input as UiInput } from './ui'
import { AiProvidersSection as ProviderConnectionsSection } from './AiProvidersSection'
import type { MineruEngineStatus, MineruInstallProgress } from '../../shared/mineru-types'
import { IpcChannel } from '../../shared/ipc-channels'
import { formatElapsedClock } from '../utils/format'
import { useWorkspaceStore } from '../store/workspaceStore'
import { WebSearchSettings } from './WebSearchSettings'
import { UsageStatsSection } from './UsageStatsSection'
import type { PdfOpenMode } from '../utils/openPdf'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

const THEME_OPTIONS = [
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
]

const LANG_OPTIONS = [
  { label: '中文', value: 'zh' },
  { label: 'English', value: 'en' },
]

const MINERU_INSTALL_STAGES = [
  'preparing',
  'installingTools',
  'installingPython',
  'installingMineru',
  'downloadingModels',
  'healthCheck',
  'finalizing'
] as const

type SettingsPage =
  | 'general'
  | 'appearance'
  | 'mineru'
  | 'aiProviders'
  | 'usage'
  | 'webSearch'
  | 'agentMemory'

const AGENT_MEMORY_PATHS = [
  '/brief.md',
  '/preferences.md',
  '/decisions.md',
  '/glossary.md'
] as const

function SettingsSection({
  title,
  description,
  action,
  children
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h4 className="text-sm font-semibold text-foreground">
            {title}
          </h4>
          {description && <p className="text-label text-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '\u2014'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`
}

function AgentMemorySettingsSection({ onError }: { onError: (message: string | null) => void }) {
  const { t } = useTranslation()
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const [memories, setMemories] = useState<WorkspaceAgentMemory[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [savingPath, setSavingPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.ai.workspaceMemories(activeWorkspaceId).then((entries) => {
      if (cancelled) return
      setMemories(entries)
      setDrafts(Object.fromEntries(AGENT_MEMORY_PATHS.map((path) => [
        path,
        entries.find((entry) => entry.path === path)?.content ?? ''
      ])))
    }).catch((error) => {
      if (!cancelled) onError(errorMessage(error, t('settings.agentMemory.loadFailed')))
    })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, onError, t])

  const save = async (path: string) => {
    setSavingPath(path)
    onError(null)
    try {
      const memory = await api.ai.updateWorkspaceMemory(
        activeWorkspaceId,
        path,
        drafts[path] ?? ''
      )
      setMemories((current) => [
        ...current.filter((entry) => entry.path !== path),
        memory
      ])
    } catch (error) {
      onError(errorMessage(error, t('settings.agentMemory.saveFailed')))
    } finally {
      setSavingPath(null)
    }
  }

  const clear = async (path: string) => {
    setSavingPath(path)
    onError(null)
    try {
      await api.ai.deleteWorkspaceMemory(activeWorkspaceId, path)
      setDrafts((current) => ({ ...current, [path]: '' }))
      setMemories((current) => current.filter((entry) => entry.path !== path))
    } catch (error) {
      onError(errorMessage(error, t('settings.agentMemory.saveFailed')))
    } finally {
      setSavingPath(null)
    }
  }

  return (
    <SettingsSection
      title={t('settings.agentMemory.title')}
      description={activeWorkspaceId
        ? t('settings.agentMemory.workspaceDesc')
        : t('settings.agentMemory.globalDesc')}
    >
      {AGENT_MEMORY_PATHS.map((path) => {
        const memory = memories.find((entry) => entry.path === path)
        const key = path.slice(1, -3)
        return (
          <div key={path} className="rounded-lg border border-border bg-panel p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-foreground">
                  {t(`settings.agentMemory.files.${key}`)}
                </div>
                <div className="text-label text-muted">
                  {path}{memory ? ` · v${memory.revision}` : ''}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="small"
                  disabled={savingPath === path || !(drafts[path] ?? '')}
                  onClick={() => void clear(path)}
                >
                  {t('common.delete')}
                </Button>
                <Button
                  type="primary"
                  size="small"
                  loading={savingPath === path}
                  onClick={() => void save(path)}
                >
                  {t('common.save')}
                </Button>
              </div>
            </div>
            <textarea
              className="mt-3 min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
              value={drafts[path] ?? ''}
              maxLength={16_384}
              onChange={(event) => setDrafts((current) => ({
                ...current,
                [path]: event.target.value
              }))}
            />
          </div>
        )
      })}
    </SettingsSection>
  )
}

function MineruSettingsSection({ onError }: { onError: (message: string | null) => void }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<MineruEngineStatus | null>(null)
  const [progress, setProgress] = useState<MineruInstallProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [now, setNow] = useState(Date.now())
  const loadFailedMessage = t('settings.mineru.loadFailed')
  const operationFailedMessage = t('settings.mineru.operationFailed')
  const currentProgress = progress ?? status?.progress ?? null
  const activeInstallId = currentProgress?.installId ?? null

  useEffect(() => {
    if (!activeInstallId) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [activeInstallId])

  useEffect(() => {
    const onProgress = (payload: MineruInstallProgress) => {
      if (payload.stage === 'completed') {
        setProgress(null)
        setStatus((current) => current ? { ...current, progress: null } : current)
        void api.mineru.status().then((next) => {
          setStatus(next)
          setProgress(next.progress)
        }).catch((error) => {
          onError(errorMessage(error, loadFailedMessage))
        })
        return
      }
      setProgress(payload)
      setStatus((current) => current ? { ...current, state: 'installing', progress: payload } : current)
    }
    api.events.onMineruInstallProgress(onProgress)
    void api.mineru.status().then(setStatus).catch((error) => {
      onError(errorMessage(error, loadFailedMessage))
    })
    return () => api.events.off(IpcChannel.EventMineruInstallProgress, onProgress)
  }, [loadFailedMessage, onError])

  const run = async (operation: () => Promise<MineruEngineStatus>) => {
    setBusy(true)
    onError(null)
    try {
      const next = await operation()
      setStatus(next)
      setProgress(next.progress)
    } catch (error) {
      onError(errorMessage(error, operationFailedMessage))
      const next = await api.mineru.status().catch(() => null)
      if (next) {
        setStatus(next)
        setProgress(next.progress)
      }
    } finally {
      setBusy(false)
    }
  }

  const installing = status?.state === 'installing' || Boolean(currentProgress)
  const installed = status?.state === 'installed'
  const stageIndex = currentProgress
    ? MINERU_INSTALL_STAGES.indexOf(currentProgress.stage as typeof MINERU_INSTALL_STAGES[number])
    : -1
  const stageNumber = stageIndex < 0 ? MINERU_INSTALL_STAGES.length : stageIndex + 1
  const transfer = currentProgress?.bytesTotal
    ? `${formatBytes(currentProgress.bytesReceived)} / ${formatBytes(currentProgress.bytesTotal)}`
    : currentProgress?.currentArtifact
  const elapsed = currentProgress
    ? formatElapsedClock(now - currentProgress.startedAt)
    : null

  const cancelInstall = async () => {
    setCancelling(true)
    try {
      const next = await api.mineru.cancelInstall()
      setStatus(next)
      setProgress(next.progress)
      onError(null)
    } catch (error) {
      onError(errorMessage(error, operationFailedMessage))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <SettingsSection
      title={t('settings.mineru.title')}
      description={t('settings.mineru.desc')}
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-muted">{t('settings.mineru.installLocation')}</label>
        <div className="flex gap-2">
          <span className="min-w-0 flex-1 truncate rounded-lg bg-panel-2 px-3 py-1.5 text-xs text-foreground">
            {status?.installRoot || '\u2014'}
          </span>
          <Button
            size="small"
            disabled={installing || installed || busy}
            onClick={() => void run(() => api.mineru.chooseInstallRoot())}
          >
            {t('settings.chooseFolder')}
          </Button>
        </div>
        <span className="text-label text-muted">{t('settings.mineru.locationHint')}</span>
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t(`settings.mineru.state.${status?.state ?? 'loading'}`)}
            </div>
            <div className="mt-1 text-xs text-muted">
              {installed
                ? t('settings.mineru.installedDetails', {
                    version: status?.version,
                    size: formatBytes(status?.diskBytes ?? null)
                  })
                : t('settings.mineru.requirements')}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {installing ? (
              <Button
                size="small"
                loading={cancelling}
                disabled={!currentProgress?.cancellable || cancelling}
                onClick={() => void cancelInstall()}
              >
                {t('common.cancel')}
              </Button>
            ) : installed ? (
              <Button
                size="small"
                danger
                disabled={busy}
                onClick={() => void run(() => api.mineru.uninstall())}
              >
                {t('settings.mineru.uninstall')}
              </Button>
            ) : (
              <Button
                type="primary"
                size="small"
                loading={busy}
                onClick={() => void run(() => api.mineru.install())}
              >
                {t('settings.mineru.install')}
              </Button>
            )}
          </div>
        </div>

        {currentProgress && (
          <div className="mt-4 flex flex-col gap-2" role="status">
            <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div
                className={`h-full rounded-full bg-accent ${
                  currentProgress.percent == null
                    ? 'mineru-progress-indeterminate'
                    : 'transition-[width] duration-300'
                }`}
                style={currentProgress.percent == null
                  ? undefined
                  : { width: `${Math.max(0, Math.min(100, currentProgress.percent))}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-label text-muted">
              <span>{t(`settings.mineru.progress.${currentProgress.stage}`)}</span>
              {currentProgress.percent != null && <span>{Math.round(currentProgress.percent)}%</span>}
            </div>
            <div className="flex items-center justify-between gap-3 text-label text-muted">
              <span className="truncate">
                {t('settings.mineru.progressStep', {
                  current: stageNumber,
                  total: MINERU_INSTALL_STAGES.length
                })}
                {transfer ? ` · ${transfer}` : ''}
              </span>
              {elapsed && (
                <span className="shrink-0">{t('settings.mineru.elapsed', { time: elapsed })}</span>
              )}
            </div>
          </div>
        )}

        {status?.error && !installing && (
          <div className="mt-3 text-xs text-error">{status.error}</div>
        )}
      </div>
    </SettingsSection>
  )
}

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { t, i18n } = useTranslation()
  const { mode: themeMode, setMode: setThemeMode } = useTheme()
  const [libraryFolderPath, setLibraryFolderPath] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [crossrefMailto, setCrossrefMailto] = useState('')
  const [pdfOpenMode, setPdfOpenMode] = useState<PdfOpenMode>('system')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [activePage, setActivePage] = useState<SettingsPage>('general')

  useEffect(() => {
    if (open) {
      setError(null)
      setActivePage('general')
      void loadSettings()
    }
  }, [open])

  const loadSettings = async () => {
    try {
      const lib = await api.settings.get<string>('libraryFolderPath', '')
      const proxy = await api.settings.get<string>('proxyUrl', '')
      const mailto = await api.settings.get<string>('crossrefMailto', '')
      const sc = await api.settings.get<string>('sidebarCollapsed', '0')
      const openMode = await api.settings.get<PdfOpenMode>('pdfOpenMode', 'system')
      setLibraryFolderPath(lib)
      setProxyUrl(proxy)
      setCrossrefMailto(mailto)
      setSidebarCollapsed(sc === '1')
      setPdfOpenMode(openMode === 'builtin' ? 'builtin' : 'system')
    } catch {
      setError('Failed to load settings')
    }
  }

  const handleChooseFolder = async () => {
    setError(null)
    try {
      const path = await api.dialog.openDirectory()
      if (!path) return
      setSwitching(true)
      await api.library.switch(path)
      setLibraryFolderPath(path)
    } catch (e) {
      setError(errorMessage(e, 'Failed to set library folder'))
    } finally {
      setSwitching(false)
    }
  }

  const saveProxy = async () => {
    setError(null)
    try {
      await api.settings.set('proxyUrl', proxyUrl)
    } catch (e) {
      setError(errorMessage(e, 'Failed to save proxy'))
    }
  }

  const saveMailto = async () => {
    setError(null)
    try {
      await api.settings.set('crossrefMailto', crossrefMailto)
    } catch (e) {
      setError(errorMessage(e, 'Failed to save mailto'))
    }
  }

  const handlePdfOpenModeChange = async (value: string) => {
    const nextMode = value === 'builtin' ? 'builtin' : 'system'
    const previousMode = pdfOpenMode
    setPdfOpenMode(nextMode)
    setError(null)
    try {
      await api.settings.set('pdfOpenMode', nextMode)
    } catch (e) {
      setPdfOpenMode(previousMode)
      setError(errorMessage(e, t('settings.pdfOpenMode.saveFailed')))
    }
  }

  const handleSidebarToggle = async () => {
    const newVal = !sidebarCollapsed
    setSidebarCollapsed(newVal)
    try {
      await api.settings.set('sidebarCollapsed', newVal ? '1' : '0')
    } catch (e) {
      setSidebarCollapsed(!newVal)
      setError(errorMessage(e, 'Failed to update sidebar'))
    }
  }

  const handleThemeChange = (value: string) => {
    setThemeMode(value as 'system' | 'dark' | 'light')
  }

  const handleLanguageChange = async (value: string) => {
    const lang = value as AppLanguage
    setError(null)
    try {
      await api.settings.set('language', lang)
      await changeLanguage(lang)
    } catch (e) {
      setError(errorMessage(e, 'Failed to change language'))
    }
  }

  const currentLang = (i18n.language?.startsWith('zh') ? 'zh' : 'en') as AppLanguage
  const pages = [
    {
      id: 'general' as const,
      label: t('settings.sectionGeneral.title'),
      description: t('settings.sectionGeneral.desc'),
      icon: FolderOpen
    },
    {
      id: 'appearance' as const,
      label: t('settings.sectionAppearance.title'),
      description: t('settings.sectionAppearance.desc'),
      icon: Palette
    },
    {
      id: 'mineru' as const,
      label: t('settings.mineru.title'),
      description: t('settings.mineru.desc'),
      icon: HardDrives
    },
    {
      id: 'aiProviders' as const,
      label: t('settings.aiProviders.title'),
      description: t('settings.aiProviders.desc'),
      icon: Sparkle
    },
    {
      id: 'usage' as const,
      label: t('settings.usage.title'),
      description: t('settings.usage.desc'),
      icon: ChartDonut
    },
    {
      id: 'webSearch' as const,
      label: t('settings.webSearch.title'),
      description: t('settings.webSearch.desc'),
      icon: Globe
    },
    {
      id: 'agentMemory' as const,
      label: t('settings.agentMemory.title'),
      description: t('settings.agentMemory.desc'),
      icon: Brain
    }
  ]

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={null}
      width={920}
      className="settings-modal-shell"
      paddings={{ desktop: 0 }}
      styles={{ body: { padding: 0 } }}
      footer={null}
      destroyOnHidden
    >
      <div
        className="flex h-[min(68vh,680px)] min-h-[520px] overflow-hidden"
        data-settings-layout
      >
        <aside className="settings-sidebar-surface flex w-52 shrink-0 flex-col border-r border-border p-3 pt-12">
          <nav className="flex flex-col gap-1" aria-label={t('settings.title')}>
            {pages.map((page) => {
              const Icon = page.icon
              const selected = page.id === activePage
              return (
                <button
                  key={page.id}
                  type="button"
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs transition-colors ${
                    selected
                      ? 'bg-background font-medium text-foreground shadow-sm'
                      : 'text-muted hover:bg-background/60 hover:text-foreground'
                  }`}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => {
                    setActivePage(page.id)
                    setError(null)
                  }}
                >
                  <Icon className="h-4 w-4 shrink-0" weight={selected ? 'fill' : 'regular'} />
                  <span className="truncate">{page.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto bg-background p-5 pt-12">
          {activePage === 'general' && (
            <SettingsSection
              title={t('settings.sectionGeneral.title')}
              description={t('settings.sectionGeneral.desc')}
            >
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted">{t('settings.libraryFolder')}</label>
                <div className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate rounded-lg bg-panel-2 px-3 py-1.5 text-xs text-foreground">
                    {libraryFolderPath || '\u2014'}
                  </span>
                  <Button size="small" onClick={handleChooseFolder} loading={switching}>
                    {switching ? t('settings.switching') : t('settings.chooseFolder')}
                  </Button>
                </div>
                <span className="text-label text-muted">
                  {t('settings.libraryFolderAutoImportHint')}
                </span>
              </div>

              <div className="flex items-start justify-between gap-6">
                <div className="flex min-w-0 flex-col gap-1">
                  <label className="text-xs text-foreground">
                    {t('settings.pdfOpenMode.title')}
                  </label>
                  <span className="text-label text-muted">
                    {t('settings.pdfOpenMode.desc')}
                  </span>
                </div>
                <Select
                  value={pdfOpenMode}
                  onChange={handlePdfOpenModeChange}
                  options={[
                    { label: t('settings.pdfOpenMode.system'), value: 'system' },
                    { label: t('settings.pdfOpenMode.builtin'), value: 'builtin' }
                  ]}
                  size="small"
                  style={{ width: 180 }}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted">{t('settings.proxy')}</label>
                <UiInput
                  variant="outlined"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  onBlur={saveProxy}
                  onPressEnter={saveProxy}
                  placeholder="http://proxy:8080"
                  inputSize="sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted">{t('settings.crossrefMailto')}</label>
                <UiInput
                  variant="outlined"
                  value={crossrefMailto}
                  onChange={(e) => setCrossrefMailto(e.target.value)}
                  onBlur={saveMailto}
                  onPressEnter={saveMailto}
                  placeholder="user@example.com"
                  inputSize="sm"
                />
              </div>
            </SettingsSection>
          )}

          {activePage === 'appearance' && (
            <SettingsSection
              title={t('settings.sectionAppearance.title')}
              description={t('settings.sectionAppearance.desc')}
            >
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted">{t('settings.theme')}</label>
                <Select
                  value={themeMode}
                  onChange={handleThemeChange}
                  options={THEME_OPTIONS}
                  size="small"
                  style={{ width: 140 }}
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-xs text-muted">{t('settings.language')}</label>
                <Select
                  value={currentLang}
                  onChange={handleLanguageChange}
                  options={LANG_OPTIONS}
                  size="small"
                  style={{ width: 140 }}
                />
              </div>

              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="m-0"
                  checked={sidebarCollapsed}
                  onChange={handleSidebarToggle}
                />
                <span className="text-xs text-foreground">
                  {t('settings.sidebarCollapsed')}
                </span>
              </label>
            </SettingsSection>
          )}

          {activePage === 'mineru' && <MineruSettingsSection onError={setError} />}

          {activePage === 'aiProviders' && <ProviderConnectionsSection />}

          {activePage === 'usage' && <UsageStatsSection onError={setError} />}

          {activePage === 'webSearch' && <WebSearchSettings />}

          {activePage === 'agentMemory' && <AgentMemorySettingsSection onError={setError} />}

          {error && (
            <div className="mt-4 rounded-lg bg-error/10 px-3 py-1.5 text-xs text-error">
              {error}
            </div>
          )}
        </main>
      </div>
    </Modal>
  )
}
