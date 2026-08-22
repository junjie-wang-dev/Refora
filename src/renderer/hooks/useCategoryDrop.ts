import { useCallback, useState } from 'react'
import { useDocumentStore } from '../store/documentStore'
import { errorMessage } from '../../shared/ipc-types'
import { api } from '../ipc'

const DOC_MIME = 'application/x-refora-docids'

export function useCategoryDrop(fetchCategories: () => void, fetchDocuments: () => void) {
  const [pendingCatImports, setPendingCatImports] = useState<Set<string>>(new Set())

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes(DOC_MIME) ||
      e.dataTransfer.types.includes('text/plain') ||
      e.dataTransfer.types.includes('Files')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback(
    async (catId: string, e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(DOC_MIME) || e.dataTransfer.getData('text/plain')
      if (raw) {
        e.preventDefault()
        try {
          let ids: string[] = []
          try {
            const parsed: unknown = JSON.parse(raw)
            if (Array.isArray(parsed)) {
              ids = parsed.filter((v): v is string => typeof v === 'string')
            }
          } catch {
            ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
          }
          if (ids.length === 1) {
            await api.categories.assign(ids[0], catId)
          } else if (ids.length > 1) {
            await api.documents.bulkCategorize(ids, catId)
          }
          void fetchCategories()
        } catch (e) {
          useDocumentStore.getState().showToast(errorMessage(e, 'Failed to assign category'))
        }
        return
      }

      const files = e.dataTransfer.files
      if (files && files.length > 0) {
        e.preventDefault()
        const paths: string[] = []
        for (let i = 0; i < files.length; i++) {
          try {
            const p = await api.getPathForFile(files[i] as File)
            if (p && p.toLowerCase().endsWith('.pdf')) {
              paths.push(p)
            }
          } catch (e) {
            useDocumentStore.getState().showToast(errorMessage(e, 'Failed to read file path'))
          }
        }
        if (paths.length === 0) return

        setPendingCatImports((prev) => new Set(prev).add(catId))
        useDocumentStore.setState((s) => ({
          categories: s.categories.map((c) =>
            c.id === catId ? { ...c, count: (c.count ?? 0) + paths.length } : c
          )
        }))

        try {
          const result = await api.import.addFiles(paths)
          for (const id of result.added) {
            await api.categories.assign(id, catId)
          }
        } catch (e) {
          useDocumentStore.getState().showToast(errorMessage(e, 'Failed to import files to category'))
        }
        setPendingCatImports((prev) => {
          const next = new Set(prev)
          next.delete(catId)
          return next
        })
        void fetchCategories()
        void fetchDocuments()
      }
    },
    [fetchCategories, fetchDocuments]
  )

  return { pendingCatImports, handleDragOver, handleDrop }
}
