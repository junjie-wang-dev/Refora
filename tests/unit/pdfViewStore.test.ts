import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/renderer/ipc'
import { flushRendererSettingWrites, invalidateRendererSettingWrites } from '../../src/renderer/persistence'
import { DEFAULT_PDF_VIEW, usePdfViewStore } from '../../src/renderer/store/pdfViewStore'

describe('PDF reading state and bookmarks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invalidateRendererSettingWrites()
    usePdfViewStore.getState().reset()
    vi.spyOn(api.settings, 'get').mockImplementation(async (_key, fallback) => fallback)
    vi.spyOn(api.settings, 'set').mockResolvedValue(undefined)
  })

  afterEach(() => {
    invalidateRendererSettingWrites()
    usePdfViewStore.getState().reset()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps each document position and zoom mode independently and restores persisted values', async () => {
    const store = usePdfViewStore.getState()
    await store.load('first')
    await store.load('second')
    const view = { ...DEFAULT_PDF_VIEW, page: 23, x: 0.3, y: 0.7, rotation: 90, zoomMode: 'width' as const }
    store.updateView('first', view)
    expect(usePdfViewStore.getState().documents.second.view).toEqual(DEFAULT_PDF_VIEW)
    await flushRendererSettingWrites()
    expect(api.settings.set).toHaveBeenCalledWith('pdfReader.document.first', { view, bookmarks: [] })
    store.reset()
    vi.mocked(api.settings.get).mockResolvedValue({ view, bookmarks: [] })
    expect((await store.load('first')).view).toEqual(view)
  })

  it('persists bookmark creation, renaming and removal without losing the reading position', async () => {
    const store = usePdfViewStore.getState()
    await store.load('paper')
    const view = { ...DEFAULT_PDF_VIEW, page: 4, y: 0.4 }
    store.updateView('paper', view)
    store.addBookmark('paper', view, 'Experiment')
    const bookmark = usePdfViewStore.getState().documents.paper.bookmarks[0]
    store.renameBookmark('paper', bookmark.id, 'Main experiment')
    await flushRendererSettingWrites()
    expect(api.settings.set).toHaveBeenLastCalledWith('pdfReader.document.paper', {
      view, bookmarks: [{ id: bookmark.id, title: 'Main experiment', page: 4, x: 0, y: 0.4 }]
    })
    store.removeBookmark('paper', bookmark.id)
    await flushRendererSettingWrites()
    expect(api.settings.set).toHaveBeenLastCalledWith('pdfReader.document.paper', { view, bookmarks: [] })
  })

  it('reports a failed save, retains data, and retries the newest snapshot', async () => {
    const store = usePdfViewStore.getState()
    await store.load('paper')
    vi.mocked(api.settings.set).mockRejectedValueOnce(new Error('disk full'))
    store.addBookmark('paper', DEFAULT_PDF_VIEW, 'Keep this')
    await vi.advanceTimersByTimeAsync(400)
    expect(usePdfViewStore.getState().saveStatus.paper).toBe('error')
    expect(usePdfViewStore.getState().documents.paper.bookmarks).toHaveLength(1)
    store.retrySave('paper')
    await flushRendererSettingWrites()
    expect(usePdfViewStore.getState().saveStatus.paper).toBe('saved')
  })

  it('does not overwrite unread bookmarks when loading fails', async () => {
    const store = usePdfViewStore.getState()
    vi.mocked(api.settings.get).mockRejectedValueOnce(new Error('read failed'))
    await expect(store.load('paper')).rejects.toThrow('read failed')
    store.updateView('paper', { ...DEFAULT_PDF_VIEW, page: 10 })
    store.addBookmark('paper', DEFAULT_PDF_VIEW, 'New')
    await vi.advanceTimersByTimeAsync(500)
    expect(api.settings.set).not.toHaveBeenCalled()
    expect(usePdfViewStore.getState().loadStatus.paper).toBe('error')
    await store.load('paper')
    expect(usePdfViewStore.getState().loadStatus.paper).toBe('loaded')
  })

  it('ignores a reading-state load that finishes after switching libraries', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(api.settings.get).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const task = usePdfViewStore.getState().load('paper')
    usePdfViewStore.getState().reset()
    resolve({ view: { ...DEFAULT_PDF_VIEW, page: 99 }, bookmarks: [] })
    await task
    expect(usePdfViewStore.getState().documents).toEqual({})
    expect(usePdfViewStore.getState().loadStatus).toEqual({})
  })

  it('normalizes invalid saved state and ignores duplicate or malformed bookmarks', async () => {
    vi.mocked(api.settings.get).mockResolvedValue({
      view: { page: -5, x: Infinity, y: NaN, scale: 999, rotation: -90, zoomMode: 'bad' },
      bookmarks: [null, { id: 'one', title: 'Valid', page: 2, x: 0, y: 0.5 }, { id: 'one', title: 'Duplicate' }, {}]
    })
    const saved = await usePdfViewStore.getState().load('paper')
    expect(saved.view).toEqual({ page: 1, x: 0, y: 0, scale: 5, rotation: 270, zoomMode: 'custom' })
    expect(saved.bookmarks).toEqual([{ id: 'one', title: 'Valid', page: 2, x: 0, y: 0.5 }])
  })

  it('coalesces scroll updates and does not write an unchanged view', async () => {
    const store = usePdfViewStore.getState()
    await store.load('paper')
    store.updateView('paper', DEFAULT_PDF_VIEW)
    await vi.advanceTimersByTimeAsync(400)
    expect(api.settings.set).not.toHaveBeenCalled()
    store.updateView('paper', { ...DEFAULT_PDF_VIEW, y: 0.2 })
    store.updateView('paper', { ...DEFAULT_PDF_VIEW, y: 0.3 })
    await vi.advanceTimersByTimeAsync(400)
    expect(api.settings.set).toHaveBeenCalledTimes(1)
    expect(api.settings.set).toHaveBeenLastCalledWith('pdfReader.document.paper', {
      view: { ...DEFAULT_PDF_VIEW, y: 0.3 }, bookmarks: []
    })
  })
})
