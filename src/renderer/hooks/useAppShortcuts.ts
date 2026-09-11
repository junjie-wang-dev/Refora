import { useEffect, useCallback } from 'react'
import { useDocumentStore } from '../store/documentStore'

function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    tag === 'A' ||
    target.isContentEditable
  )
}

function isTextEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type))
}

export function useAppShortcuts(): void {
  const focusSearch = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('.doc-search-input')
    input?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelectorAll('[aria-modal="true"], .dialog-overlay').length > 0) return
      const mod = e.metaKey || e.ctrlKey

      if (mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        const focusedSurface = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-markdown-surface]') : null
        const surface = focusedSurface ?? Array.from(document.querySelectorAll<HTMLElement>('[data-markdown-surface]')).find((element) => !element.closest('.hidden, [hidden]'))
        if (surface) surface.dispatchEvent(new Event('refora-markdown-find'))
        else focusSearch()
        return
      }
      const documentList = document.querySelector<HTMLElement>('.document-list')
      if (!documentList) return
      const targetIsInList = e.target instanceof Node
        ? documentList.contains(e.target)
        : document.activeElement instanceof Node && documentList.contains(document.activeElement)
      if (!targetIsInList) return
      if (mod && e.key.toLowerCase() === 'a' && !isTextEditing(e.target)) {
        e.preventDefault()
        void useDocumentStore.getState().selectAll()
        return
      }
      if (mod && e.key === 'Backspace' && !isInteractive(e.target)) {
        e.preventDefault()
        const store = useDocumentStore.getState()
        if (store.selectedIds.length > 0) {
          store.requestDeleteConfirm(
            store.selectedIds,
            ''
          )
        } else if (store.focusedDocId) {
          store.requestDeleteConfirm([store.focusedDocId], '')
        }
        return
      }

      if (mod || isInteractive(e.target)) return

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const store = useDocumentStore.getState()
        const docs = store.isSearching ? store.searchResults : store.documents
        if (docs.length === 0) return
        const currentId = store.focusedDocId
        const currentIdx = currentId ? docs.findIndex((d) => d.id === currentId) : -1
        const nextIdx = e.key === 'ArrowUp'
          ? Math.max(0, currentIdx <= 0 ? 0 : currentIdx - 1)
          : Math.min(docs.length - 1, currentIdx < 0 ? 0 : currentIdx + 1)
        if (e.shiftKey) store.selectRange(docs[nextIdx].id)
        else store.setFocusedDoc(docs[nextIdx].id)
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        const store = useDocumentStore.getState()
        if (store.focusedDocId) {
          void store.openPdf(store.focusedDocId)
        }
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        useDocumentStore.getState().clearSelection()
        return
      }

      if (e.key === ' ') {
        e.preventDefault()
        const store = useDocumentStore.getState()
        if (store.focusedDocId) store.toggleSelect(store.focusedDocId)
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [focusSearch])
}
