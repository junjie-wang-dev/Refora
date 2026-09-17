import type { LatexSyncBox, LatexSyncMap } from '../../../shared/latex-types'

export function sourceToPdf(map: LatexSyncMap, path: string, line: number): LatexSyncBox | undefined {
  return map.boxes.filter((box) => box.path === path).sort((a, b) =>
    Math.abs(a.line - line) - Math.abs(b.line - line) || a.page - b.page || a.y - b.y || a.x - b.x
  )[0]
}

export function pdfToSource(map: LatexSyncMap, page: number, x: number, y: number): LatexSyncBox | undefined {
  const distance = (box: LatexSyncBox) => {
    const dx = Math.max(box.x - x, 0, x - box.x - box.width)
    const dy = Math.max(box.y - y, 0, y - box.y - box.height)
    return dx * dx + dy * dy
  }
  return map.boxes.filter((box) => box.page === page).sort((a, b) =>
    distance(a) - distance(b) || a.width * a.height - b.width * b.height
  )[0]
}
