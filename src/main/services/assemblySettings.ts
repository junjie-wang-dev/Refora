import type { BootstrapData } from '../../shared/ipc-types'
import { normalizeBootstrapData } from '../../shared/bootstrap'
import { proxyRulesForRuntime } from '../../shared/proxy'
import type { ServerAssembly } from '../sidecar/assembly'

interface AssemblySettingsDeps {
  assembly: ServerAssembly
  setProxy: (proxyRules: string) => Promise<void>
  setLanguage: (language: 'zh' | 'en') => void
  setTheme: (theme: BootstrapData['theme']) => void
}

export async function activateAssemblySettings(
  deps: AssemblySettingsDeps
): Promise<BootstrapData> {
  const client = deps.assembly.getClient()
  const [bootstrapValue, settings] = await Promise.all([
    client.http.appBootstrap(),
    client.http.settingsGet()
  ])
  const bootstrap = normalizeBootstrapData(bootstrapValue)
  await deps.setProxy(proxyRulesForRuntime(settings['proxyUrl']))
  deps.setLanguage(bootstrap.language)
  deps.setTheme(bootstrap.theme)
  return bootstrap
}
