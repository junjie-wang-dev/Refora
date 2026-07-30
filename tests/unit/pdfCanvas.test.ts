import { describe, expect, it } from 'vitest'
import { pdfCanvasLayout } from '../../src/renderer/utils/pdfCanvas'

describe('pdfCanvasLayout', () => {
  it('uses the full device pixel ratio and keeps the render transform pixel-accurate', () => {
    const layout = pdfCanvasLayout(703.8, 910.65, 3)

    expect(layout.width).toBe(2111)
    expect(layout.height).toBe(2732)
    expect(layout.scaleX).toBe(layout.width / 703.8)
    expect(layout.scaleY).toBe(layout.height / 910.65)
    expect(layout.scaleX).toBeGreaterThan(2)
    expect(layout.scaleY).toBeGreaterThan(2)
  })

  it('limits unusually large canvases to the PDF.js viewer pixel budget', () => {
    const layout = pdfCanvasLayout(6000, 6000, 3)

    expect(layout.width * layout.height).toBeLessThanOrEqual(2 ** 25)
    expect(layout.scaleX).toBeLessThan(1)
    expect(layout.scaleY).toBeLessThan(1)
  })

  it('falls back to a one-to-one scale for an invalid device ratio', () => {
    expect(pdfCanvasLayout(612, 792, 0)).toEqual({
      width: 612,
      height: 792,
      scaleX: 1,
      scaleY: 1
    })
  })
})
