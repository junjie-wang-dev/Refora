import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MARKDOWN_COMPONENTS,
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
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
})
