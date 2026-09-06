import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMarkdownViewState, resetMarkdownViewStates, type MarkdownViewState } from '../../src/renderer/hooks/useMarkdownViewState'
import { scheduleRendererSetting } from '../../src/renderer/persistence'

vi.mock('../../src/renderer/persistence', () => ({ scheduleRendererSetting: vi.fn() }))

const saved: MarkdownViewState = { mode: 'edit', preview: true, scrollTop: 240, position: { start: 12, end: 15, scrollTop: 160 } }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Markdown view restoration', () => {
  beforeEach(() => {
    resetMarkdownViewStates()
    vi.mocked(scheduleRendererSetting).mockClear()
  })
  afterEach(() => { cleanup(); resetMarkdownViewStates(); vi.restoreAllMocks() })

  it('reports ready after hydration and immediately after user interaction', async () => {
    const first = deferred<MarkdownViewState>()
    const second = deferred<MarkdownViewState>()
    vi.spyOn(window.api.settings, 'get').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(({ id }) => useMarkdownViewState(id, 'read'), { initialProps: { id: 'note.first' } })
    expect(result.current[2]).toBe(false)
    await act(async () => first.resolve(saved))
    expect(result.current[2]).toBe(true)
    rerender({ id: 'note.second' })
    expect(result.current[2]).toBe(false)
    act(() => result.current[1]({ scrollTop: 20 }))
    expect(result.current[2]).toBe(true)
    await act(async () => second.resolve(saved))
    expect(result.current[2]).toBe(true)
    expect(result.current[0].scrollTop).toBe(20)
    rerender({ id: 'note.first' })
    expect(result.current[2]).toBe(true)
  })

  it('becomes ready when settings cannot be loaded', async () => {
    vi.spyOn(window.api.settings, 'get').mockRejectedValue(new Error('Unavailable'))
    const { result } = renderHook(() => useMarkdownViewState('note.failed', 'read'))
    await waitFor(() => expect(result.current[2]).toBe(true))
    expect(result.current[0].scrollTop).toBe(0)
  })

  it('restores persisted mode, preview, reading scroll and editor selection', async () => {
    vi.spyOn(window.api.settings, 'get').mockResolvedValue(saved)
    const { result } = renderHook(() => useMarkdownViewState('note.first', 'read'))
    await waitFor(() => expect(result.current[0]).toEqual(saved))
    expect(scheduleRendererSetting).not.toHaveBeenCalled()
  })

  it('keeps new interaction when a persisted settings request finishes late', async () => {
    const load = deferred<MarkdownViewState>()
    vi.spyOn(window.api.settings, 'get').mockReturnValue(load.promise)
    const { result } = renderHook(() => useMarkdownViewState('note.first', 'read'))
    act(() => result.current[1]({ scrollTop: 80 }))
    await act(async () => load.resolve(saved))
    expect(result.current[0].scrollTop).toBe(80)
    expect(result.current[0].mode).toBe('read')
    expect(scheduleRendererSetting).toHaveBeenCalledWith('markdown.view.note.first', expect.objectContaining({ scrollTop: 80 }), { delay: 500 })
  })

  it('keeps each document state when switching keys and remounting', async () => {
    vi.spyOn(window.api.settings, 'get').mockResolvedValue(null)
    const { result, rerender, unmount } = renderHook(({ id }) => useMarkdownViewState(id, 'read'), { initialProps: { id: 'note.first' } })
    act(() => result.current[1](saved))
    rerender({ id: 'note.second' })
    expect(result.current[0]).toMatchObject({ mode: 'read', scrollTop: 0 })
    act(() => result.current[1]({ scrollTop: 99 }))
    rerender({ id: 'note.first' })
    expect(result.current[0]).toEqual(saved)
    unmount()
    const second = renderHook(() => useMarkdownViewState('note.second', 'edit'))
    expect(second.result.current[0]).toMatchObject({ mode: 'read', scrollTop: 99 })
  })

  it('loads a new key after earlier interaction and ignores the old request', async () => {
    const first = deferred<MarkdownViewState>()
    const second = deferred<MarkdownViewState>()
    vi.spyOn(window.api.settings, 'get').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(({ id }) => useMarkdownViewState(id, 'read'), { initialProps: { id: 'note.first' } })
    act(() => result.current[1]({ scrollTop: 88 }))
    rerender({ id: 'note.second' })
    await act(async () => first.resolve({ ...saved, scrollTop: 600 }))
    expect(result.current[0].scrollTop).toBe(0)
    await act(async () => second.resolve(saved))
    expect(result.current[0]).toEqual(saved)
  })

  it('clears cached positions and ignores in-flight results when libraries change', async () => {
    const oldLoad = deferred<MarkdownViewState>()
    const newLoad = deferred<MarkdownViewState>()
    vi.spyOn(window.api.settings, 'get').mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise)
    const { result } = renderHook(() => useMarkdownViewState('note.same-id', 'read'))
    act(() => result.current[1]({ scrollTop: 300 }))
    act(() => resetMarkdownViewStates())
    expect(result.current[2]).toBe(false)
    expect(result.current[0]).toMatchObject({ mode: 'read', scrollTop: 0 })
    await act(async () => oldLoad.resolve(saved))
    expect(result.current[0].scrollTop).toBe(0)
    await act(async () => newLoad.resolve({ ...saved, scrollTop: 50 }))
    expect(result.current[0].scrollTop).toBe(50)
    expect(result.current[2]).toBe(true)
  })

  it.each([
    { ...saved, scrollTop: -1 },
    { ...saved, position: { start: 4, end: 2, scrollTop: 0 } },
    { ...saved, position: { start: 0.5, end: 1, scrollTop: 0 } },
    { ...saved, position: null }
  ])('ignores invalid persisted positions %#', async (invalid) => {
    vi.spyOn(window.api.settings, 'get').mockResolvedValue(invalid)
    const { result } = renderHook(() => useMarkdownViewState('note.invalid', 'read'))
    await act(async () => { await Promise.resolve() })
    expect(result.current[0]).toMatchObject({ mode: 'read', scrollTop: 0, position: { start: 0, end: 0 } })
  })
})
