import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarkdownDraft } from '../../src/renderer/hooks/useMarkdownDraft'
import { flushRendererSettingWrites, invalidateRendererSettingWrites } from '../../src/renderer/persistence'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const defaults = {
  kind: 'note', id: 'note-draft-test', title: 'Original', contentMd: 'Original body',
  editable: true, autoSave: false,
  messages: {
    saveFailed: 'Save failed', titleRequired: 'Title required',
    externalConflict: 'External conflict', recoveryFailed: 'Recovery failed'
  }
}

beforeEach(() => {
  vi.spyOn(window.api.settings, 'get').mockResolvedValue(null)
  vi.spyOn(window.api.settings, 'set').mockResolvedValue()
})

afterEach(() => {
  cleanup()
  invalidateRendererSettingWrites()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function ready() {
  await act(async () => { await Promise.resolve() })
}

describe('useMarkdownDraft', () => {
  it('retains dirty input after optimistic feedback is rolled back on failure', async () => {
    const pending = deferred<boolean>()
    const onUpdate = vi.fn(() => pending.promise)
    const { result, rerender } = renderHook((props) => useMarkdownDraft({ ...defaults, ...props, onUpdate }), {
      initialProps: { contentMd: 'Original body' }
    })
    await ready()
    act(() => result.current.setDraftContent('Unsaved writing'))
    let saving!: Promise<boolean>
    act(() => { saving = result.current.flush() })
    await ready()
    rerender({ contentMd: 'Unsaved writing' })
    expect(result.current.savedDraft.contentMd).toBe('Original body')
    rerender({ contentMd: 'Original body' })
    await act(async () => { pending.resolve(false); await saving })
    expect(result.current.draftContent).toBe('Unsaved writing')
    expect(result.current.isDirty).toBe(true)
    expect(result.current.saveError).toBe('Save failed')
    expect(result.current.externalConflict).toBe(false)
  })

  it('flushes typing that arrives while close is waiting for an earlier save', async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    const onUpdate = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useMarkdownDraft({ ...defaults, onUpdate }))
    await ready()
    act(() => result.current.setDraftContent('Version A'))
    let close!: Promise<boolean>
    act(() => { close = result.current.requestClose() })
    await ready()
    act(() => result.current.setDraftContent('Version B'))
    let closed = false
    void close.then(() => { closed = true })
    await act(async () => { first.resolve(true); await Promise.resolve() })
    expect(closed).toBe(false)
    expect(onUpdate).toHaveBeenLastCalledWith(defaults.id, { title: 'Original', contentMd: 'Version B' })
    await act(async () => { second.resolve(true); expect(await close).toBe(true) })
    expect(result.current.savedDraft.contentMd).toBe('Version B')
    expect(result.current.isDirty).toBe(false)
  })

  it('stops pending newer saves when an external conflict appears', async () => {
    const first = deferred<boolean>()
    const onUpdate = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true)
    const { result, rerender } = renderHook((props) => useMarkdownDraft({ ...defaults, ...props, onUpdate }), {
      initialProps: { contentMd: 'Original body' }
    })
    await ready()
    act(() => result.current.setDraftContent('Version A'))
    let firstSave!: Promise<boolean>
    act(() => { firstSave = result.current.flush() })
    await ready()
    act(() => result.current.setDraftContent('Version B'))
    let secondSave!: Promise<boolean>
    act(() => { secondSave = result.current.flush() })
    rerender({ contentMd: 'External version' })
    await act(async () => {
      first.resolve(true)
      expect(await firstSave).toBe(false)
      expect(await secondSave).toBe(false)
    })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(result.current.draftContent).toBe('Version B')
    expect(result.current.latestExternalDraft?.contentMd).toBe('External version')
    await act(async () => { expect(await result.current.keepLocalDraft()).toBe(true) })
    expect(onUpdate).toHaveBeenLastCalledWith(defaults.id, { title: 'Original', contentMd: 'Version B' })
    expect(result.current.history.some((entry) => entry.contentMd === 'External version')).toBe(true)
  })

  it('preserves a local conflict version when reloading and allows restoring it', async () => {
    const onUpdate = vi.fn().mockResolvedValue(true)
    const { result, rerender } = renderHook((props) => useMarkdownDraft({ ...defaults, ...props, onUpdate }), {
      initialProps: { contentMd: 'Original body' }
    })
    await ready()
    act(() => result.current.setDraftContent('Local writing'))
    rerender({ contentMd: 'External writing' })
    act(() => result.current.reloadExternalDraft())
    expect(result.current.draftContent).toBe('External writing')
    expect(result.current.externalConflict).toBe(false)
    const local = result.current.history.find((entry) => entry.contentMd === 'Local writing')!
    expect(local.reason).toBe('conflict')
    act(() => result.current.restoreVersion(local.id))
    expect(result.current.draftContent).toBe('Local writing')
    expect(result.current.isDirty).toBe(true)
    await act(async () => { await flushRendererSettingWrites() })
    expect(window.api.settings.set).toHaveBeenLastCalledWith('markdown.document.note.note-draft-test', expect.objectContaining({
      draft: { title: 'Original', contentMd: 'Local writing' }
    }))
  })

  it('recovers a pending local draft after reopening without overwriting a newer external version', async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue({
      draft: { title: 'Local', contentMd: 'Recovered writing' },
      base: { title: 'Original', contentMd: 'Earlier body' }, history: []
    })
    const onUpdate = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useMarkdownDraft({ ...defaults, onUpdate }))
    await ready()
    expect(result.current.draftContent).toBe('Recovered writing')
    expect(result.current.recoveredDraft).toBe(true)
    expect(result.current.externalConflict).toBe(true)
    await act(async () => { expect(await result.current.flush()).toBe(false) })
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('keeps input made before asynchronous recovery completes and exposes the recovered version in history', async () => {
    const recovery = deferred<unknown>()
    vi.mocked(window.api.settings.get).mockImplementation(() => recovery.promise as Promise<never>)
    const { result } = renderHook(() => useMarkdownDraft({ ...defaults, onUpdate: vi.fn() }))
    act(() => result.current.setDraftContent('Just typed'))
    await act(async () => {
      recovery.resolve({
        draft: { title: 'Old local', contentMd: 'Previously unsaved' },
        base: { title: 'Original', contentMd: 'Original body' }, history: []
      })
      await recovery.promise
    })
    expect(result.current.draftContent).toBe('Just typed')
    expect(result.current.history.some((entry) => entry.contentMd === 'Previously unsaved')).toBe(true)
  })

  it('retries a failed save and records the previous confirmed version', async () => {
    const onUpdate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { result } = renderHook(() => useMarkdownDraft({ ...defaults, onUpdate }))
    await ready()
    act(() => result.current.setDraftContent('New body'))
    await act(async () => { expect(await result.current.flush()).toBe(false) })
    expect(result.current.status).toBe('error')
    await act(async () => { expect(await result.current.retry()).toBe(true) })
    expect(result.current.status).toBe('saved')
    expect(result.current.history[0].contentMd).toBe('Original body')
  })

  it('autosaves after idle and keeps saved history bounded', async () => {
    vi.useFakeTimers()
    const onUpdate = vi.fn().mockResolvedValue(true)
    const { result } = renderHook(() => useMarkdownDraft({ ...defaults, autoSave: true, onUpdate }))
    await ready()
    act(() => result.current.setDraftContent('Autosaved'))
    await act(async () => { await vi.advanceTimersByTimeAsync(799) })
    expect(onUpdate).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 24; index += 1) {
      act(() => { result.current.setDraftContent(String(index)); result.current.backupDraft() })
    }
    expect(result.current.history).toHaveLength(20)
  })
})
