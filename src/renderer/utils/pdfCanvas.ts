const MAX_CANVAS_PIXELS = 2 ** 25
const MAX_CANVAS_DIMENSION = 32767
const MIN_RENDER_PIXEL_RATIO = 2
const RENDER_OVERSAMPLE = 1.5
const MAX_TILE_PIXEL_DIMENSION = Math.min(
  MAX_CANVAS_DIMENSION,
  Math.floor(Math.sqrt(MAX_CANVAS_PIXELS))
)

export interface PdfCanvasTile {
  cssHeight: number
  cssWidth: number
  cssX: number
  cssY: number
  pixelHeight: number
  pixelWidth: number
  pixelX: number
  pixelY: number
}

export interface PdfCanvasLayout {
  pixelRatio: number
  tiles: PdfCanvasTile[]
}

export function pdfVisibilityObserverOptions(root: Element): IntersectionObserverInit {
  return {
    root,
    rootMargin: '700px 0px'
  }
}

export function pdfCanvasTileTransform(
  tile: PdfCanvasTile,
  pixelRatio: number
): [number, number, number, number, number, number] {
  return [
    pixelRatio,
    0,
    0,
    pixelRatio,
    tile.pixelX === 0 ? 0 : -tile.pixelX,
    tile.pixelY === 0 ? 0 : -tile.pixelY
  ]
}

export function pdfRenderPixelRatio(devicePixelRatio: number): number {
  const pixelRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1
  return Math.max(MIN_RENDER_PIXEL_RATIO, pixelRatio * RENDER_OVERSAMPLE)
}

export function pdfCanvasLayout(
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number
): PdfCanvasLayout {
  const pixelRatio = pdfRenderPixelRatio(devicePixelRatio)
  const pixelWidth = Math.max(1, Math.ceil(viewportWidth * pixelRatio))
  const pixelHeight = Math.max(1, Math.ceil(viewportHeight * pixelRatio))
  const columns = Math.ceil(pixelWidth / MAX_TILE_PIXEL_DIMENSION)
  const rows = Math.ceil(pixelHeight / MAX_TILE_PIXEL_DIMENSION)
  const tiles: PdfCanvasTile[] = []

  for (let row = 0; row < rows; row += 1) {
    const pixelY = Math.floor(pixelHeight * row / rows)
    const nextPixelY = Math.floor(pixelHeight * (row + 1) / rows)
    for (let column = 0; column < columns; column += 1) {
      const pixelX = Math.floor(pixelWidth * column / columns)
      const nextPixelX = Math.floor(pixelWidth * (column + 1) / columns)
      const tilePixelWidth = nextPixelX - pixelX
      const tilePixelHeight = nextPixelY - pixelY
      tiles.push({
        cssHeight: tilePixelHeight / pixelRatio,
        cssWidth: tilePixelWidth / pixelRatio,
        cssX: pixelX / pixelRatio,
        cssY: pixelY / pixelRatio,
        pixelHeight: tilePixelHeight,
        pixelWidth: tilePixelWidth,
        pixelX,
        pixelY
      })
    }
  }

  return {
    pixelRatio,
    tiles
  }
}
