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
})
