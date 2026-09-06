import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StructuredDocumentPanel from '../../src/renderer/components/StructuredDocumentPanel'
import { useOcrReaderStore } from '../../src/renderer/store/ocrReaderStore'
import { downloadMarkdown, exportMarkdownPdf } from '../../src/renderer/utils/markdownExport'
import type { ReforaApi } from '../../src/shared/ipc-types'

vi.mock('../../src/renderer/utils/markdownExport', async (original) => ({ ...await original<typeof import('../../src/renderer/utils/markdownExport')>(), downloadMarkdown: vi.fn(), exportMarkdownPdf: vi.fn().mockResolvedValue(true) }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const api = (window as unknown as { api: ReforaApi }).api

describe('StructuredDocumentPanel', () => {
  beforeEach(() => {
    api.ocr.readMarkdown = vi.fn().mockResolvedValue(
      '![Figure](images/figure.png)\n\n[Source](https://example.com/images/page)'
    )
    api.ocr.assetUrl = vi.fn((_documentId, _resultKey, assetPath) =>
      `refora-document://ocr/doc-1/key-1/${assetPath}`)
    useOcrReaderStore.getState().open('doc-1', 'key-1', 'Paper')
  })

  afterEach(() => {
    cleanup()
    useOcrReaderStore.getState().close()
    vi.restoreAllMocks()
  })

  it('maps only MinerU image paths to managed assets', async () => {
    render(<StructuredDocumentPanel />)

    const image = await screen.findByAltText('Figure')
    expect(image.getAttribute('src')).toBe(
      'refora-document://ocr/doc-1/key-1/assets/figure.png'
    )
    expect(api.ocr.assetUrl).toHaveBeenCalledWith('doc-1', 'key-1', 'assets/figure.png')
    expect(screen.getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      'https://example.com/images/page'
    )
  })

  it('renders sanitized HTML tables and superscripts from MinerU Markdown', async () => {
    api.ocr.readMarkdown = vi.fn().mockResolvedValue(
      'kHWC<sup>2</sup>\n\n<table><tbody><tr><th>Metric</th><th colspan="2">$v \\leq 5\\,m/s$</th></tr><tr><td>LRCP</td><td>78.7</td><td>78.2</td></tr></tbody></table><iframe title="unsafe"></iframe><script>window.hacked = true</script>'
    )

    const { container } = render(<StructuredDocumentPanel />)

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.getByText('2').tagName).toBe('SUP')
    expect(container.querySelector('th[colspan="2"]')).not.toBeNull()
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('finds within the OCR document using Cmd+F and the routed native event', async () => {
    api.ocr.readMarkdown = vi.fn().mockResolvedValue('# Findings\n\nAlpha alpha')
    const { container } = render(<StructuredDocumentPanel />)
    await screen.findByRole('heading', { name: 'Findings' })
    const surface = container.querySelector('[data-markdown-surface]')!
    fireEvent.keyDown(surface, { key: 'f', metaKey: true })
    const input = screen.getByRole('textbox', { name: 'markdown.findDocument' })
    await waitFor(() => expect(input).toHaveFocus())
    fireEvent.change(input, { target: { value: 'alpha' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'markdown.nextMatch' })).not.toBeDisabled())
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(input).not.toHaveFocus()
    act(() => surface.dispatchEvent(new Event('refora-markdown-find')))
    expect(screen.getByRole('search')).toBeInTheDocument()
  })

  it('keeps the wide outline sidebar open when navigating between sections', async () => {
    api.ocr.readMarkdown = vi.fn().mockResolvedValue('# Findings\n\n## Results\n\nBody')
    render(<StructuredDocumentPanel />)
    await screen.findByRole('heading', { name: 'Results' })
    fireEvent.click(screen.getByRole('button', { name: 'markdown.outline' }))
    expect(screen.getByRole('navigation', { name: 'markdown.outline' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Results' }))
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'markdown.closeOutline' }))
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('copies and exports the current OCR Markdown and renders PDF from the article', async () => {
    api.ocr.readMarkdown = vi.fn().mockResolvedValue('# Findings\n\nBody')
    const writeText = vi.spyOn(api.clipboard, 'writeText').mockResolvedValue()
    render(<StructuredDocumentPanel />)
    await screen.findByRole('heading', { name: 'Findings' })
    fireEvent.click(screen.getByRole('button', { name: 'markdown.copyMarkdown' }))
    expect(writeText).toHaveBeenCalledWith('# Paper\n\n# Findings\n\nBody')
    fireEvent.click(screen.getByRole('button', { name: 'markdown.exportMarkdown' }))
    expect(downloadMarkdown).toHaveBeenCalledWith('Paper', '# Findings\n\nBody')
    fireEvent.click(screen.getByRole('button', { name: 'markdown.exportPdf' }))
    await waitFor(() => expect(exportMarkdownPdf).toHaveBeenCalledWith(screen.getByRole('article'), 'Paper'))
  })

  it('restores OCR reading position when reopened', async () => {
    api.ocr.readMarkdown = vi.fn().mockResolvedValue('# Findings\n\nBody')
    const first = render(<StructuredDocumentPanel />)
    await screen.findByRole('heading', { name: 'Findings' })
    const scroll = first.container.querySelector('.markdown-reading-scroll')!
    fireEvent.scroll(scroll, { target: { scrollTop: 340 } })
    first.unmount()
    const second = render(<StructuredDocumentPanel />)
    await screen.findByRole('heading', { name: 'Findings' })
    expect(second.container.querySelector('.markdown-reading-scroll')?.scrollTop).toBe(340)
  })

})
