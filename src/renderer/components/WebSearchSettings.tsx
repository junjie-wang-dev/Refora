import { useEffect, useState } from 'react'
import { Button, Select } from './ui/LobeControls'
import { useTranslation } from 'react-i18next'
import { api } from '../ipc'
import { errorMessage } from '../../shared/ipc-types'
import type {
  WebSearchConfig,
  WebSearchProvider,
  WebSearchTestResult
} from '../../shared/webSearch'
import { Input } from './ui'

export function WebSearchSettings() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<WebSearchConfig | null>(null)
  const [provider, setProvider] = useState<WebSearchProvider>('disabled')
  const [tavilyApiKey, setTavilyApiKey] = useState('')
  const [braveApiKey, setBraveApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(null)

  const load = async () => {
    const next = await api.webSearch.getConfig()
    setConfig(next)
    setProvider(next.provider)
  }

  useEffect(() => {
    let cancelled = false
    void api.webSearch.getConfig().then((next) => {
      if (cancelled) return
      setConfig(next)
      setProvider(next.provider)
    }).catch((cause) => {
      if (!cancelled) setError(errorMessage(cause, t('settings.webSearch.loadFailed')))
    })
    return () => {
      cancelled = true
    }
  }, [t])

  const save = async (): Promise<WebSearchConfig | null> => {
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      const next = await api.webSearch.updateConfig({
        provider,
        ...(tavilyApiKey.trim() ? { tavilyApiKey: tavilyApiKey.trim() } : {}),
        ...(braveApiKey.trim() ? { braveApiKey: braveApiKey.trim() } : {})
      })
      setConfig(next)
      setProvider(next.provider)
      setTavilyApiKey('')
      setBraveApiKey('')
      return next
    } catch (cause) {
      setError(errorMessage(cause, t('settings.webSearch.saveFailed')))
      return null
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError(null)
    setTestResult(null)
    try {
      const saved = await save()
      if (!saved) return
      const result = await api.webSearch.test()
      setTestResult(result)
      await load()
    } catch (cause) {
      setError(errorMessage(cause, t('settings.webSearch.testFailed')))
    } finally {
      setTesting(false)
    }
  }

  const clearKey = async (key: 'tavily' | 'brave') => {
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      const clearsSelectedProvider = provider === key
      const next = await api.webSearch.updateConfig({
        ...(clearsSelectedProvider ? { provider: 'disabled' } : {}),
        ...(key === 'tavily'
          ? { clearTavilyApiKey: true }
          : { clearBraveApiKey: true })
      })
      setConfig(next)
      setProvider(next.provider)
    } catch (cause) {
      setError(errorMessage(cause, t('settings.webSearch.saveFailed')))
    } finally {
      setBusy(false)
    }
  }

  const providerOptions = [
    { value: 'disabled', label: t('settings.webSearch.providers.disabled') },
    { value: 'ddgs', label: t('settings.webSearch.providers.ddgs') },
    { value: 'tavily', label: t('settings.webSearch.providers.tavily') },
    { value: 'brave', label: t('settings.webSearch.providers.brave') }
  ]

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h4 className="text-sm font-semibold text-foreground">
          {t('settings.webSearch.title')}
        </h4>
        <p className="mt-0.5 text-label text-muted">
          {t('settings.webSearch.desc')}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs font-medium text-foreground">
              {t('settings.webSearch.activeProvider')}
            </div>
            <div className="mt-1 text-label text-muted">
              {t('settings.webSearch.activeProviderHint')}
            </div>
          </div>
          <Select
            aria-label={t('settings.webSearch.activeProvider')}
            value={provider}
            options={providerOptions}
            onChange={(value) => {
              setProvider(value as WebSearchProvider)
              setTestResult(null)
            }}
            size="small"
            style={{ width: 190 }}
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-foreground">DDGS</div>
            <div className="mt-1 text-label text-muted">
              {t('settings.webSearch.ddgsHint', { version: config?.ddgsVersion ?? '—' })}
            </div>
          </div>
          <span className={`rounded-full px-2 py-1 text-label ${
            config?.ddgsInstalled
              ? 'bg-success/10 text-success'
              : 'bg-panel-2 text-muted'
          }`}>
            {config?.ddgsInstalled
              ? t('settings.webSearch.installed')
              : t('settings.webSearch.installOnUse')}
          </span>
        </div>
      </div>

      {([
        ['tavily', 'Tavily', tavilyApiKey, setTavilyApiKey, config?.hasTavilyApiKey],
        ['brave', 'Brave Search', braveApiKey, setBraveApiKey, config?.hasBraveApiKey]
      ] as const).map(([id, name, value, setValue, hasKey]) => (
        <div key={id} className="rounded-lg border border-border bg-panel p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-foreground">{name}</div>
              <div className="mt-1 text-label text-muted">
                {t(`settings.webSearch.${id}Hint`)}
              </div>
            </div>
            <span className={`rounded-full px-2 py-1 text-label ${
              hasKey ? 'bg-success/10 text-success' : 'bg-panel-2 text-muted'
            }`}>
              {hasKey
                ? t('settings.webSearch.keyConfigured')
                : t('settings.webSearch.keyMissing')}
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <Input
              aria-label={`${name} ${t('settings.webSearch.apiKey')}`}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={hasKey
                ? t('settings.webSearch.keepCurrentKey')
                : t('settings.webSearch.enterApiKey')}
              inputSize="sm"
              autoComplete="off"
            />
            {hasKey && (
              <Button
                size="small"
                disabled={busy || testing}
                onClick={() => void clearKey(id)}
              >
                {t('settings.webSearch.removeKey')}
              </Button>
            )}
          </div>
        </div>
      ))}

      <div className="rounded-lg bg-warning/10 px-3 py-2 text-label text-foreground">
        {t('settings.webSearch.privacy')}
      </div>

      {testResult && (
        <div
          role="status"
          className={`rounded-lg px-3 py-2 text-xs ${
            testResult.ok
              ? 'bg-success/10 text-success'
              : 'bg-error/10 text-error'
          }`}
        >
          {testResult.ok
            ? t('settings.webSearch.testOk', { count: testResult.resultCount })
            : testResult.error || t('settings.webSearch.testFailed')}
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-error/10 px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          size="small"
          disabled={provider === 'disabled' || busy}
          loading={testing}
          onClick={() => void test()}
        >
          {t('settings.webSearch.test')}
        </Button>
        <Button
          type="primary"
          size="small"
          loading={busy && !testing}
          disabled={testing}
          onClick={() => void save()}
        >
          {t('common.save')}
        </Button>
      </div>
    </section>
  )
}
