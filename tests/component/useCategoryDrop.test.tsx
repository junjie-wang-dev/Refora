import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { api } = vi.hoisted(() => ({
  api: {
    categories: { assign: vi.fn() },
    documents: { bulkCategorize: vi.fn() },
    import: { addFiles: vi.fn() },
    getPathForFile: vi.fn()
  }
}))

vi.mock('../../src/renderer/ipc', () => ({ api }))

import { useCategoryDrop } from '../../src/renderer/hooks/useCategoryDrop'
import { useDocumentStore } from '../../src/renderer/store/documentStore'

function makeDataTransfer(data: Record<string, string>, files: File[] = []): React.DragEvent {
  const fileLike = files as unknown
  const evt = {
    dataTransfer: {
      types: Object.keys(data).concat(files.length ? ['Files'] : []),
      getData: (mime: string) => data[mime] ?? '',
      files: { length: files.length, item: (i: number) => files[i], 0: files[0] }
    },
    preventDefault: vi.fn()
  } as unknown as React.DragEvent
  void fileLike
  return evt
}

beforeEach(() => {
  api.categories.assign.mockReset()
  api.documents.bulkCategorize.mockReset()
  api.import.addFiles.mockReset()
  api.getPathForFile.mockReset()
  useDocumentStore.setState({
    categories: [{ id: 'cat1', name: 'Cat', count: 0 } as never],
    documents: [],
    selectedIds: [],
    focusedDocId: null
  })
  vi.spyOn(useDocumentStore.getState(), 'showToast').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useCategoryDrop', () => {
  let fetchCategories: ReturnType<typeof vi.fn>
  let fetchDocuments: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchCategories = vi.fn()
    fetchDocuments = vi.fn()
  })

  it('handleDragOver prevents default when DOC_MIME present', () => {
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const evt = {
      dataTransfer: { types: ['application/x-refora-docids'], dropEffect: '' },
      preventDefault: vi.fn()
    } as unknown as React.DragEvent
    result.current.handleDragOver(evt)
    expect(evt.preventDefault).toHaveBeenCalled()
    expect(evt.dataTransfer.dropEffect).toBe('copy')
  })

  it('handleDragOver does nothing for unrelated types', () => {
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const evt = {
      dataTransfer: { types: ['application/json'], dropEffect: '' },
      preventDefault: vi.fn()
    } as unknown as React.DragEvent
    result.current.handleDragOver(evt)
    expect(evt.preventDefault).not.toHaveBeenCalled()
  })

  it('drops a single doc id via api.categories.assign (JSON array)', async () => {
    api.categories.assign.mockResolvedValue(undefined)
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const evt = makeDataTransfer({ 'application/x-refora-docids': JSON.stringify(['doc-1']) })
    await act(async () => {
      await result.current.handleDrop('cat1', evt)
    })
    expect(api.categories.assign).toHaveBeenCalledWith('doc-1', 'cat1')
    expect(fetchCategories).toHaveBeenCalled()
    expect(api.documents.bulkCategorize).not.toHaveBeenCalled()
  })

  it('drops multiple doc ids via api.documents.bulkCategorize', async () => {
    api.documents.bulkCategorize.mockResolvedValue(undefined)
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const evt = makeDataTransfer({ 'application/x-refora-docids': JSON.stringify(['a', 'b']) })
    await act(async () => {
      await result.current.handleDrop('cat1', evt)
    })
    expect(api.documents.bulkCategorize).toHaveBeenCalledWith(['a', 'b'], 'cat1')
    expect(api.categories.assign).not.toHaveBeenCalled()
  })

  it('falls back to text/plain split by comma when JSON parse fails', async () => {
    api.documents.bulkCategorize.mockResolvedValue(undefined)
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const evt = makeDataTransfer({ 'text/plain': 'x,y,z' })
    await act(async () => {
      await result.current.handleDrop('cat1', evt)
    })
    expect(api.documents.bulkCategorize).toHaveBeenCalledWith(['x', 'y', 'z'], 'cat1')
  })

  it('shows toast on assign failure', async () => {
    api.categories.assign.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const evt = makeDataTransfer({ 'application/x-refora-docids': JSON.stringify(['doc-1']) })
    await act(async () => {
      await result.current.handleDrop('cat1', evt)
    })
    expect(useDocumentStore.getState().showToast).toHaveBeenCalled()
  })

  it('imports dropped PDF files and assigns them to the category', async () => {
    api.getPathForFile.mockResolvedValue('/path/paper.pdf')
    api.import.addFiles.mockResolvedValue({
      added: ['new-1', 'new-2'],
      skipped: [],
      errors: []
    })
    api.documents.bulkCategorize.mockResolvedValue(undefined)
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const file = { name: 'paper.pdf' } as File
    const evt = makeDataTransfer({}, [file])
    await act(async () => {
      await result.current.handleDrop('cat1', evt)
    })
    expect(api.import.addFiles).toHaveBeenCalledWith(['/path/paper.pdf'])
    expect(api.documents.bulkCategorize).toHaveBeenCalledWith(['new-1', 'new-2'], 'cat1')
    expect(fetchDocuments).toHaveBeenCalled()
  })

  it('submits every imported document in one category assignment request', async () => {
    api.getPathForFile.mockResolvedValue('/path/paper.pdf')
    api.import.addFiles.mockResolvedValue({
      added: ['new-1', 'new-2', 'new-3'],
      skipped: [],
      errors: []
    })
    api.documents.bulkCategorize.mockRejectedValue(new Error('assign failed'))
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const evt = makeDataTransfer({}, [{ name: 'paper.pdf' } as File])

    await act(async () => {
      await result.current.handleDrop('cat1', evt)
    })

    expect(api.documents.bulkCategorize).toHaveBeenCalledWith(
      ['new-1', 'new-2', 'new-3'],
      'cat1'
    )
    expect(useDocumentStore.getState().showToast).toHaveBeenCalled()
    expect(fetchDocuments).toHaveBeenCalled()
  })

  it('skips non-PDF files when dropping', async () => {
    api.getPathForFile.mockResolvedValue('/path/image.png')
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const file = { name: 'image.png' } as File
    const evt = makeDataTransfer({}, [file])
    await act(async () => {
      await result.current.handleDrop('cat1', evt)
    })
    expect(api.import.addFiles).not.toHaveBeenCalled()
  })

  it('does nothing when drop has no data and no files', async () => {
    const { result } = renderHook(() => useCategoryDrop(fetchCategories, fetchDocuments))
    const evt = makeDataTransfer({}, [])
    await act(async () => {
      await result.current.handleDrop('cat1', evt)
    })
    expect(api.categories.assign).not.toHaveBeenCalled()
    expect(api.import.addFiles).not.toHaveBeenCalled()
    expect(fetchCategories).not.toHaveBeenCalled()
  })
})
