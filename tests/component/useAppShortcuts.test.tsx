import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppShortcuts } from '../../src/renderer/hooks/useAppShortcuts'
import { useDocumentStore } from '../../src/renderer/store/documentStore'
import type { Document } from '../../src/shared/ipc-types'

function makeDoc(id: string): Document {
  return {
    id, filePath: `/x/${id}.pdf`, originalFolderPath: '/x', fileName: `${id}.pdf`,
    fileSize: 1, fileHash: id, title: id, authors: '', year: '', venue: '',
    volume: null, issue: null, pages: null, abstract: null, keywords: null,
    url: null, doi: null, note: null, starred: 0, addedAt: 0, lastReadAt: null,
    updatedAt: 0, metadataSource: null, metadataStatus: 'success', metadataAttempts: 0,
    editedFields: [], remoteValues: null, fileMissing: 0
  }
}

function dispatch(key: string, opts: { meta?: boolean; ctrl?: boolean; target?: EventTarget | null } = {}) {
  const evt = new KeyboardEvent('keydown', {
    key, metaKey: !!opts.meta, ctrlKey: !!opts.ctrl, bubbles: true, cancelable: true
  })
  if (opts.target !== undefined) {
    Object.defineProperty(evt, 'target', { value: opts.target ?? null })
  }
  window.dispatchEvent(evt)
}

let documentList: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  useDocumentStore.setState({
    documents: [makeDoc('a'), makeDoc('b'), makeDoc('c')],
    searchResults: [],
    selectedIds: [],
    focusedDocId: null,
    isSearching: false
  })
  vi.spyOn(useDocumentStore.getState(), 'requestDeleteConfirm').mockImplementation(() => {})
  vi.spyOn(useDocumentStore.getState(), 'openPdf').mockImplementation(() => Promise.resolve())
  vi.spyOn(useDocumentStore.getState(), 'setFocusedDoc').mockImplementation(() => {})
  documentList = document.createElement('div')
  documentList.className = 'document-list'
  document.body.append(documentList)
})

afterEach(() => {
  documentList.remove()
  cleanup()
  vi.restoreAllMocks()
})

describe('useAppShortcuts', () => {
  it('focuses search input on Cmd/Ctrl+F', () => {
    const focus = vi.fn()
    const input = document.createElement('input')
    input.className = 'doc-search-input'
    input.focus = focus
    vi.spyOn(document, 'querySelector').mockReturnValue(input)
    renderHook(() => useAppShortcuts())
    dispatch('f', { meta: true })
    expect(focus).toHaveBeenCalled()
  })

  it('requests delete confirm for selected ids on Cmd+Backspace', () => {
    useDocumentStore.setState({ selectedIds: ['x', 'y'] })
    renderHook(() => useAppShortcuts())
    dispatch('Backspace', { meta: true })
    expect(useDocumentStore.getState().requestDeleteConfirm).toHaveBeenCalledWith(['x', 'y'], '')
  })

  it('falls back to focusedDocId when no selection on Cmd+Backspace', () => {
    useDocumentStore.setState({ selectedIds: [], focusedDocId: 'f' })
    renderHook(() => useAppShortcuts())
    dispatch('Backspace', { meta: true })
    expect(useDocumentStore.getState().requestDeleteConfirm).toHaveBeenCalledWith(['f'], '')
  })

  it('does nothing on Cmd+Backspace when nothing selected/focused', () => {
    renderHook(() => useAppShortcuts())
    dispatch('Backspace', { meta: true })
    expect(useDocumentStore.getState().requestDeleteConfirm).not.toHaveBeenCalled()
  })

  it('ignores Cmd+Backspace when target is an input', () => {
    useDocumentStore.setState({ selectedIds: ['x'] })
    const input = document.createElement('input')
    renderHook(() => useAppShortcuts())
    dispatch('Backspace', { meta: true, target: input })
    expect(useDocumentStore.getState().requestDeleteConfirm).not.toHaveBeenCalled()
  })

  it('moves focus down with ArrowDown', () => {
    renderHook(() => useAppShortcuts())
    dispatch('ArrowDown')
    expect(useDocumentStore.getState().setFocusedDoc).toHaveBeenCalledWith('a')
  })

  it('moves focus up with ArrowUp from second doc', () => {
    useDocumentStore.setState({ focusedDocId: 'b' })
    renderHook(() => useAppShortcuts())
    dispatch('ArrowUp')
    expect(useDocumentStore.getState().setFocusedDoc).toHaveBeenCalledWith('a')
  })

  it('clamps at top on ArrowUp from first doc', () => {
    useDocumentStore.setState({ focusedDocId: 'a' })
    renderHook(() => useAppShortcuts())
    dispatch('ArrowUp')
    expect(useDocumentStore.getState().setFocusedDoc).toHaveBeenCalledWith('a')
  })

  it('clamps at bottom on ArrowDown from last doc', () => {
    useDocumentStore.setState({ focusedDocId: 'c' })
    renderHook(() => useAppShortcuts())
    dispatch('ArrowDown')
    expect(useDocumentStore.getState().setFocusedDoc).toHaveBeenCalledWith('c')
  })

  it('uses searchResults when isSearching', () => {
    const sa = makeDoc('s1')
    useDocumentStore.setState({ isSearching: true, searchResults: [sa], focusedDocId: null })
    renderHook(() => useAppShortcuts())
    dispatch('ArrowDown')
    expect(useDocumentStore.getState().setFocusedDoc).toHaveBeenCalledWith('s1')
  })

  it('opens focused PDF on Enter', () => {
    useDocumentStore.setState({ focusedDocId: 'b' })
    renderHook(() => useAppShortcuts())
    dispatch('Enter')
    expect(useDocumentStore.getState().openPdf).toHaveBeenCalledWith('b')
  })

  it('does nothing on Enter when no focused doc', () => {
    renderHook(() => useAppShortcuts())
    dispatch('Enter')
    expect(useDocumentStore.getState().openPdf).not.toHaveBeenCalled()
  })

  it('ignores arrow keys when target is interactive (input)', () => {
    const input = document.createElement('input')
    renderHook(() => useAppShortcuts())
    dispatch('ArrowDown', { target: input })
    expect(useDocumentStore.getState().setFocusedDoc).not.toHaveBeenCalled()
  })

  it('ignores shortcuts while a modal dialog is open', () => {
    const modal = document.createElement('div')
    modal.className = 'dialog-overlay'
    document.body.append(modal)
    useDocumentStore.setState({ selectedIds: ['x'] })
    renderHook(() => useAppShortcuts())

    dispatch('Backspace', { meta: true })
    dispatch('ArrowDown')

    expect(useDocumentStore.getState().requestDeleteConfirm).not.toHaveBeenCalled()
    expect(useDocumentStore.getState().setFocusedDoc).not.toHaveBeenCalled()
    modal.remove()
  })
})
