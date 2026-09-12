import { describe, expect, it } from 'vitest'
import { latexDiagnostics, latexFileTree, latexOutline } from '../../src/renderer/components/latex/latexNavigation'

describe('LaTeX navigation', () => {
  it('finds starred sections and subsections while ignoring comments', () => {
    expect(latexOutline('% \\section{Hidden}\n\\section{Introduction}\n\\subsection*{Setup}\n\\section[Short]{Full title}')).toEqual([
      { title: 'Introduction', line: 2, level: 1 },
      { title: 'Setup', line: 3, level: 2 },
      { title: 'Full title', line: 4, level: 1 }
    ])
  })
  it('retains complete paths when grouping nested source files', () => {
    const tree = latexFileTree(['main.tex', 'chapters/intro.tex', 'chapters/method/detail.tex'])
    expect(tree.files).toEqual(['main.tex'])
    expect(tree.folders.chapters.files).toEqual(['chapters/intro.tex'])
    expect(tree.folders.chapters.folders.method.files).toEqual(['chapters/method/detail.tex'])
  })
  it('deduplicates build errors and keeps source locations', () => {
    expect(latexDiagnostics('./main.tex:18: Undefined control sequence.\n./main.tex:18: Undefined control sequence.\nchapters/intro.tex:3: Missing $ inserted.')).toEqual([
      { file: 'main.tex', line: 18, message: 'Undefined control sequence.' },
      { file: 'chapters/intro.tex', line: 3, message: 'Missing $ inserted.' }
    ])
  })
})
