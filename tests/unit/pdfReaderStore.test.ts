import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document, PdfAnnotation } from '../../src/shared/ipc-types'
import { api } from '../../src/renderer/ipc'
import { usePdfReaderStore } from '../../src/renderer/store/pdfReaderStore'
import { useWorkspaceStore } from '../../src/renderer/store/workspaceStore'
import { openDocumentPdf } from '../../src/renderer/utils/openPdf'

function document(id: string): Document {
  return {
    id,
    filePath: `/tmp/${id}.pdf`,
    originalFolderPath: '/tmp',
    fileName: `${id}.pdf`,
    fileSize: 1024,
    fileHash: id,
    title: `Paper ${id}`,
    authors: null,
    year: null,
    venue: null,
    volume: null,
    issue: null,
    pages: null,
    abstract: null,
    keywords: null,
    url: null,
    doi: null,
    arxivId: null,
    note: null,
    affiliations: null,
    starred: 0,
    addedAt: 1,
    lastReadAt: 2,
    updatedAt: 3,
    metadataSource: null,
    metadataStatus: 'done',
    metadataAttempts: 0,
    editedFields: [],
    remoteValues: null,
    fileMissing: 0
  }
}

describe('PDF reader state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePdfReaderStore.getState().resetForLibrarySwitch()
    usePdfReaderStore.setState({
      tabs: [],
      activeDocumentId: null,
      annotations: {},
      loadStatus: {},
      saveStatus: {},
      tool: null,
      color: '#f2c94c',
      fontSize: 14,
      strokeWidth: 2,
      sidebarOpen: false,
      selectedAnnotationId: null,
      selectedAnnotationIds: [],
      pendingCommentFocusId: null,
      lastDeletion: null
    })
    useWorkspaceStore.setState({
      activeWorkspaceId: 'workspace-one',
      panelOpen: false,
      panelView: 'workspace',
      fullscreen: true
    })
    vi.spyOn(api.settings, 'get').mockImplementation(async (_key, fallback) => fallback)
    vi.spyOn(api.settings, 'set').mockResolvedValue(undefined)
    vi.spyOn(api.documents, 'openPdf').mockImplementation(async (id) => document(id))
    vi.spyOn(api.documents, 'pdfAnnotations').mockResolvedValue([])
    vi.spyOn(api.documents, 'setPdfAnnotations').mockImplementation(
      async (_id, annotations) => annotations
    )
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps multiple documents in tabs and activates an existing tab without duplicating it', async () => {
    await usePdfReaderStore.getState().open(document('one'))
    await usePdfReaderStore.getState().open(document('two'))
    await usePdfReaderStore.getState().open(document('one'))

    expect(usePdfReaderStore.getState().tabs.map((tab) => tab.id)).toEqual(['one', 'two'])
    expect(usePdfReaderStore.getState().activeDocumentId).toBe('one')

    usePdfReaderStore.getState().close('one')
    expect(usePdfReaderStore.getState().activeDocumentId).toBe('two')
  })

  it('clears loaded annotation caches when a tab closes and reloads them when reopened', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    expect(usePdfReaderStore.getState().annotations).toHaveProperty('paper')

    usePdfReaderStore.getState().close('paper')

    expect(usePdfReaderStore.getState().annotations).not.toHaveProperty('paper')
    expect(usePdfReaderStore.getState().loadStatus).not.toHaveProperty('paper')
    expect(usePdfReaderStore.getState().saveStatus).not.toHaveProperty('paper')

    await usePdfReaderStore.getState().open(document('paper'))
    expect(api.documents.pdfAnnotations).toHaveBeenCalledTimes(2)
  })

  it('flushes pending annotations before releasing a closed tab cache', async () => {
    let resolveSave: (annotations: PdfAnnotation[]) => void = () => undefined
    vi.mocked(api.documents.setPdfAnnotations).mockImplementationOnce(
      () => new Promise<PdfAnnotation[]>((resolve) => {
        resolveSave = resolve
      })
    )
    await usePdfReaderStore.getState().open(document('paper'))
    usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'ink',
      page: 1,
      color: '#56ccf2',
      text: '',
      comment: '',
      points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
      strokeWidth: 2
    })

    usePdfReaderStore.getState().close('paper')

    expect(api.documents.setPdfAnnotations).toHaveBeenCalledWith(
      'paper',
      [expect.objectContaining({ kind: 'ink' })]
    )
    expect(usePdfReaderStore.getState().annotations).toHaveProperty('paper')

    resolveSave([])
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(usePdfReaderStore.getState().annotations).not.toHaveProperty('paper')
  })

  it('clears every loaded annotation cache when all tabs close', async () => {
    await usePdfReaderStore.getState().open(document('one'))
    await usePdfReaderStore.getState().open(document('two'))

    usePdfReaderStore.getState().closeAll()

    expect(usePdfReaderStore.getState().annotations).toEqual({})
    expect(usePdfReaderStore.getState().loadStatus).toEqual({})
    expect(usePdfReaderStore.getState().saveStatus).toEqual({})
  })

  it('keeps the annotations sidebar closed until the user toggles it', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    expect(usePdfReaderStore.getState().sidebarOpen).toBe(false)

    const annotation = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'note',
      page: 1,
      color: '#f2c94c',
      text: '',
      comment: '',
      point: { x: 0.5, y: 0.5 }
    })
    expect(usePdfReaderStore.getState().sidebarOpen).toBe(false)

    usePdfReaderStore.getState().removeAnnotation('paper', annotation.id)
    usePdfReaderStore.getState().undoLastDeletion()
    expect(usePdfReaderStore.getState().sidebarOpen).toBe(false)

    usePdfReaderStore.getState().toggleSidebar()
    expect(usePdfReaderStore.getState().sidebarOpen).toBe(true)
  })

  it('persists rich annotation geometry and comments in local settings', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    const annotation = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'highlight',
      page: 2,
      color: '#f2c94c',
      text: 'Selected text',
      comment: '',
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }]
    })
    usePdfReaderStore.getState().updateAnnotation('paper', annotation.id, {
      comment: 'Important result'
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(api.documents.setPdfAnnotations).toHaveBeenLastCalledWith(
      'paper',
      [expect.objectContaining({
        id: annotation.id,
        kind: 'highlight',
        page: 2,
        comment: 'Important result'
      })]
    )
  })

  it('loads and updates inline text annotations', async () => {
    vi.mocked(api.documents.pdfAnnotations).mockResolvedValueOnce([{
      id: 'text-annotation',
      kind: 'text',
      page: 1,
      color: '#56ccf2',
      text: 'Initial text',
      comment: '',
      createdAt: 10,
      point: { x: 0.2, y: 0.3 },
      fontSize: 14
    }])

    await usePdfReaderStore.getState().open(document('paper'))
    expect(usePdfReaderStore.getState().annotations.paper).toEqual([
      expect.objectContaining({
        id: 'text-annotation',
        kind: 'text',
        text: 'Initial text'
      })
    ])

    usePdfReaderStore.getState().updateAnnotation('paper', 'text-annotation', {
      text: 'Updated on the PDF'
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(api.documents.setPdfAnnotations).toHaveBeenLastCalledWith(
      'paper',
      [expect.objectContaining({
        id: 'text-annotation',
        kind: 'text',
        text: 'Updated on the PDF'
      })]
    )
  })

  it('updates annotation sizes and removes a multi-selection together', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    const text = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'text',
      page: 1,
      color: '#56ccf2',
      text: 'Text',
      comment: '',
      point: { x: 0.2, y: 0.3 },
      fontSize: 14
    })
    const ink = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'ink',
      page: 1,
      color: '#56ccf2',
      text: '',
      comment: '',
      points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
      strokeWidth: 2
    })

    usePdfReaderStore.getState().setFontSize(20)
    usePdfReaderStore.getState().setStrokeWidth(5)
    usePdfReaderStore.getState().updateAnnotation('paper', text.id, { fontSize: 20 })
    usePdfReaderStore.getState().updateAnnotation('paper', ink.id, { strokeWidth: 5 })
    usePdfReaderStore.getState().selectAnnotations([text.id, ink.id])

    expect(usePdfReaderStore.getState()).toMatchObject({
      fontSize: 20,
      strokeWidth: 5,
      selectedAnnotationIds: [text.id, ink.id]
    })
    expect(usePdfReaderStore.getState().annotations.paper).toEqual([
      expect.objectContaining({ id: text.id, fontSize: 20 }),
      expect.objectContaining({ id: ink.id, strokeWidth: 5 })
    ])

    usePdfReaderStore.getState().removeAnnotations('paper', [text.id, ink.id])
    await vi.advanceTimersByTimeAsync(300)

    expect(usePdfReaderStore.getState().annotations.paper).toEqual([])
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual([])
    expect(api.documents.setPdfAnnotations).toHaveBeenLastCalledWith('paper', [])
  })

  it('keeps new annotations unselected until the default pointer chooses them', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    usePdfReaderStore.getState().setTool('ink')
    const annotation = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'ink',
      page: 1,
      color: '#56ccf2',
      text: '',
      comment: '',
      points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
      strokeWidth: 2
    })

    expect(usePdfReaderStore.getState()).toMatchObject({
      tool: 'ink',
      selectedAnnotationId: null,
      selectedAnnotationIds: []
    })

    usePdfReaderStore.getState().setTool(null)
    usePdfReaderStore.getState().selectAnnotation(annotation.id)
    expect(usePdfReaderStore.getState().selectedAnnotationIds).toEqual([annotation.id])
  })

  it('focuses new notes and restores deleted annotations in their original order', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    const first = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'highlight',
      page: 1,
      color: '#f2c94c',
      text: 'First',
      comment: '',
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.04 }]
    })
    const note = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'note',
      page: 1,
      color: '#6fcf97',
      text: '',
      comment: '',
      point: { x: 0.5, y: 0.5 }
    })

    expect(usePdfReaderStore.getState()).toMatchObject({
      pendingCommentFocusId: note.id,
      selectedAnnotationIds: []
    })

    usePdfReaderStore.getState().removeAnnotations('paper', [first.id, note.id])
    expect(usePdfReaderStore.getState().annotations.paper).toEqual([])

    usePdfReaderStore.getState().undoLastDeletion()
    expect(usePdfReaderStore.getState()).toMatchObject({
      tool: null,
      selectedAnnotationIds: [first.id, note.id],
      lastDeletion: null
    })
    expect(usePdfReaderStore.getState().annotations.paper.map((item) => item.id))
      .toEqual([first.id, note.id])
  })

  it('exposes annotation persistence failures', async () => {
    vi.mocked(api.documents.setPdfAnnotations).mockRejectedValueOnce(new Error('disk full'))
    await usePdfReaderStore.getState().open(document('paper'))
    usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'note',
      page: 1,
      color: '#f2c94c',
      text: '',
      comment: 'Important',
      point: { x: 0.5, y: 0.5 }
    })

    expect(usePdfReaderStore.getState().saveStatus.paper).toBe('saving')
    await vi.advanceTimersByTimeAsync(300)
    expect(usePdfReaderStore.getState().saveStatus.paper).toBe('error')

    usePdfReaderStore.getState().retrySave('paper')
    expect(usePdfReaderStore.getState().saveStatus.paper).toBe('saving')
    await vi.advanceTimersByTimeAsync(300)
    expect(usePdfReaderStore.getState().saveStatus.paper).toBe('saved')
  })

  it('keeps a failed annotation load separate from save state and retries the read', async () => {
    const savedAnnotation = {
      id: 'saved-note',
      kind: 'note' as const,
      page: 1,
      color: '#f2c94c',
      text: '',
      comment: 'Already saved',
      createdAt: 10,
      point: { x: 0.5, y: 0.5 }
    }
    vi.mocked(api.documents.pdfAnnotations)
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce([savedAnnotation])

    await usePdfReaderStore.getState().open(document('paper'))

    expect(Object.hasOwn(usePdfReaderStore.getState().annotations, 'paper')).toBe(false)
    expect(usePdfReaderStore.getState().loadStatus.paper).toBe('error')
    expect(usePdfReaderStore.getState().saveStatus.paper).toBeUndefined()

    usePdfReaderStore.getState().retrySave('paper')
    await vi.advanceTimersByTimeAsync(300)
    expect(api.documents.setPdfAnnotations).not.toHaveBeenCalled()

    await usePdfReaderStore.getState().retryLoad('paper')

    expect(usePdfReaderStore.getState().loadStatus.paper).toBe('loaded')
    expect(usePdfReaderStore.getState().annotations.paper).toEqual([savedAnnotation])
  })

  it('serializes full annotation snapshots so an older save cannot finish last', async () => {
    let resolveFirst: () => void = () => undefined
    let resolveSecond: () => void = () => undefined
    vi.mocked(api.documents.setPdfAnnotations)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = () => resolve([]) }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecond = () => resolve([]) }))
    await usePdfReaderStore.getState().open(document('paper'))
    const annotation = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'note',
      page: 1,
      color: '#f2c94c',
      text: '',
      comment: 'First',
      point: { x: 0.5, y: 0.5 }
    })
    expect(annotation).not.toBeNull()

    await vi.advanceTimersByTimeAsync(300)
    usePdfReaderStore.getState().updateAnnotation('paper', annotation!.id, {
      comment: 'Second'
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(api.documents.setPdfAnnotations).toHaveBeenCalledTimes(1)
    expect(api.documents.setPdfAnnotations).toHaveBeenNthCalledWith(
      1,
      'paper',
      [expect.objectContaining({ comment: 'First' })]
    )

    resolveFirst()
    await vi.waitFor(() => expect(api.documents.setPdfAnnotations).toHaveBeenCalledTimes(2))
    expect(api.documents.setPdfAnnotations).toHaveBeenNthCalledWith(
      2,
      'paper',
      [expect.objectContaining({ comment: 'Second' })]
    )
    resolveSecond()
    await usePdfReaderStore.getState().flushPendingSaves()
    expect(usePdfReaderStore.getState().saveStatus.paper).toBe('saved')
  })

  it('discards a queued snapshot when the library resets during an active save', async () => {
    let resolveFirst: () => void = () => undefined
    vi.mocked(api.documents.setPdfAnnotations).mockReturnValueOnce(
      new Promise((resolve) => { resolveFirst = () => resolve([]) })
    )
    await usePdfReaderStore.getState().open(document('paper'))
    const annotation = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'note',
      page: 1,
      color: '#f2c94c',
      text: '',
      comment: 'First',
      point: { x: 0.5, y: 0.5 }
    })
    await vi.advanceTimersByTimeAsync(300)
    usePdfReaderStore.getState().updateAnnotation('paper', annotation!.id, {
      comment: 'Queued for the old library'
    })
    await vi.advanceTimersByTimeAsync(300)

    usePdfReaderStore.getState().resetForLibrarySwitch()
    resolveFirst()
    await Promise.resolve()
    await Promise.resolve()

    expect(api.documents.setPdfAnnotations).toHaveBeenCalledTimes(1)
    expect(usePdfReaderStore.getState()).toMatchObject({
      annotations: {},
      loadStatus: {},
      saveStatus: {}
    })
  })

  it('flushes pending annotations before a library switch and clears reader state afterward', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'note',
      page: 1,
      color: '#f2c94c',
      text: '',
      comment: 'Pending note',
      point: { x: 0.5, y: 0.5 }
    })

    await usePdfReaderStore.getState().prepareForLibrarySwitch()

    expect(api.documents.setPdfAnnotations).toHaveBeenCalledTimes(1)
    expect(api.documents.setPdfAnnotations).toHaveBeenCalledWith(
      'paper',
      [expect.objectContaining({ comment: 'Pending note' })]
    )

    usePdfReaderStore.getState().resetForLibrarySwitch()
    await vi.advanceTimersByTimeAsync(300)

    expect(api.documents.setPdfAnnotations).toHaveBeenCalledTimes(1)
    expect(usePdfReaderStore.getState()).toMatchObject({
      tabs: [],
      activeDocumentId: null,
      annotations: {},
      saveStatus: {},
      tool: null,
      sidebarOpen: false,
      selectedAnnotationIds: [],
      lastDeletion: null
    })
  })

  it('flushes pending annotations immediately and exposes a failed flush', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'note',
      page: 1,
      color: '#f2c94c',
      text: '',
      comment: 'Pending note',
      point: { x: 0.5, y: 0.5 }
    })
    vi.mocked(api.documents.setPdfAnnotations).mockRejectedValueOnce(new Error('disk full'))

    await expect(usePdfReaderStore.getState().flushPendingSaves()).rejects.toThrow('disk full')
    expect(usePdfReaderStore.getState().saveStatus.paper).toBe('error')

    await usePdfReaderStore.getState().flushPendingSaves()
    expect(usePdfReaderStore.getState().saveStatus.paper).toBe('saved')
    expect(api.documents.setPdfAnnotations).toHaveBeenCalledTimes(2)
  })

  it('ignores annotation loads that finish after a library switch', async () => {
    let resolveAnnotations: (annotations: []) => void = () => undefined
    vi.mocked(api.documents.pdfAnnotations).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAnnotations = resolve
      })
    )

    const opening = usePdfReaderStore.getState().open(document('paper'))
    usePdfReaderStore.getState().resetForLibrarySwitch()
    resolveAnnotations([])
    await opening

    expect(usePdfReaderStore.getState()).toMatchObject({
      tabs: [],
      activeDocumentId: null,
      annotations: {},
      loadStatus: {},
      saveStatus: {}
    })
  })

  it('updates a text annotation color', async () => {
    await usePdfReaderStore.getState().open(document('paper'))
    const annotation = usePdfReaderStore.getState().addAnnotation('paper', {
      kind: 'text',
      page: 1,
      color: '#f2c94c',
      text: 'Text',
      comment: '',
      point: { x: 0.2, y: 0.3 },
      fontSize: 14
    })

    usePdfReaderStore.getState().setColor('#eb5757')
    usePdfReaderStore.getState().updateAnnotation('paper', annotation.id, {
      color: '#eb5757'
    })

    expect(usePdfReaderStore.getState()).toMatchObject({
      color: '#eb5757',
      annotations: {
        paper: [expect.objectContaining({
          id: annotation.id,
          color: '#eb5757'
        })]
      }
    })
  })

  it('uses the system app by default and opens a local tab in built-in mode', async () => {
    await openDocumentPdf('system-paper')
    expect(api.documents.openPdf).toHaveBeenCalledWith('system-paper')
    expect(usePdfReaderStore.getState().tabs).toHaveLength(0)

    vi.mocked(api.settings.get).mockResolvedValueOnce('builtin')
    await openDocumentPdf('built-in-paper')

    expect(api.documents.openPdf).toHaveBeenLastCalledWith('built-in-paper', false)
    expect(usePdfReaderStore.getState().activeDocumentId).toBe('built-in-paper')
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: 'workspace-one',
      panelOpen: true,
      panelView: 'pdf',
      fullscreen: false
    })
  })
})
