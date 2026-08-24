import { describe, expect, it } from 'vitest'
import {
  pdfCanvasLayout,
  pdfCanvasTileTransform,
  pdfRenderPixelRatio,
  pdfVisibilityObserverOptions
} from '../../src/renderer/utils/pdfCanvas'

describe('pdfCanvasLayout', () => {
  it('renders a standard page at the bounded device pixel ratio', () => {
    const layout = pdfCanvasLayout(703.8, 910.65, 2)
    const tile = layout.tiles[0]

    expect(layout.pixelRatio).toBe(2)
    expect(layout.tiles).toHaveLength(1)
    expect(tile.pixelWidth).toBe(1408)
    expect(tile.pixelHeight).toBe(1822)
    expect(pdfCanvasTileTransform(tile, layout.pixelRatio)).toEqual([2, 0, 0, 2, 0, 0])
  })

  it('uses the device ratio up to the safe quality ceiling', () => {
    expect(pdfRenderPixelRatio(1)).toBe(1)
    expect(pdfRenderPixelRatio(2)).toBe(2)
    expect(pdfRenderPixelRatio(3)).toBe(2)
  })

  it('reduces unusually large pages to a bounded total pixel allocation', () => {
    const layout = pdfCanvasLayout(6000, 6000, 3)

    expect(layout.pixelRatio).toBeCloseTo(
      Math.sqrt((2 ** 24) / (6000 * 6000)) * 0.999
    )
    expect(layout.tiles).toHaveLength(1)
    expect(layout.tiles.every((tile) =>
      tile.pixelWidth * tile.pixelHeight <= 2 ** 25 &&
      tile.pixelWidth <= 32767 &&
      tile.pixelHeight <= 32767
    )).toBe(true)
    expect(Math.max(...layout.tiles.map((tile) => tile.pixelX + tile.pixelWidth)))
      .toBe(Math.ceil(6000 * layout.pixelRatio))
    expect(Math.max(...layout.tiles.map((tile) => tile.pixelY + tile.pixelHeight)))
      .toBe(Math.ceil(6000 * layout.pixelRatio))
    expect(layout.tiles[0].pixelWidth * layout.tiles[0].pixelHeight)
      .toBeLessThanOrEqual(2 ** 24)
  })

  it('falls back to one device pixel for an invalid device ratio', () => {
    const layout = pdfCanvasLayout(612, 792, 0)

    expect(layout.pixelRatio).toBe(1)
    expect(layout.tiles).toHaveLength(1)
    expect(layout.tiles[0]).toMatchObject({
      pixelWidth: 612,
      pixelHeight: 792
    })
  })

  it('uses the PDF scroll container as the visibility root', () => {
    const root = document.createElement('div')

    expect(pdfVisibilityObserverOptions(root)).toEqual({
      root,
      rootMargin: '700px 0px'
    })
  })
})
