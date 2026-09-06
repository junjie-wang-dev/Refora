import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportMarkdownPdf, markdownDocument } from '../../src/renderer/utils/markdownExport'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function article(content: string): HTMLElement {
  const element = document.createElement('article')
  element.innerHTML = content
  document.body.appendChild(element)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  return element
}

describe('Markdown export', () => {
  it('keeps an existing matching title without duplicating it', () => {
    expect(markdownDocument('Title', '# Title\n\nBody')).toBe('# Title\n\nBody')
    expect(markdownDocument('Title', 'Body')).toBe('# Title\n\nBody')
  })

  it('preserves diagram images and document citations while removing controls', async () => {
    const source = article('<h2 id="markdown-results">Results</h2><a href="#results">Jump</a><div class="markdown-format-toolbar"><button>Copy</button></div><button><img src="data:image/png;base64,AA==" alt="Diagram"/><span>Enlarge</span></button><button data-markdown-searchable>Evidence</button><pre class="markdown-code-collapsed">Full code</pre>')
    const print = vi.spyOn(window.api.export, 'markdownPdf').mockImplementation(async (title) => {
      expect(title).toBe('Paper')
      const clone = document.querySelector('.markdown-print-document')!
      expect(clone.querySelector('a')).toHaveAttribute('href', '#refora-print-markdown-results')
      expect(clone.querySelector('h2')).toHaveAttribute('id', 'refora-print-markdown-results')
      expect(clone.querySelector('img')).toHaveAttribute('alt', 'Diagram')
      expect(clone).toHaveTextContent('Evidence')
      expect(clone.querySelector('button')).toBeNull()
      expect(clone.querySelector('.markdown-code-collapsed')).toBeNull()
      expect(clone).not.toHaveTextContent('Enlarge')
      return true
    })
    expect(await exportMarkdownPdf(source, 'Paper')).toBe(true)
    expect(print).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.markdown-print-document')).toBeNull()
    expect(source.querySelectorAll('button')).toHaveLength(3)
  })

  it('waits for offscreen local media before taking the print snapshot', async () => {
    const source = article('<span class="chat-media-card" data-markdown-pending="true">Loading</span>')
    const media = source.querySelector('.chat-media-card')!
    media.addEventListener('refora-prepare-media', () => {
      window.setTimeout(() => {
        media.innerHTML = '<button><img alt="Loaded image" /></button>'
        media.removeAttribute('data-markdown-pending')
      }, 5)
    })
    vi.spyOn(window.api.export, 'markdownPdf').mockImplementation(async () => {
      expect(document.querySelector('.markdown-print-document img')).toHaveAttribute('alt', 'Loaded image')
      expect(document.querySelector('.markdown-print-document')).not.toHaveTextContent('Loading')
      return true
    })
    await exportMarkdownPdf(source, 'Media')
  })

  it('removes print-only content after a native export failure', async () => {
    const source = article('<p>Body</p>')
    vi.spyOn(window.api.export, 'markdownPdf').mockRejectedValue(new Error('Unavailable'))
    await expect(exportMarkdownPdf(source, 'Paper')).rejects.toThrow('Unavailable')
    expect(document.querySelector('.markdown-print-document')).toBeNull()
    expect(source).toHaveTextContent('Body')
  })
})
