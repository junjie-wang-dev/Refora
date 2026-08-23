import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/renderer/ipc'
import {
  flushRendererSettingWrites,
  invalidateRendererSettingWrites,
  scheduleRendererSetting
} from '../../src/renderer/persistence'

describe('renderer setting persistence', () => {
  beforeEach(() => {
    invalidateRendererSettingWrites()
    vi.useFakeTimers()
    vi.spyOn(api.settings, 'set').mockResolvedValue(undefined)
  })

  afterEach(() => {
    invalidateRendererSettingWrites()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('coalesces rapid writes for the same setting key', async () => {
    scheduleRendererSetting('workspaceWidth', 640, { delay: 500 })
    scheduleRendererSetting('workspaceWidth', 720, { delay: 500 })

    await vi.advanceTimersByTimeAsync(500)

    expect(api.settings.set).toHaveBeenCalledOnce()
    expect(api.settings.set).toHaveBeenCalledWith('workspaceWidth', 720)
  })

  it('flushes a delayed write before shutdown', async () => {
    scheduleRendererSetting('theme', 'dark', { delay: 500 })

    await flushRendererSettingWrites()

    expect(api.settings.set).toHaveBeenCalledWith('theme', 'dark')
  })

  it('drops delayed writes when the library generation changes', async () => {
    scheduleRendererSetting('listColumnState', { columns: [] }, { delay: 500 })
    invalidateRendererSettingWrites()

    await vi.advanceTimersByTimeAsync(500)

    expect(api.settings.set).not.toHaveBeenCalled()
  })
})
