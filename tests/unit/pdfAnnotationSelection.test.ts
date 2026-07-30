import { describe, expect, it } from 'vitest'
import type { PdfAnnotation } from '../../src/shared/ipc-types'
import {
  annotationIdsInSelection,
  selectionRectFromPoints
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
})
