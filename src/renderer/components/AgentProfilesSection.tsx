import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowClockwise,
  Check,
  PencilSimple,
  Plus,
  Terminal,
  Trash,
  X
} from '@phosphor-icons/react'
import type {
  AgentProfile,
  AgentProfileInput,
  AgentWebSearchPolicy,
  AiReasoningEffort,
  CliModelInfo,
  CliRuntimeInfo
} from '../../shared/ipc-types'
import { errorMessage } from '../../shared/ipc-types'
import { api } from '../ipc'
import { Badge, Button, Input } from './ui'
import { useModalDialog } from '../hooks/useModalDialog'
import { useAgentCatalogStore } from '../store/agentCatalogStore'

interface AgentProfilesSectionProps {
  mode?: 'cli' | 'api'
}

interface CliForm {
  id: string | null
  name: string
  cliRuntimeId: string
  executablePath: string
  model: string
  reasoningEffort: AiReasoningEffort
  nativeWebSearch: boolean
  webSearchPolicy: AgentWebSearchPolicy
}

const SEARCH_POLICIES: AgentWebSearchPolicy[] = [
  'auto',
  'native',
  'refora',
  'disabled'
]

const FALLBACK_RUNTIMES: CliRuntimeInfo[] = [
  {
    ok: false,
    runtimeId: 'codex',
    label: 'OpenAI Codex CLI',
    defaultExecutable: 'codex',
    available: false,
    reasoningMode: 'select',
    capabilities: { nativeWebSearch: true, mcp: true, sessionResume: true },
    models: [
      {
        id: 'default',
        label: 'CLI default',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium'
      }
    ]
  },
  {
    ok: false,
    runtimeId: 'gemini',
    label: 'Gemini CLI',
    defaultExecutable: 'gemini',
    available: false,
    reasoningMode: 'managed',
    capabilities: { nativeWebSearch: true, mcp: true, sessionResume: true },
    models: [
      {
        id: 'default',
        label: 'Auto (CLI default)',
        reasoningEfforts: [],
        defaultReasoningEffort: null
      }
    ]
  }
]

function firstModel(runtime: CliRuntimeInfo): CliModelInfo {
  return runtime.models[0] ?? {
    id: 'default',
    label: 'CLI default',
    reasoningEfforts: [],
    defaultReasoningEffort: null
  }
}

function formForRuntime(runtime: CliRuntimeInfo): CliForm {
  const model = firstModel(runtime)
  return {
    id: null,
    name: runtime.label,
    cliRuntimeId: runtime.runtimeId,
    executablePath: runtime.executablePath ?? '',
    model: model.id,
    reasoningEffort: model.defaultReasoningEffort ?? 'medium',
    nativeWebSearch: runtime.capabilities.nativeWebSearch,
    webSearchPolicy: 'auto'
  }
}

function editCliForm(profile: AgentProfile): CliForm {
  return {
    id: profile.id,
    name: profile.name,
    cliRuntimeId: profile.cliRuntimeId ?? 'codex',
    executablePath: profile.executablePath ?? '',
    model: profile.model || 'default',
    reasoningEffort: profile.reasoningEffort,
    nativeWebSearch: profile.nativeWebSearch,
    webSearchPolicy: profile.webSearchPolicy
  }
}

export function AgentProfilesSection({ mode = 'cli' }: AgentProfilesSectionProps) {
  const { t } = useTranslation()
  const translationRef = useRef(t)
  translationRef.current = t
  const profiles = useAgentCatalogStore((state) => state.profiles)
  const refreshAgentCatalog = useAgentCatalogStore((state) => state.refresh)
  const removeCatalogProfile = useAgentCatalogStore((state) => state.removeProfile)
  const [runtimes, setRuntimes] = useState<CliRuntimeInfo[]>([])
  const [form, setForm] = useState<CliForm | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeForm = useCallback(() => setForm(null), [])
  const dialogRef = useModalDialog<HTMLDivElement>(!!form, closeForm)

  const availableRuntimes = runtimes.length > 0 ? runtimes : FALLBACK_RUNTIMES

  const load = useCallback(async (surfaceError = true): Promise<unknown | null> => {
    try {
      await refreshAgentCatalog()
      return null
    } catch (cause) {
      if (surfaceError) {
        setError(errorMessage(cause, translationRef.current('settings.agentProfiles.loadFail')))
      }
      return cause
    }
  }, [refreshAgentCatalog])

  const scan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      setRuntimes(await api.agentProfiles.scanRuntimes())
    } catch (cause) {
      setError(errorMessage(cause, translationRef.current('settings.agentProfiles.scanFail')))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void load()
    if (mode === 'cli') void scan()
  }, [load, mode, scan])

  const updateSearch = async (
    profile: AgentProfile,
    patch: { nativeWebSearch?: boolean; webSearchPolicy?: AgentWebSearchPolicy }
  ) => {
    setError(null)
    try {
      await api.agentProfiles.update(profile.id, patch)
      const loadFailure = await load(false)
      if (loadFailure) throw loadFailure
    } catch (cause) {
      setError(errorMessage(cause, t('settings.agentProfiles.saveFail')))
    }
  }

  const save = async () => {
    if (!form || !form.name.trim()) return
    setSaving(true)
    setError(null)
    const runtime = availableRuntimes.find((item) => item.runtimeId === form.cliRuntimeId)
    const model = runtime?.models.find((item) => item.id === form.model)
    const reasoningEffort = model?.reasoningEfforts.includes(form.reasoningEffort)
      ? form.reasoningEffort
      : model?.defaultReasoningEffort ?? model?.reasoningEfforts[0] ?? form.reasoningEffort
    const payload: AgentProfileInput = {
      kind: 'cli',
      name: form.name.trim(),
      cliRuntimeId: form.cliRuntimeId,
      executablePath: form.executablePath.trim() || null,
      model: form.model || 'default',
      reasoningEffort: runtime?.reasoningMode === 'managed' ? 'medium' : reasoningEffort,
      nativeWebSearch: runtime?.capabilities.nativeWebSearch ?? form.nativeWebSearch,
      webSearchPolicy: form.webSearchPolicy
    }
    try {
      if (form.id) {
        await api.agentProfiles.update(form.id, payload)
      } else {
        await api.agentProfiles.create(payload)
      }
      setForm(null)
      await load()
    } catch (cause) {
      setError(errorMessage(cause, t('settings.agentProfiles.saveFail')))
    } finally {
      setSaving(false)
    }
  }

  const test = async (profile: AgentProfile) => {
    setTestingId(profile.id)
    setError(null)
    try {
      const result = await api.agentProfiles.test(profile.id)
      setTestResults((current) => ({ ...current, [profile.id]: result.ok }))
      if (!result.ok && result.error) setError(result.error)
    } catch (cause) {
      setTestResults((current) => ({ ...current, [profile.id]: false }))
      setError(errorMessage(cause, t('settings.agentProfiles.testFail')))
    } finally {
      setTestingId(null)
    }
  }

  const remove = async (profile: AgentProfile) => {
    setError(null)
    try {
      await api.agentProfiles.delete(profile.id)
    } catch (cause) {
      setError(errorMessage(cause, t('settings.agentProfiles.deleteFail')))
      return
    }
    removeCatalogProfile(profile.id)
    setForm((current) => current?.id === profile.id ? null : current)
    try {
      const [active, selected] = await Promise.all([
        api.settings.get<string>('activeAgentProfileId', ''),
        api.settings.get<string>('chatSelectedAgentProfileId', '')
      ])
      if (active === profile.id) await api.settings.set('activeAgentProfileId', '')
      if (selected === profile.id) {
        await api.settings.set('chatSelectedAgentProfileId', '')
        await api.settings.set('chatSelectedModel', '')
      }
      const loadFailure = await load(false)
      if (loadFailure) throw loadFailure
    } catch (cause) {
      const cleanupMessage = t('settings.agentProfiles.deleteCleanupFail')
      const detail = errorMessage(cause, '')
      setError(detail ? `${cleanupMessage} ${detail}` : cleanupMessage)
    }
  }

  const apiProfiles = profiles.filter((profile) => profile.kind === 'api')
  const cliProfiles = profiles.filter((profile) => profile.kind === 'cli')
  const runtime = form
    ? availableRuntimes.find((item) => item.runtimeId === form.cliRuntimeId)
    : undefined
  const modelOptions = useMemo(() => {
    if (!form) return []
    const models = runtime?.models ?? []
    return models.some((model) => model.id === form.model)
      ? models
      : [
          {
            id: form.model,
            label: form.model,
            reasoningEfforts: [] as AiReasoningEffort[],
            defaultReasoningEffort: null
          },
          ...models
        ]
  }, [form, runtime])
  const selectedModel = modelOptions.find((model) => model.id === form?.model)
  const reasoningEfforts = selectedModel?.reasoningEfforts.length
    ? selectedModel.reasoningEfforts
    : runtime?.reasoningMode === 'select'
      ? [form?.reasoningEffort ?? 'medium']
      : []

  if (mode === 'api') {
    return (
      <section className="flex flex-col gap-3 border-t border-border pt-5">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {t('settings.agentProfiles.apiSearchTitle')}
          </h4>
          <p className="mt-0.5 text-label text-muted">
            {t('settings.agentProfiles.apiSearchDesc')}
          </p>
        </div>
        {apiProfiles.map((profile) => (
          <div
            key={profile.id}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-xl border border-border bg-panel-2 px-3 py-2.5"
          >
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-foreground">{profile.name}</span>
              <span className="block truncate text-label text-muted">{profile.model}</span>
            </span>
            <label className="flex items-center gap-1.5 text-label text-muted">
              <input
                type="checkbox"
                checked={profile.nativeWebSearch}
                onChange={(event) => void updateSearch(profile, {
                  nativeWebSearch: event.target.checked,
                  ...(event.target.checked || profile.webSearchPolicy !== 'native'
                    ? {}
                    : { webSearchPolicy: 'refora' as const })
                })}
              />
              {t('settings.agentProfiles.nativeSearch')}
            </label>
            <select
              className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
              value={profile.webSearchPolicy}
              onChange={(event) => void updateSearch(profile, {
                webSearchPolicy: event.target.value as AgentWebSearchPolicy
              })}
            >
              {SEARCH_POLICIES
                .filter((policy) => policy !== 'native' || profile.nativeWebSearch)
                .map((policy) => (
                  <option key={policy} value={policy}>
                    {t(`settings.agentProfiles.search.${policy}`)}
                  </option>
                ))}
            </select>
          </div>
        ))}
        {apiProfiles.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
            {t('settings.agentProfiles.noApiProfiles')}
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{error}</div>
        )}
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {t('settings.agentProfiles.title')}
          </h4>
          <p className="mt-0.5 text-label text-muted">
            {t('settings.agentProfiles.desc')}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowClockwise className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />}
            disabled={scanning}
            onClick={() => void scan()}
          >
            {t('settings.agentProfiles.rescan')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setForm(formForRuntime(availableRuntimes[0]))}
          >
            {t('settings.agentProfiles.addCli')}
          </Button>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {availableRuntimes.map((item) => {
          const configured = cliProfiles.some((profile) => profile.cliRuntimeId === item.runtimeId)
          const status = !item.available
            ? 'missing'
            : item.authenticated === false
              ? 'authRequired'
              : item.authenticated === true
                ? 'ready'
                : 'detected'
          const badgeVariant = status === 'ready' || status === 'detected'
            ? 'success'
            : status === 'authRequired'
              ? 'warning'
              : 'default'
          return (
            <div
              key={item.runtimeId}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-panel-2 p-3"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background">
                  <Terminal className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{item.label}</span>
                  <span className="block truncate text-label text-muted">
                    {item.version || item.defaultExecutable}
                  </span>
                </span>
                <Badge variant={badgeVariant} size="sm" subtle>
                  {t(`settings.agentProfiles.status.${status}`)}
                </Badge>
              </div>
              <span className="truncate text-label text-muted" title={item.executablePath ?? undefined}>
                {item.executablePath || t('settings.agentProfiles.notFound')}
              </span>
              <div className="flex items-center justify-between gap-2">
                <span className="text-label text-muted">
                  {t('settings.agentProfiles.modelCount', { count: item.models.length })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setForm(formForRuntime(item))}
                >
                  {configured
                    ? t('settings.agentProfiles.addAnotherRuntime')
                    : t('settings.agentProfiles.configure')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {cliProfiles.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <span className="text-label font-medium text-muted">
            {t('settings.agentProfiles.configuredCli')}
          </span>
          {cliProfiles.map((profile) => (
            <div
              key={profile.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-panel-2 px-3 py-2.5"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-background">
                <Terminal className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                  {profile.name}
                  <Badge variant="accent" size="sm" subtle>CLI</Badge>
                </span>
                <span className="mt-0.5 block truncate text-label text-muted">
                  {profile.cliRuntimeId} · {profile.model || 'default'} · {t(`settings.agentProfiles.search.${profile.webSearchPolicy}`)}
                </span>
                {testResults[profile.id] !== undefined && (
                  <span className={`text-label ${testResults[profile.id] ? 'text-success' : 'text-error'}`}>
                    {testResults[profile.id]
                      ? t('settings.agentProfiles.testOk')
                      : t('settings.agentProfiles.testFail')}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  loading={testingId === profile.id}
                  title={t('settings.agentProfiles.test')}
                  onClick={() => void test(profile)}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  title={t('common.edit')}
                  onClick={() => setForm(editCliForm(profile))}
                >
                  <PencilSimple className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  className="text-error"
                  title={t('common.delete')}
                  onClick={() => void remove(profile)}
                >
                  <Trash className="h-3.5 w-3.5" />
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">{error}</div>
      )}

      {form && (
        <div
          ref={dialogRef}
          className="dialog-overlay z-[1000]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="agent-profile-dialog-title"
          tabIndex={-1}
        >
          <div className="dialog-panel flex w-[min(520px,calc(100vw-48px))] flex-col gap-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="agent-profile-dialog-title" className="text-sm font-semibold text-foreground">
                  {form.id ? t('settings.agentProfiles.editCli') : t('settings.agentProfiles.addCli')}
                </h3>
                <p className="mt-1 text-xs text-muted">{t('settings.agentProfiles.cliHint')}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={closeForm}
                title={t('common.close')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <label className="flex flex-col gap-1.5 text-xs text-foreground">
              {t('settings.agentProfiles.name')}
              <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-foreground">
              {t('settings.agentProfiles.runtime')}
              <select
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                value={form.cliRuntimeId}
                disabled={form.id !== null}
                onChange={(event) => {
                  const selectedRuntime = availableRuntimes.find(
                    (item) => item.runtimeId === event.target.value
                  )
                  if (selectedRuntime) setForm(formForRuntime(selectedRuntime))
                }}
              >
                {availableRuntimes.map((item) => (
                  <option key={item.runtimeId} value={item.runtimeId}>{item.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-foreground">
              {t('settings.agentProfiles.executable')}
              <Input
                value={form.executablePath}
                placeholder={runtime?.defaultExecutable}
                onChange={(event) => setForm({ ...form, executablePath: event.target.value })}
              />
              {runtime?.executablePath && (
                <span className="text-label text-muted">
                  {t('settings.agentProfiles.detectedPath', { path: runtime.executablePath })}
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-foreground">
              {t('settings.agentProfiles.model')}
              <select
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                value={form.model}
                onChange={(event) => {
                  const model = modelOptions.find((item) => item.id === event.target.value)
                  setForm({
                    ...form,
                    model: event.target.value,
                    reasoningEffort: model?.defaultReasoningEffort ?? form.reasoningEffort
                  })
                }}
              >
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5 text-xs text-foreground">
                {t('settings.agentProfiles.reasoning')}
                {runtime?.reasoningMode === 'managed' ? (
                  <span className="rounded-lg border border-border bg-panel-2 px-3 py-2 text-xs text-muted">
                    {t('settings.agentProfiles.reasoningManaged')}
                  </span>
                ) : (
                  <select
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                    value={reasoningEfforts.includes(form.reasoningEffort)
                      ? form.reasoningEffort
                      : reasoningEfforts[0]}
                    onChange={(event) => setForm({
                      ...form,
                      reasoningEffort: event.target.value as AiReasoningEffort
                    })}
                  >
                    {reasoningEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {t(`settings.aiProviders.effort.${effort}`, effort)}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <label className="flex flex-col gap-1.5 text-xs text-foreground">
                {t('settings.agentProfiles.searchPolicy')}
                <select
                  className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                  value={form.webSearchPolicy}
                  onChange={(event) => setForm({
                    ...form,
                    webSearchPolicy: event.target.value as AgentWebSearchPolicy
                  })}
                >
                  {SEARCH_POLICIES
                    .filter((policy) => policy !== 'native' || form.nativeWebSearch)
                    .map((policy) => (
                      <option key={policy} value={policy}>{t(`settings.agentProfiles.search.${policy}`)}</option>
                    ))}
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={form.nativeWebSearch} disabled />
              {t('settings.agentProfiles.nativeSearchAvailable')}
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={closeForm}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
