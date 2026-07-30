import type { Document } from '../../shared/ipc-types'
import { api } from '../ipc'
import { usePdfReaderStore } from '../store/pdfReaderStore'
import { useWorkspaceStore } from '../store/workspaceStore'

export type PdfOpenMode = 'system' | 'builtin'

export async function openDocumentPdf(
  documentId: string,
  options: { forceSystem?: boolean } = {}
): Promise<Document> {
  const mode = options.forceSystem
    ? 'system'
    : await api.settings.get<PdfOpenMode>('pdfOpenMode', 'system')
  const external = mode !== 'builtin'
  const document = external
    ? await api.documents.openPdf(documentId)
    : await api.documents.openPdf(documentId, false)
  if (!external) {
    const readerOpen = usePdfReaderStore.getState().open(document)
    useWorkspaceStore.getState().openPdfReader()
    await readerOpen
  }
  return document
}
