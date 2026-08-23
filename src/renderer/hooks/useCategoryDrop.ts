import { useCallback, useState } from 'react'
import { useDocumentStore } from '../store/documentStore'
import { errorMessage } from '../../shared/ipc-types'
import { api } from '../ipc'
import i18n from '../i18n'
import { DOCUMENT_IDS_MIME } from '../utils/documentDrag'

const DOC_MIME = DOCUMENT_IDS_MIME

export function useCategoryDrop(fetchDocuments: () => void) {
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
        let ids: string[] = []
        try {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            ids = parsed.filter((v): v is string => typeof v === 'string')
          }
        } catch {
          ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
        }
        await useDocumentStore.getState().assignDocumentsToCategory(ids, catId)
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
            useDocumentStore.getState().showToast(
              errorMessage(e, i18n.t('documentErrors.readFilePathFailed'))
            )
          }
        }
        if (paths.length === 0) return

        setPendingCatImports((prev) => new Set(prev).add(catId))
        try {
          const result = await api.import.addFiles(paths)
          await useDocumentStore.getState().assignDocumentsToCategory(result.added, catId)
        } catch (e) {
          useDocumentStore.getState().showToast(
            errorMessage(e, i18n.t('documentErrors.importToCategoryFailed'))
          )
        }
        setPendingCatImports((prev) => {
          const next = new Set(prev)
          next.delete(catId)
          return next
        })
        void fetchDocuments()
      }
    },
    [fetchDocuments]
  )

  return { pendingCatImports, handleDragOver, handleDrop }
}
