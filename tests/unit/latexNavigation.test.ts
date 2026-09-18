import { describe, expect, it } from 'vitest'
import { latexDiagnostics, latexFileTree, latexOutline, latexProjectOutline } from '../../src/renderer/components/latex/latexNavigation'

describe('LaTeX navigation', () => {
  it('finds starred sections and subsections while ignoring comments', () => {
    expect(latexOutline('% \\section{Hidden}\n\\section{Introduction}\n\\subsection*{Setup}\n\\section[Short]{Full title}')).toEqual([
      { title: 'Introduction', line: 2, level: 1 },
      { title: 'Setup', line: 3, level: 2 },
      { title: 'Full title', line: 4, level: 1 }
    ])
  })
  it('parses multiline and nested titles without verbatim or commented commands', () => {
    expect(latexOutline(String.raw`\begin{verbatim}
\section{Example}
\end{verbatim}
\section{
A \emph{nested {title}}
}
% \section{Comment}
\verb|\section{Inline}|
\subsection{Real}`)).toEqual([
      { title: 'A nested title', line: 4, level: 1 },
      { title: 'Real', line: 9, level: 2 }
    ])
  })
  it('does not treat a commented environment as a real verbatim block', () => {
    expect(latexOutline('% \\begin{verbatim}\n\\section{Visible}\n% \\end{verbatim}')).toEqual([{ title: 'Visible', line: 2, level: 1 }])
  })
  it('follows includes in document order and prevents recursive includes', () => {
    expect(latexProjectOutline([
      { path: 'main.tex', content: '\\section{First}\n\\input{chapters/intro}\n\\section{Last}' },
      { path: 'chapters/intro.tex', content: '\\subsection{Included}\n\\input{main}' }
    ], 'main.tex')).toEqual([
      { file: 'main.tex', title: 'First', line: 1, level: 1 },
      { file: 'chapters/intro.tex', title: 'Included', line: 1, level: 2 },
      { file: 'main.tex', title: 'Last', line: 3, level: 1 }
    ])
  })
  it('normalizes nested includes within the project without resolving paths outside it', () => {
    expect(latexProjectOutline([
      { path: 'chapters/part/main.tex', content: '\\section{First}\n\\input{../../shared/./intro}\n\\input{../../../outside}\n\\section{Last}' },
      { path: 'shared/intro.tex', content: '\\subsection{Shared}\n\\input{../chapters/part/main}' }
    ], 'chapters/part/main.tex').map((heading) => heading.title)).toEqual(['First', 'Shared', 'Last'])
  })
  it('classifies template errors and unlocated warnings without inventing file locations', () => {
    expect(latexDiagnostics(String.raw`./template.cls:12: Undefined control sequence.
./custom.sty:8: LaTeX Warning: Test warning.
LaTeX Warning: Citation 'missing' on page 1 undefined on input line 23.
Overfull \hbox (4pt too wide) in paragraph at lines 30--31
! Emergency stop.
l.42 \end{document}`)).toEqual([
      { file: 'template.cls', line: 12, message: 'Undefined control sequence.', severity: 'error' },
      { file: 'custom.sty', line: 8, message: 'LaTeX Warning: Test warning.', severity: 'warning' },
      { line: 23, message: "LaTeX Warning: Citation 'missing' on page 1 undefined on input line 23.", severity: 'warning' },
      { line: 30, message: 'Overfull \\hbox (4pt too wide) in paragraph at lines 30--31', severity: 'warning' },
      { line: 42, message: 'Emergency stop.', severity: 'error' }
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
      { file: 'main.tex', line: 18, message: 'Undefined control sequence.', severity: 'error' },
      { file: 'chapters/intro.tex', line: 3, message: 'Missing $ inserted.', severity: 'error' }
    ])
  })
})
