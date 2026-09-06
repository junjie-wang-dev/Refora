import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MARKDOWN_COMPONENTS,
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  createReforaDocMarkdownComponents,
  urlTransform
} from '../../src/renderer/utils/markdown'
import { initI18n } from '../../src/renderer/i18n'

const writeText = vi.fn()

initI18n('en')

describe('Markdown rendering', () => {
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders safe external links', () => {
    render(
      <ReactMarkdown components={MARKDOWN_COMPONENTS} urlTransform={urlTransform}>
        {'[Open paper](https://example.com/paper)'}
      </ReactMarkdown>
    )

    expect(screen.getByRole('link', { name: 'Open paper' })).toMatchObject({
      target: '_blank',
      rel: 'noopener noreferrer'
    })
  })

  it('passes citation locations through sanitized Markdown to the embedded reader', async () => {
    const openDocument = vi.fn().mockResolvedValue(undefined)
    render(
      <ReactMarkdown
        components={createReforaDocMarkdownComponents(openDocument)}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={urlTransform}
      >
        {'[Evidence](refora://doc/paper?page=3&quote=Exact%20evidence)'}
      </ReactMarkdown>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Evidence' }))
    })
    expect(openDocument).toHaveBeenCalledWith('paper', {
      forceBuiltin: true, page: 3, search: 'Exact evidence'
    })
  })

  it('copies fenced code and resets its copied state', async () => {
    vi.useFakeTimers()
    render(
      <ReactMarkdown
        components={MARKDOWN_COMPONENTS}
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
      >
        {'```ts\nconst answer = 42\n```'}
      </ReactMarkdown>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('const answer = 42\n')

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  })

  it('keeps linked image controls outside external navigation links', async () => {
    const resolver = vi.spyOn(window.api.ai, 'resolveMedia').mockResolvedValue({
      id: 'a'.repeat(64), url: `refora-asset://media/${'a'.repeat(64)}`, kind: 'image',
      fileName: 'figure.png', mimeType: 'image/png', byteLength: 200
    })
    const { container } = render(<ReactMarkdown
      components={createReforaDocMarkdownComponents(vi.fn())}
      remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} urlTransform={urlTransform}
    >{'[![Figure](refora-asset://asset/figure)](https://example.com/source)'}</ReactMarkdown>)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('a button')).toBeNull()
    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute('href', 'https://example.com/source')
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge Figure' }))
    expect(screen.getByRole('dialog', { name: 'Figure' })).toBeInTheDocument()
    resolver.mockRestore()
  })

  it('navigates duplicate and Unicode headings within the current document', () => {
    const source = '# Results\n\n# Results\n\n# 研究结果\n\n[Second](#results-1) [中文](#研究结果)'
    const { container } = render(<><div className="markdown-body"><ReactMarkdown components={MARKDOWN_COMPONENTS} rehypePlugins={REHYPE_PLUGINS}>{source}</ReactMarkdown></div><div className="markdown-body"><ReactMarkdown components={MARKDOWN_COMPONENTS} rehypePlugins={REHYPE_PLUGINS}>{source}</ReactMarkdown></div></>)
    const documents = container.querySelectorAll('.markdown-body')
    const target = documents[1].querySelectorAll('h1')[1]
    const scroll = vi.fn()
    Object.defineProperty(target, 'scrollIntoView', { value: scroll })
    const link = documents[1].querySelector('a')!
    expect(link).not.toHaveAttribute('target')
    fireEvent.click(link)
    expect(target.id).toBe('markdown-results-1')
    expect(target).toHaveAttribute('data-source-offset', '11')
    expect(scroll).toHaveBeenCalled()
    expect(document.activeElement).toBe(target)
    expect(documents[1].querySelectorAll('h1')[2].id).toBe('markdown-研究结果')
  })

  it('preserves footnote ids and navigates to a footnote and back', () => {
    const { container } = render(<div className="markdown-body"><ReactMarkdown components={createReforaDocMarkdownComponents(vi.fn())} remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{'Evidence[^1]\n\n[^1]: The source.'}</ReactMarkdown></div>)
    const reference = container.querySelector<HTMLAnchorElement>('a[data-footnote-ref]')!
    const back = container.querySelector<HTMLAnchorElement>('a[data-footnote-backref]')!
    const note = container.querySelector('li')!
    Object.defineProperty(note, 'scrollIntoView', { value: vi.fn() })
    Object.defineProperty(reference, 'scrollIntoView', { value: vi.fn() })
    expect(reference).not.toHaveAttribute('target')
    fireEvent.click(reference)
    expect(document.activeElement).toBe(note)
    fireEvent.click(back)
    expect(document.activeElement).toBe(reference)
    expect(container.querySelector('.footnotes h2')).toHaveAttribute('id', reference.getAttribute('aria-describedby'))
  })

  it('keeps code literals in Markdown and HTML tables while rendering ordinary table math', () => {
    const { container } = render(<ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{'| Code | Formula |\n| --- | --- |\n| `$value$` | $x^2$ |\n\n<table><tr><td><code>$literal$</code></td><td>$y^2$</td></tr></table>'}</ReactMarkdown>)
    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(screen.getByText('$value$', { selector: 'code' })).toBeInTheDocument()
    expect(screen.getByText('$literal$', { selector: 'code' })).toBeInTheDocument()
  })


  it('retains source offsets on paragraphs, lists and code blocks for editor positioning', () => {
    const source = '# Title\n\nFirst paragraph.\n\n- item\n\n```text\ncode\n```'
    const { container } = render(<ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>{source}</ReactMarkdown>)
    expect(container.querySelector('p')).toHaveAttribute('data-source-offset', String(source.indexOf('First')))
    expect(container.querySelector('li')).toHaveAttribute('data-source-offset', String(source.indexOf('- item')))
    expect(container.querySelector('.markdown-code-block')).toHaveAttribute('data-source-offset', String(source.indexOf('```')))
  })

})
