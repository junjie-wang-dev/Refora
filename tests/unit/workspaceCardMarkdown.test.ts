import { describe, expect, it } from 'vitest'
import { boardCardPreview, paperCardMarkdown } from '../../src/renderer/utils/workspaceCardMarkdown'
import type { Document } from '../../src/shared/ipc-types'

describe('boardCardPreview', () => {
  it('preserves short card content', () => {
    expect(boardCardPreview('# Title\n\nShort body')).toBe('# Title\n\nShort body')
  })

  it('bounds long Markdown before it reaches the board DOM', () => {
    const content = Array.from({ length: 80 }, (_, index) => `- row ${index} ${'x'.repeat(80)}`).join('\n')
    const preview = boardCardPreview(content)

    expect(preview).toContain('- row 0')
    expect(preview).not.toContain('- row 79')
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.split('\n').length).toBeLessThanOrEqual(30)
    expect(preview.length).toBeLessThanOrEqual(1810)
  })

  it('omits a diagram cut by the line limit instead of rendering invalid Mermaid', () => {
    const content = `# Findings\n\n${'Paragraph\n'.repeat(22)}\n\`\`\`mermaid\ngraph TD\nA --> B\nB --> C\n\`\`\`\n`
    const preview = boardCardPreview(content)
    expect(preview).toContain('# Findings')
    expect(preview).not.toContain('```mermaid')
    expect(preview).not.toContain('graph TD')
    expect(preview.endsWith('…')).toBe(true)
    expect(content).toContain('B --> C')
  })

  it('omits a fenced block cut by the character limit', () => {
    const content = `Intro\n\n~~~mermaid\ngraph TD\nA[${'label'.repeat(400)}] --> B\n~~~`
    const preview = boardCardPreview(content)
    expect(preview).toBe('Intro\n\n…')
    expect(preview.length).toBeLessThanOrEqual(1810)
  })

  it('keeps complete fenced diagrams unchanged before truncating later text', () => {
    const diagram = '```mermaid\ngraph TD\nA --> B\n```'
    const preview = boardCardPreview(`${diagram}\n\n${'More findings\n'.repeat(60)}`)
    expect(preview).toContain(diagram)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('recognizes longer closing fences and avoids closing on shorter or mismatched fences', () => {
    const complete = '~~~~mermaid\ngraph TD\nA --> B\n~~~~~'
    expect(boardCardPreview(`${complete}\n${'text\n'.repeat(40)}`)).toContain(complete)
    const incomplete = `Intro\n\n\`\`\`\`text\ninner\n\`\`\`\n~~~\n${'code\n'.repeat(40)}\`\`\`\``
    expect(boardCardPreview(incomplete)).toBe('Intro\n\n…')
  })

  it('preserves original short incomplete fences and ordinary indented code', () => {
    const original = '```mermaid\ngraph TD'
    expect(boardCardPreview(original)).toBe(original)
    const indented = `    \`\`\`\n${'body\n'.repeat(40)}`
    expect(boardCardPreview(indented)).toContain('    ```')
  })

})

describe('paperCardMarkdown', () => {
  it('writes authors with given names first', () => {
    const doc = {
      title: 'Paper',
      fileName: 'paper.pdf',
      authors: 'Lin, Ming C.; Qiao, Yi-Ling'
    } as Document

    expect(paperCardMarkdown(doc, null)).toContain(
      '- **Authors:** Ming C. Lin; Yi-Ling Qiao'
    )
  })
})
