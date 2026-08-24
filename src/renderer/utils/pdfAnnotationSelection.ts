import type {
  PdfAnnotation,
  PdfAnnotationPoint,
  PdfAnnotationRect
} from '../../shared/ipc-types'

export function selectionRectFromPoints(
  start: PdfAnnotationPoint,
  end: PdfAnnotationPoint
): PdfAnnotationRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  }
}

function normalizedRotation(rotation: number): number {
  return ((Math.round(rotation / 90) * 90) % 360 + 360) % 360
}

export function pdfPointForRotation(
  point: PdfAnnotationPoint,
  rotation: number
): PdfAnnotationPoint {
  switch (normalizedRotation(rotation)) {
    case 90:
      return { x: 1 - point.y, y: point.x }
    case 180:
      return { x: 1 - point.x, y: 1 - point.y }
    case 270:
      return { x: point.y, y: 1 - point.x }
    default:
      return point
  }
}

export function pdfPointFromRotation(
  point: PdfAnnotationPoint,
  rotation: number
): PdfAnnotationPoint {
  return pdfPointForRotation(point, 360 - normalizedRotation(rotation))
}

export function pdfRectForRotation(
  rect: PdfAnnotationRect,
  rotation: number
): PdfAnnotationRect {
  switch (normalizedRotation(rotation)) {
    case 90:
      return {
        x: 1 - rect.y - rect.height,
        y: rect.x,
        width: rect.height,
        height: rect.width
      }
    case 180:
      return {
        x: 1 - rect.x - rect.width,
        y: 1 - rect.y - rect.height,
        width: rect.width,
        height: rect.height
      }
    case 270:
      return {
        x: rect.y,
        y: 1 - rect.x - rect.width,
        width: rect.height,
        height: rect.width
      }
    default:
      return rect
  }
}

export function pdfRectFromRotation(
  rect: PdfAnnotationRect,
  rotation: number
): PdfAnnotationRect {
  return pdfRectForRotation(rect, 360 - normalizedRotation(rotation))
}

export function pdfDeltaFromRotation(
  delta: PdfAnnotationPoint,
  rotation: number
): PdfAnnotationPoint {
  switch (normalizedRotation(rotation)) {
    case 90:
      return { x: delta.y, y: -delta.x }
    case 180:
      return { x: -delta.x, y: -delta.y }
    case 270:
      return { x: -delta.y, y: delta.x }
    default:
      return delta
  }
}

function intersects(first: PdfAnnotationRect, second: PdfAnnotationRect): boolean {
  return first.x <= second.x + second.width &&
    first.x + first.width >= second.x &&
    first.y <= second.y + second.height &&
    first.y + first.height >= second.y
}

function pointRect(
  point: PdfAnnotationPoint,
  width: number,
  height: number
): PdfAnnotationRect {
  return {
    x: Math.max(0, point.x - (width / 2)),
    y: Math.max(0, point.y - (height / 2)),
    width,
    height
  }
}

export function annotationSelectionRects(annotation: PdfAnnotation): PdfAnnotationRect[] {
  if (annotation.rects?.length) return annotation.rects
  if (annotation.kind === 'ink' && annotation.points?.length) {
    const xs = annotation.points.map((point) => point.x)
    const ys = annotation.points.map((point) => point.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return [{
      x: Math.max(0, x - 0.01),
      y: Math.max(0, y - 0.01),
      width: Math.max(0.02, Math.max(...xs) - x + 0.02),
      height: Math.max(0.02, Math.max(...ys) - y + 0.02)
    }]
  }
  if (annotation.point) {
    return annotation.kind === 'text'
      ? [{
          x: annotation.point.x,
          y: annotation.point.y,
          width: annotation.size?.width ?? 0.16,
          height: annotation.size?.height ?? 0.04
        }]
      : [pointRect(annotation.point, 0.05, 0.05)]
  }
  return []
}

export function annotationIdsInSelection(
  annotations: PdfAnnotation[],
  selection: PdfAnnotationRect,
  rotation = 0
): string[] {
  return annotations
    .filter((annotation) =>
      annotationSelectionRects(annotation).some((rect) =>
        intersects(pdfRectForRotation(rect, rotation), selection)
      )
    )
    .map((annotation) => annotation.id)
}

export function translatedAnnotationGeometry(
  annotation: PdfAnnotation,
  requestedDelta: PdfAnnotationPoint
): Pick<PdfAnnotation, 'rects' | 'point' | 'points'> {
  const bounds = annotationSelectionRects(annotation)
  if (bounds.length === 0) return {}
  const left = Math.min(...bounds.map((rect) => rect.x))
  const top = Math.min(...bounds.map((rect) => rect.y))
  const right = Math.max(...bounds.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...bounds.map((rect) => rect.y + rect.height))
  const dx = Math.max(-left, Math.min(1 - right, requestedDelta.x))
  const dy = Math.max(-top, Math.min(1 - bottom, requestedDelta.y))
  return {
    rects: annotation.rects?.map((rect) => ({
      ...rect,
      x: rect.x + dx,
      y: rect.y + dy
    })),
    point: annotation.point
      ? { x: annotation.point.x + dx, y: annotation.point.y + dy }
      : undefined,
    points: annotation.points?.map((point) => ({
      x: point.x + dx,
      y: point.y + dy
    }))
  }
}
