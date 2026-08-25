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

function validTextPosition(
  root: HTMLElement,
  node: Node | null | undefined,
  offset: number | null | undefined
): PdfTextPosition | null {
  if (
    !node ||
    node.nodeType !== Node.TEXT_NODE ||
    offset === null ||
    offset === undefined ||
    offset < 0 ||
    offset > (node.textContent?.length ?? 0)
  ) return null
  const element = node.parentElement
  if (!element?.closest('.textLayer') || !root.contains(element)) return null
  return { node, offset }
}

function distanceToRect(clientX: number, clientY: number, rect: DOMRect): number {
  const dx = clientX < rect.left
    ? rect.left - clientX
    : clientX > rect.right
      ? clientX - rect.right
      : 0
  const dy = clientY < rect.top
    ? rect.top - clientY
    : clientY > rect.bottom
      ? clientY - rect.bottom
      : 0
  return dx * dx + dy * dy
}

function fallbackTextPositionAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number
): PdfTextPosition | null {
  const layers = Array.from(root.querySelectorAll<HTMLElement>('.textLayer'))
    .filter((layer) => distanceToRect(clientX, clientY, layer.getBoundingClientRect()) === 0)
  let best: { position: PdfTextPosition; distance: number } | null = null
  for (const layer of layers) {
    for (const span of layer.querySelectorAll<HTMLElement>('span')) {
      const spanBounds = span.getBoundingClientRect()
      if (distanceToRect(clientX, clientY, spanBounds) > 4) continue
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const length = node.textContent?.length ?? 0
        for (let offset = 0; offset < length; offset += 1) {
          const range = document.createRange()
          range.setStart(node, offset)
          range.setEnd(node, offset + 1)
          for (const rect of Array.from(range.getClientRects())) {
            const distance = distanceToRect(clientX, clientY, rect)
            const position = {
              node,
              offset: clientX < rect.left + rect.width / 2 ? offset : offset + 1
            }
            if (!best || distance < best.distance) best = { position, distance }
          }
        }
        if (length > 0 && !best) {
          const ratio = spanBounds.width > 0
            ? Math.max(0, Math.min(1, (clientX - spanBounds.left) / spanBounds.width))
            : 0
          best = {
            position: { node, offset: Math.round(length * ratio) },
            distance: distanceToRect(clientX, clientY, spanBounds)
          }
        }
        node = walker.nextNode()
      }
    }
  }
  return best?.position ?? null
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
  return validTextPosition(root, node, offset) ??
    fallbackTextPositionAtPoint(root, clientX, clientY)
}

export function updateTextSelection(start: PdfTextPosition, end: PdfTextPosition): void {
  const selection = window.getSelection()
  if (!selection) return
  try {
    const startRange = document.createRange()
    startRange.setStart(start.node, start.offset)
    startRange.collapse(true)
    const endRange = document.createRange()
    endRange.setStart(end.node, end.offset)
    endRange.collapse(true)
    const forward = startRange.compareBoundaryPoints(Range.START_TO_START, endRange) <= 0
    const range = document.createRange()
    const rangeStart = forward ? start : end
    const rangeEnd = forward ? end : start
    range.setStart(rangeStart.node, rangeStart.offset)
    range.setEnd(rangeEnd.node, rangeEnd.offset)
    selection.removeAllRanges()
    selection.addRange(range)
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
