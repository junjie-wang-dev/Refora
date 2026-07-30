const MAX_CANVAS_PIXELS = 2 ** 25
const MAX_CANVAS_DIMENSION = 32767

export interface PdfCanvasLayout {
  width: number
  height: number
  scaleX: number
  scaleY: number
}

export function pdfCanvasLayout(
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number
): PdfCanvasLayout {
  const pixelRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1
  const outputScale = Math.min(
    pixelRatio,
    Math.sqrt(MAX_CANVAS_PIXELS / (viewportWidth * viewportHeight)),
    MAX_CANVAS_DIMENSION / viewportWidth,
    MAX_CANVAS_DIMENSION / viewportHeight
  )
  const roundDimension = outputScale < pixelRatio ? Math.floor : Math.round
  const width = Math.max(1, roundDimension(viewportWidth * outputScale))
  const height = Math.max(1, roundDimension(viewportHeight * outputScale))

  return {
    width,
    height,
    scaleX: width / viewportWidth,
    scaleY: height / viewportHeight
  }
}
