import { createRef, useRef } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReactMarkdown from 'react-markdown'
import MarkdownNavigation from '../../src/renderer/components/markdown/MarkdownNavigation'
import { MARKDOWN_COMPONENTS, REHYPE_PLUGINS, REMARK_PLUGINS } from '../../src/renderer/utils/markdown'
import i18n, { initI18n } from '../../src/renderer/i18n'

initI18n('en')

class TestHighlight extends Set<Range> {
  constructor(...ranges: Range[]) { super(ranges) }
}

function Reader({ content, findOpen = true, outlineOpen = false, onNavigate = vi.fn(), onCloseFind = vi.fn() }: { content: string; findOpen?: boolean; outlineOpen?: boolean; onNavigate?: (offset: number) => void; onCloseFind?: () => void }) {
  const articleRef = useRef<HTMLElement>(null)
  return <>
    <article ref={articleRef} className="markdown-body"><ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{content}</ReactMarkdown></article>
    <MarkdownNavigation articleRef={articleRef} content={content} findOpen={findOpen} outlineOpen={outlineOpen} onCloseFind={onCloseFind} onCloseOutline={vi.fn()} onNavigate={onNavigate} />
  </>
}

describe('Markdown document navigation', () => {
  let highlights: Map<string, TestHighlight>
  beforeEach(() => {
    highlights = new Map()
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', TestHighlight)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView') })

  const search = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: i18n.t('markdown.findDocument') }), { target: { value } })
  const matches = () => [...(highlights.get('markdown-find') ?? [])]
  const active = () => [...(highlights.get('markdown-find-active') ?? [])][0]

  it('matches text across inline formatting without changing the rendered DOM', () => {
    const { container } = render(<Reader content={'A **strong** result. Another strong result.'} />)
    const article = container.querySelector('article')!
    const original = article.innerHTML
    search('strong result')
    expect(matches()).toHaveLength(2)
    expect(matches().map((range) => range.toString())).toEqual(['strong result', 'strong result'])
    expect(matches()[0].startContainer.parentElement?.tagName).toBe('STRONG')
    expect(article.innerHTML).toBe(original)
    expect(screen.getByRole('status')).toHaveTextContent('1 / 2')
  })

  it('cycles next and previous matches with buttons and keyboard, then dismisses find', () => {
    const close = vi.fn()
    render(<Reader content={'One target and another target.'} onCloseFind={close} />)
    search('target')
    const first = active()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('markdown.nextMatch') }))
    expect(active()).not.toBe(first)
    expect(screen.getByRole('status')).toHaveTextContent('2 / 2')
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(active()).toBe(first)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('2 / 2')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('markdown.previousMatch') }))
    expect(active()).toBe(first)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('preserves Unicode offsets and treats punctuation literally', () => {
    render(<Reader content={'İstanbul has a TARGET and (x+y).'} />)
    search('target')
    expect(matches()[0].toString()).toBe('TARGET')
    search('(x+y)')
    expect(matches()[0].toString()).toBe('(x+y)')
  })

  it('avoids false matches across blocks and line breaks and ignores toolbar labels', () => {
    render(<Reader content={'first\n\nsecond\n\nline<br />break\n\n```text\nvaluable\n```'} />)
    search('firstsecond')
    expect(matches()).toHaveLength(0)
    search('linebreak')
    expect(matches()).toHaveLength(0)
    search('Copy')
    expect(matches()).toHaveLength(0)
    search('valuable')
    expect(matches()).toHaveLength(1)
  })

  it('uses actual heading ids and offsets, excludes hidden footnote labels, and navigates scoped headings', () => {
    const navigate = vi.fn()
    const { container } = render(<Reader content={'# Results\n\n## Results\n\n### 研究结果\n\nEvidence[^1]\n\n[^1]: source'} outlineOpen onNavigate={navigate} />)
    const outline = screen.getByRole('navigation', { name: i18n.t('markdown.outline') })
    expect(within(outline).queryByText('Footnotes')).toBeNull()
    fireEvent.click(within(outline).getAllByRole('button', { name: 'Results' })[1])
    expect(navigate).toHaveBeenLastCalledWith(11)
    const target = container.querySelector('h2#markdown-results-1')!
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
    fireEvent.click(within(outline).getByRole('button', { name: '研究结果' }))
    expect(navigate).toHaveBeenLastCalledWith(23)
  })

  it('does not let a closed navigation instance clear another document highlights', () => {
    const { rerender } = render(<Reader content="A target" />)
    search('target')
    const first = active()
    const closed = render(<MarkdownNavigation articleRef={createRef()} content="" findOpen={false} outlineOpen={false} onCloseFind={vi.fn()} onCloseOutline={vi.fn()} />)
    expect(active()).toBe(first)
    closed.unmount()
    expect(active()).toBe(first)
    rerender(<Reader content="A target" findOpen={false} />)
    expect(highlights.size).toBe(0)
  })
})
