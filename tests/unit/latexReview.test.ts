import { expect, it } from 'vitest'
import { latexAiPrompt } from '../../src/renderer/components/latex/latexReview'

it('includes only the selection, exact project and file, instructions, and its source line', () => {
  const content = 'Private preceding text\nSelected $x$ and \\cite{one}\nPrivate following text'
  const selected = 'Selected $x$ and \\cite{one}'
  const start = content.indexOf(selected)
  const prompt = latexAiPrompt('parts/main.tex', content, start, start + selected.length, 'Make this concise')
  expect(prompt).toContain('Make this concise')
  expect(prompt).toContain('parts/main.tex:2-2')
  expect(prompt).toContain(selected)
  expect(prompt).not.toContain('Private')
  expect(prompt).not.toContain('propose edits for my review')
  expect(prompt).not.toContain('project-id')
})

it('quotes source containing markdown fences without closing the selection early', () => {
  const prompt = latexAiPrompt('main.tex', '```latex\nText', 0, 13, 'Proofread')
  expect(prompt).toContain('````latex\n```latex\nText\n````')
})


it('uses the last selected source line when a multiline selection ends in a newline', () => {
  expect(latexAiPrompt('main.tex', 'Header\nFirst\nSecond\nTail', 7, 20, 'Proofread')).toContain('main.tex:2-3')
})
