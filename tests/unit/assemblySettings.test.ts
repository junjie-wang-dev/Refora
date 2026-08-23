import { describe, expect, it, vi } from 'vitest'
import { activateAssemblySettings } from '../../src/main/services/assemblySettings'
import type { ServerAssembly } from '../../src/main/sidecar/assembly'

function assembly(bootstrap: unknown, settings: Record<string, unknown>): ServerAssembly {
  return {
    getClient: () => ({
      http: {
        appBootstrap: vi.fn().mockResolvedValue(bootstrap),
        settingsGet: vi.fn().mockResolvedValue(settings)
      }
    }),
    addNativeManagedRoot: vi.fn()
  } as unknown as ServerAssembly
}

describe('assembly settings activation', () => {
  it('applies the active library proxy and normalized appearance settings', async () => {
    const setProxy = vi.fn().mockResolvedValue(undefined)
    const setLanguage = vi.fn()
    const setTheme = vi.fn()

    const activeAssembly = assembly({
      language: 'zh',
      theme: 'dark',
      windowBounds: null,
      listColumnState: null,
      sidebarCollapsed: false,
      firstRun: false,
      libraryFolderPath: '/library'
    }, { proxyUrl: '  socks5://localhost:1080  ' })
    const result = await activateAssemblySettings({
      assembly: activeAssembly,
      setProxy,
      setLanguage,
      setTheme
    })

    expect(setProxy).toHaveBeenCalledWith('socks5://localhost:1080')
    expect(setLanguage).toHaveBeenCalledWith('zh')
    expect(setTheme).toHaveBeenCalledWith('dark')
    expect(activeAssembly.addNativeManagedRoot).toHaveBeenCalledWith('/library')
    expect(result.libraryFolderPath).toBe('/library')
  })

  it('uses safe defaults for malformed persisted settings', async () => {
    const setProxy = vi.fn().mockResolvedValue(undefined)
    const setLanguage = vi.fn()
    const setTheme = vi.fn()

    const result = await activateAssemblySettings({
      assembly: assembly(
        { language: 'invalid', theme: 'invalid' },
        { proxyUrl: 'http://user:password@proxy.example:8080' }
      ),
      setProxy,
      setLanguage,
      setTheme
    })

    expect(setProxy).toHaveBeenCalledWith('')
    expect(setLanguage).toHaveBeenCalledWith('en')
    expect(setTheme).toHaveBeenCalledWith('system')
    expect(result.windowBounds).toBeNull()
  })
})
