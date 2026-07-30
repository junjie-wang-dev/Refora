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
          width: 0.32,
          height: 0.12
        }]
      : [pointRect(annotation.point, 0.05, 0.05)]
  }
  return []
}

export function annotationIdsInSelection(
  annotations: PdfAnnotation[],
  selection: PdfAnnotationRect
): string[] {
  return annotations
    .filter((annotation) =>
      annotationSelectionRects(annotation).some((rect) => intersects(rect, selection))
    )
    .map((annotation) => annotation.id)
}
