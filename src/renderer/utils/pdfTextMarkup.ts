import { usePdfReaderStore, type PdfAnnotationDraft, type PdfTool } from '../store/pdfReaderStore'
import type { PdfTextSelection } from './pdfTextSelection'

export type PdfTextMarkupTool = 'highlight' | 'underline' | 'strikeout'

export function isPdfTextMarkupTool(tool: PdfTool | null): tool is PdfTextMarkupTool {
  return tool === 'highlight' || tool === 'underline' || tool === 'strikeout'
}

export function applyPdfTextMarkup(
  documentId: string,
  selection: PdfTextSelection,
  tool: PdfTextMarkupTool,
  color: string,
  onAddAnnotation: (draft: PdfAnnotationDraft) => void
): void {
  const store = usePdfReaderStore.getState()
  store.beginHistoryGroup(documentId)
  try {
    selection.pages.forEach((page) => {
      onAddAnnotation({
        kind: tool,
        page: page.page,
        color,
        text: page.text,
        comment: '',
        rects: page.rects
      })
    })
  } finally {
    store.endHistoryGroup(documentId)
  }
  window.getSelection()?.removeAllRanges()
}
