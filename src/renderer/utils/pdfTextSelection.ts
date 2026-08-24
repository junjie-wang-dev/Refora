import type { PdfAnnotationRect } from '../../shared/ipc-types'
import { pdfRectFromRotation } from './pdfAnnotationSelection'

export interface PdfTextSelection {
  text: string
  pages: Array<{
    page: number
    text: string
    rects: PdfAnnotationRect[]
  }>
}

export interface PdfTextPosition {
  node: Node
  offset: number
}

export interface PdfTextPointer {
  clientX: number
  clientY: number
  moved: boolean
}

export interface PdfTextClick {
  at: number
  clientX: number
  clientY: number
}

export function pdfTextPositionAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number
): PdfTextPosition | null {
  const caretPosition = typeof document.caretPositionFromPoint === 'function'
    ? document.caretPositionFromPoint(clientX, clientY)
    : null
  const caretRange = caretPosition
    ? null
    : (document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
      }).caretRangeFromPoint?.(clientX, clientY) ?? null
  const node = caretPosition?.offsetNode ?? caretRange?.startContainer
  const offset = caretPosition?.offset ?? caretRange?.startOffset
  if (!node || offset === undefined) return null
  const element = node instanceof Element ? node : node.parentElement
  if (!element?.closest('.textLayer') || !root.contains(element)) return null
  return { node, offset }
}

export function updateTextSelection(start: PdfTextPosition, end: PdfTextPosition): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  try {
    range.setStart(start.node, start.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    selection.extend(end.node, end.offset)
  } catch {
    selection.removeAllRanges()
  }
}

export function updateWordSelection(position: PdfTextPosition): void {
  updateTextSelection(position, position)
  const selection = window.getSelection()
  if (!selection) return
  try {
    selection.modify('move', 'backward', 'word')
    selection.modify('extend', 'forward', 'word')
  } catch {
    selection.removeAllRanges()
  }
}

function selectedTextInLayer(range: Range, layer: HTMLElement, fallback: string): string {
  try {
    if (!range.intersectsNode(layer)) return ''
    const pageRange = document.createRange()
    pageRange.selectNodeContents(layer)
    if (layer.contains(range.startContainer)) {
      pageRange.setStart(range.startContainer, range.startOffset)
    }
    if (layer.contains(range.endContainer)) {
      pageRange.setEnd(range.endContainer, range.endOffset)
    }
    return pageRange.toString().trim()
  } catch {
    return fallback
  }
}

export function textSelectionInReader(root: HTMLElement): PdfTextSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const text = selection.toString().trim()
  if (!text) return null
  const range = selection.getRangeAt(0)
  const clientRects = Array.from(range.getClientRects())
  const pages = Array.from(
    root.querySelectorAll<HTMLElement>('[data-page-number]')
  ).flatMap((element) => {
    const bounds = element.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return []
    const rects = clientRects
      .map((rect) => {
        const left = Math.max(bounds.left, rect.left)
        const right = Math.min(bounds.right, rect.right)
        const top = Math.max(bounds.top, rect.top)
        const bottom = Math.min(bounds.bottom, rect.bottom)
        const normalized = {
          x: (left - bounds.left) / bounds.width,
          y: (top - bounds.top) / bounds.height,
          width: (right - left) / bounds.width,
          height: (bottom - top) / bounds.height
        }
        return pdfRectFromRotation(
          normalized,
          Number(element.dataset.pageRotation) || 0
        )
      })
      .filter((rect) => rect.width > 0 && rect.height > 0)
    if (rects.length === 0) return []
    const page = Number(element.dataset.pageNumber)
    if (!Number.isInteger(page) || page < 1) return []
    const layer = element.querySelector<HTMLElement>('.textLayer')
    if (!layer) return []
    const pageText = selectedTextInLayer(range, layer, text)
    if (!pageText) return []
    return [{ page, text: pageText, rects }]
  })
  return pages.length > 0 ? { text, pages } : null
}

export function quoteSelection(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}
