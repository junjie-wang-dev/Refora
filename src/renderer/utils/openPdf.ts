import type { Document } from '../../shared/ipc-types'
import { api } from '../ipc'
import { usePdfReaderStore, type PdfNavigationTarget } from '../store/pdfReaderStore'
import { useWorkspaceStore } from '../store/workspaceStore'

export type PdfOpenMode = 'system' | 'builtin'

export interface PdfOpenOptions extends PdfNavigationTarget {
  forceSystem?: boolean
  forceBuiltin?: boolean
}

export async function openDocumentPdf(
  documentId: string,
  options: PdfOpenOptions = {}
): Promise<Document> {
  const mode = options.forceSystem
    ? 'system'
    : options.forceBuiltin || options.page !== undefined || options.search
      ? 'builtin'
      : await api.settings.get<PdfOpenMode>('pdfOpenMode', 'system')
  const external = mode !== 'builtin'
  const document = external
    ? await api.documents.openPdf(documentId)
    : await api.documents.openPdf(documentId, false)
  if (!external) {
    const target = options.page !== undefined || options.search
      ? { page: options.page, search: options.search }
      : undefined
    const readerOpen = usePdfReaderStore.getState().open(document, target)
    useWorkspaceStore.getState().openPdfReader()
    await readerOpen
  }
  return document
}
