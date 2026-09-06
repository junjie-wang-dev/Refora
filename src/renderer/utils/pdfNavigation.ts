import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api'
import type { PdfReadingPosition } from '../store/pdfViewStore'

export interface PdfNavigationTarget extends PdfReadingPosition {
  scale?: number
  zoomMode?: 'custom' | 'width'
}

export function capturePdfPosition(root: HTMLElement, preferredPage: number): PdfReadingPosition | null {
  const rootBounds = root.getBoundingClientRect()
  const pages = Array.from(root.querySelectorAll<HTMLElement>('[data-page-number]'))
  const visiblePages = pages.filter((page) => {
    const bounds = page.getBoundingClientRect()
    return bounds.bottom > rootBounds.top && bounds.top < rootBounds.bottom
  })
  const page = visiblePages.find((page) => Number(page.dataset.pageNumber) === preferredPage) ?? visiblePages[0]
  if (!page) return null
  const bounds = page.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return null
  return {
    page: Number(page.dataset.pageNumber),
    x: (rootBounds.left - bounds.left) / bounds.width,
    y: (rootBounds.top - bounds.top) / bounds.height
  }
}

export async function resolvePdfDestination(
  pdf: PDFDocumentProxy,
  destination: string | unknown[],
  rotation: number,
  container: { width: number; height: number },
  current: PdfReadingPosition
): Promise<PdfNavigationTarget | null> {
  const explicit = typeof destination === 'string' ? await pdf.getDestination(destination) : destination
  if (!Array.isArray(explicit)) return null
  const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  const kind = explicit[1] && typeof explicit[1] === 'object'
    ? (explicit[1] as { name?: string }).name : undefined
  const operandCount = kind === 'XYZ' ? 3 : kind === 'FitR' ? 4
    : kind === 'FitH' || kind === 'FitBH' || kind === 'FitV' || kind === 'FitBV' ? 1
      : kind === 'Fit' || kind === 'FitB' ? 0 : -1
  if (operandCount < 0 || explicit.length !== operandCount + 2 ||
    !explicit.slice(2).every((value) => number(value) || (kind !== 'FitR' && value === null))) return null
  const reference = explicit[0]
  let pageNumber: number
  if (Number.isInteger(reference)) pageNumber = Number(reference) + 1
  else if (reference && typeof reference === 'object') {
    const ref = reference as Parameters<typeof pdf.getPageIndex>[0]
    if (!Number.isInteger(ref.num) || ref.num < 0 || !Number.isInteger(ref.gen) || ref.gen < 0) return null
    pageNumber = pdf.cachedPageNumber(ref) ?? await pdf.getPageIndex(ref) + 1
  } else return null
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) return null
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1, rotation: (((page.rotate ?? 0) + rotation) % 360 + 360) % 360 })
  const target: PdfNavigationTarget = { page: pageNumber, x: 0, y: 0 }
  const point = (x: number, y: number) => {
    const [vx, vy] = viewport.convertToViewportPoint(x, y)
    return { x: vx / viewport.width, y: vy / viewport.height }
  }
  const view = page.view
  const currentPoint = () => viewport.convertToPdfPoint(current.x * viewport.width, current.y * viewport.height)
  const widthScale = Math.max(1, container.width - 48) / viewport.width
  const heightScale = Math.max(1, container.height - 48) / viewport.height
  if (kind === 'XYZ') {
    const [currentX, currentY] = explicit[2] === null || explicit[3] === null ? currentPoint() : [view[0], view[3]]
    Object.assign(target, point(number(explicit[2]) ? explicit[2] : currentX, number(explicit[3]) ? explicit[3] : currentY))
    if (number(explicit[4]) && explicit[4] > 0) {
      target.scale = explicit[4]
      target.zoomMode = 'custom'
    }
  } else if (kind === 'FitH' || kind === 'FitBH') {
    Object.assign(target, explicit[2] === null ? { x: current.x, y: current.y } : point(view[0], Number(explicit[2])))
    target.scale = widthScale
    target.zoomMode = 'width'
  } else if (kind === 'FitV' || kind === 'FitBV') {
    Object.assign(target, explicit[2] === null ? { x: current.x, y: current.y } : point(Number(explicit[2]), view[3]))
    target.scale = heightScale
    target.zoomMode = 'custom'
  } else if (kind === 'Fit' || kind === 'FitB') {
    target.scale = Math.min(widthScale, heightScale)
    target.zoomMode = 'custom'
  } else if (kind === 'FitR') {
    const start = point(Number(explicit[2]), Number(explicit[3]))
    const end = point(Number(explicit[4]), Number(explicit[5]))
    target.x = Math.min(start.x, end.x)
    target.y = Math.min(start.y, end.y)
    const width = Math.abs(start.x - end.x) * viewport.width
    const height = Math.abs(start.y - end.y) * viewport.height
    if (width <= 0 || height <= 0) return null
    target.scale = Math.min(Math.max(1, container.width - 48) / width, Math.max(1, container.height - 48) / height)
    target.zoomMode = 'custom'
  }
  return target
}
