import { expect, it } from 'vitest'
import { pdfToSource, sourceToPdf } from '../../src/renderer/components/latex/latexSync'
import type { LatexSyncMap } from '../../src/shared/latex-types'

const map: LatexSyncMap = {
  sourceHashes: { 'main.tex': 'main', 'sections/results.tex': 'results' },
  boxes: [
    { path: 'main.tex', line: 5, page: 1, x: 20, y: 20, width: 100, height: 12 },
    { path: 'sections/results.tex', line: 10, page: 2, x: 20, y: 30, width: 100, height: 12 },
    { path: 'sections/results.tex', line: 10, page: 2, x: 20, y: 50, width: 100, height: 12 },
  ]
}
it('locates the nearest source line in the right file and PDF page', () => {
  expect(sourceToPdf(map, 'sections/results.tex', 9)).toEqual(map.boxes[1])
  expect(sourceToPdf(map, 'uncompiled.tex', 5)).toBeUndefined()
})
it('locates the source of a clicked PDF rectangle and nearby whitespace', () => {
  expect(pdfToSource(map, 2, 60, 55)).toEqual(map.boxes[2])
  expect(pdfToSource(map, 2, 60, 47)).toEqual(map.boxes[2])
  expect(pdfToSource(map, 3, 60, 55)).toBeUndefined()
})
it('prefers a specific text box over its containing block', () => {
  const larger = { ...map.boxes[0], line: 2, width: 200, height: 100 }
  expect(pdfToSource({ ...map, boxes: [larger, ...map.boxes] }, 1, 40, 25)).toEqual(map.boxes[0])
})
