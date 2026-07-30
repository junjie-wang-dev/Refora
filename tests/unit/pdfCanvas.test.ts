import { describe, expect, it } from 'vitest'
import {
  pdfCanvasLayout,
  pdfCanvasTileTransform,
  pdfRenderPixelRatio,
  pdfVisibilityObserverOptions
} from '../../src/renderer/utils/pdfCanvas'

describe('pdfCanvasLayout', () => {
  it('supersamples beyond the device pixel ratio without downscaling a standard page', () => {
    const layout = pdfCanvasLayout(703.8, 910.65, 2)
    const tile = layout.tiles[0]

    expect(layout.pixelRatio).toBe(3)
    expect(layout.tiles).toHaveLength(1)
    expect(tile.pixelWidth).toBe(2112)
    expect(tile.pixelHeight).toBe(2732)
    expect(pdfCanvasTileTransform(tile, layout.pixelRatio)).toEqual([3, 0, 0, 3, 0, 0])
  })

  it('uses a two-pixel minimum on standard-density displays', () => {
    expect(pdfRenderPixelRatio(1)).toBe(2)
    expect(pdfRenderPixelRatio(2)).toBe(3)
  })

  it('tiles unusually large pages without reducing the render pixel ratio', () => {
    const layout = pdfCanvasLayout(6000, 6000, 3)

    expect(layout.pixelRatio).toBe(4.5)
    expect(layout.tiles.length).toBeGreaterThan(1)
    expect(layout.tiles.every((tile) =>
      tile.pixelWidth * tile.pixelHeight <= 2 ** 25 &&
      tile.pixelWidth <= 32767 &&
      tile.pixelHeight <= 32767
    )).toBe(true)
    expect(Math.max(...layout.tiles.map((tile) => tile.pixelX + tile.pixelWidth)))
      .toBe(Math.ceil(6000 * layout.pixelRatio))
    expect(Math.max(...layout.tiles.map((tile) => tile.pixelY + tile.pixelHeight)))
      .toBe(Math.ceil(6000 * layout.pixelRatio))
    const offsetTile = layout.tiles.find((tile) => tile.pixelX > 0 && tile.pixelY > 0)
    expect(offsetTile).toBeDefined()
    if (!offsetTile) throw new Error('Expected an offset PDF canvas tile')
    expect(pdfCanvasTileTransform(offsetTile, layout.pixelRatio)).toEqual([
      layout.pixelRatio,
      0,
      0,
      layout.pixelRatio,
      -offsetTile.pixelX,
      -offsetTile.pixelY
    ])
  })

  it('falls back to the high-quality minimum for an invalid device ratio', () => {
    const layout = pdfCanvasLayout(612, 792, 0)

    expect(layout.pixelRatio).toBe(2)
    expect(layout.tiles).toHaveLength(1)
    expect(layout.tiles[0]).toMatchObject({
      pixelWidth: 1224,
      pixelHeight: 1584
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
