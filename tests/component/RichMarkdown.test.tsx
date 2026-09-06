import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../src/renderer/i18n'
import { MarkdownCodeBlock, MarkdownTable } from '../../src/renderer/components/markdown/RichMarkdown'
import { REHYPE_PLUGINS, REMARK_PLUGINS } from '../../src/renderer/utils/markdown'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), parse: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))

initI18n('en')

function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={{ pre: MarkdownCodeBlock, table: MarkdownTable }}>{children}</ReactMarkdown>
}

describe('rich Markdown', () => {
  const writeText = vi.fn()

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mermaid.parse.mockReset().mockResolvedValue({ diagramType: 'flowchart' })
    mermaid.render.mockReset().mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Safe diagram</text></svg>' })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('labels and highlights fenced code while escaping HTML', async () => {
    const { container } = render(<Markdown>{'```javascript\nconst value = "<img src=x onerror=alert(1)>"\n```'}</Markdown>)
    expect(screen.getByText('javascript')).toBeInTheDocument()
    expect(container.querySelector('.hljs-keyword')).toHaveTextContent('const')
    expect(container.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const value = "<img src=x onerror=alert(1)>"\n'))
  })

  it('expands long code and reports clipboard failure without losing code', async () => {
    writeText.mockRejectedValue(new Error('Clipboard unavailable'))
    render(<Markdown>{`\`\`\`unknown\n${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n\`\`\``}</Markdown>)
    const expand = screen.getByRole('button', { name: 'Show full code' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(expand)
    expect(screen.getByRole('button', { name: 'Collapse code' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Copy failed')
  })

  it('renders a safe diagram and can reveal the original source', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><iframe src="https://evil.test"></iframe></foreignObject><a href="javascript:alert(1)"><text>safe</text></a><text>Diagram</text></svg>' })
    render(<Markdown>{'```mermaid\ngraph TD\nA --> B\n```'}</Markdown>)
    expect(screen.getByRole('status')).toHaveTextContent('Preparing diagram')
    const diagram = await screen.findByRole('img', { name: 'Mermaid diagram' })
    const source = decodeURIComponent(diagram.getAttribute('src')!.split(',').slice(1).join(','))
    expect(source).toContain('Diagram')
    expect(source).not.toMatch(/script|onload|foreignObject|iframe|href=/)
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Show diagram source' }))
    expect(screen.getByText(/graph TD/)).toHaveTextContent('A --> B')
    expect(document.querySelector('.markdown-diagram-render-container')).toBeNull()
  })

  it('retains source for invalid streamed diagrams and recovers when syntax completes', async () => {
    mermaid.parse.mockRejectedValueOnce(new Error('Incomplete syntax'))
    const { rerender } = render(<Markdown>{'```mermaid\ngraph TD\nA -->\n```'}</Markdown>)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Diagram preview is unavailable'))
    expect(screen.getByText(/graph TD/)).toBeInTheDocument()
    rerender(<Markdown>{'```mermaid\ngraph TD\nA --> B\n```'}</Markdown>)
    expect(await screen.findByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
  })

  it('does not run diagram directives that change its security configuration', async () => {
    render(<Markdown>{'```mermaid\n%%{init: { "securityLevel": "loose" }}%%\ngraph TD\nA --> B\n```'}</Markdown>)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Diagram preview is unavailable'))
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it('copies table data, exports CSV, and expands the table with keyboard dismissal', async () => {
    const makeUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:table')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const { container } = render(<Markdown>{'| Paper | Score |\n| --- | --- |\n| **A** | 1 |\n| B | 2 |'}</Markdown>)
    expect(screen.getByRole('region', { name: 'Table' })).toHaveAttribute('tabindex', '0')
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Paper\tScore\nA\t1\nB\t2'))
    fireEvent.click(screen.getByRole('button', { name: 'Export table as CSV' }))
    expect(makeUrl).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalled()
    const expand = screen.getByRole('button', { name: 'Expand table' })
    expand.focus()
    fireEvent.click(expand)
    const dialog = screen.getByRole('dialog', { name: 'Expanded table' })
    expect(within(dialog).getByRole('table')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(expand)
    expect(container.querySelectorAll('table')).toHaveLength(1)
  })

  it('keeps inline, display, and table math rendering with accessible copied notation', async () => {
    const { container } = render(<Markdown>{'$x^2$\n\n$$y = x + 1$$\n\n| Formula |\n| --- |\n| $z^2$ |'}</Markdown>)
    expect(container.querySelectorAll('.katex')).toHaveLength(3)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy table' })))
    expect(writeText).toHaveBeenCalledWith('Formula\nz^2')
  })
})
