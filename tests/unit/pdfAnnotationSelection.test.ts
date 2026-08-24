import { describe, expect, it } from 'vitest'
import type { PdfAnnotation } from '../../src/shared/ipc-types'
import {
  annotationIdsInSelection,
  pdfDeltaFromRotation,
  pdfPointForRotation,
  pdfPointFromRotation,
  pdfRectForRotation,
  selectionRectFromPoints,
  translatedAnnotationGeometry
} from '../../src/renderer/utils/pdfAnnotationSelection'

function annotation(
  id: string,
  patch: Partial<PdfAnnotation>
): PdfAnnotation {
  return {
    id,
    kind: 'note',
    page: 1,
    color: '#f2c94c',
    text: '',
    comment: '',
    createdAt: 1,
    ...patch
  }
}

describe('PDF annotation selection', () => {
  it('normalizes selection rectangles in every drag direction', () => {
    const rect = selectionRectFromPoints(
      { x: 0.8, y: 0.7 },
      { x: 0.2, y: 0.1 }
    )

    expect(rect.x).toBeCloseTo(0.2)
    expect(rect.y).toBeCloseTo(0.1)
    expect(rect.width).toBeCloseTo(0.6)
    expect(rect.height).toBeCloseTo(0.6)
  })

  it('selects text ranges, notes, inline text, and ink paths', () => {
    const annotations = [
      annotation('highlight', {
        kind: 'highlight',
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.04 }]
      }),
      annotation('note', {
        point: { x: 0.35, y: 0.25 }
      }),
      annotation('text', {
        kind: 'text',
        point: { x: 0.42, y: 0.32 },
        text: 'Inline'
      }),
      annotation('ink', {
        kind: 'ink',
        points: [{ x: 0.6, y: 0.45 }, { x: 0.72, y: 0.55 }]
      }),
      annotation('outside', {
        kind: 'underline',
        rects: [{ x: 0.85, y: 0.85, width: 0.1, height: 0.03 }]
      })
    ]

    expect(annotationIdsInSelection(annotations, {
      x: 0.05,
      y: 0.05,
      width: 0.75,
      height: 0.6
    })).toEqual(['highlight', 'note', 'text', 'ink'])
  })

  it('roundtrips page coordinates through every supported rotation', () => {
    const point = { x: 0.2, y: 0.35 }

    for (const rotation of [0, 90, 180, 270]) {
      const roundtrip = pdfPointFromRotation(pdfPointForRotation(point, rotation), rotation)
      expect(roundtrip.x).toBeCloseTo(point.x)
      expect(roundtrip.y).toBeCloseTo(point.y)
    }
    expect(pdfRectForRotation({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.05
    }, 90)).toEqual({
      x: 0.75,
      y: 0.1,
      width: 0.05,
      height: 0.3
    })
    expect(pdfDeltaFromRotation({ x: 0.1, y: 0.2 }, 90)).toEqual({
      x: 0.2,
      y: -0.1
    })
  })

  it('moves every annotation geometry and clamps it to the page', () => {
    const mark = annotation('mark', {
      kind: 'highlight',
      rects: [{ x: 0.8, y: 0.8, width: 0.15, height: 0.05 }]
    })
    const note = annotation('note', { point: { x: 0.2, y: 0.3 } })
    const text = annotation('text', {
      kind: 'text',
      point: { x: 0.2, y: 0.3 },
      size: { width: 0.3, height: 0.1 }
    })
    const ink = annotation('ink', {
      kind: 'ink',
      points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }]
    })

    const movedMark = translatedAnnotationGeometry(mark, { x: 0.2, y: 0.3 }).rects?.[0]
    expect(movedMark?.x).toBeCloseTo(0.85)
    expect(movedMark?.y).toBeCloseTo(0.95)
    const movedNote = translatedAnnotationGeometry(note, { x: 0.1, y: 0.1 }).point
    const movedText = translatedAnnotationGeometry(text, { x: 0.1, y: 0.1 }).point
    const movedInk = translatedAnnotationGeometry(ink, { x: 0.1, y: 0.1 }).points
    expect(movedNote?.x).toBeCloseTo(0.3)
    expect(movedNote?.y).toBeCloseTo(0.4)
    expect(movedText?.x).toBeCloseTo(0.3)
    expect(movedText?.y).toBeCloseTo(0.4)
    expect(movedInk?.[0].x).toBeCloseTo(0.2)
    expect(movedInk?.[0].y).toBeCloseTo(0.3)
    expect(movedInk?.[1].x).toBeCloseTo(0.4)
    expect(movedInk?.[1].y).toBeCloseTo(0.5)
  })
})
