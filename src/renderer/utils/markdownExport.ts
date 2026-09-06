export function markdownDocument(title: string, content: string): string {
  const heading = `# ${title.trim()}`
  return content.trimStart().split('\n')[0].trimEnd() === heading ? content : `${heading}\n\n${content}`
}

export function downloadMarkdown(title: string, content: string): void {
  const url = URL.createObjectURL(new Blob([markdownDocument(title, content)], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${[...title].filter((character) => character.charCodeAt(0) >= 32).join('').replace(/[\\/:*?"<>|]/g, '').trim() || 'document'}.md`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function prepareArticle(article: HTMLElement): Promise<void> {
  for (const media of article.querySelectorAll('.chat-media-card')) media.dispatchEvent(new Event('refora-prepare-media'))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (article.querySelector('[data-markdown-pending="true"]')) {
    await new Promise<void>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (article.querySelector('[data-markdown-pending="true"]')) return
        observer.disconnect()
        window.clearTimeout(timer)
        resolve()
      })
      const timer = window.setTimeout(() => { observer.disconnect(); reject(new Error('Markdown media is still loading')) }, 15000)
      observer.observe(article, { attributes: true, childList: true, subtree: true })
    })
  }
  await document.fonts?.ready
}

export async function exportMarkdownPdf(article: HTMLElement, title: string): Promise<boolean> {
  await prepareArticle(article)
  const clone = article.cloneNode(true) as HTMLElement
  clone.className = 'markdown-body markdown-print-document'
  for (const element of clone.querySelectorAll('.markdown-format-toolbar, .markdown-code-expand, .chat-media-actions, .chat-media-expand')) element.remove()
  for (const button of clone.querySelectorAll('button')) {
    const pictures = Array.from(button.querySelectorAll('img'))
    if (pictures.length) button.replaceWith(...pictures)
    else if (button.hasAttribute('data-markdown-searchable') || button.closest('.chat-media-caption')) {
      const text = document.createElement('span')
      text.textContent = button.textContent
      button.replaceWith(text)
    } else button.remove()
  }
  const targets = Array.from(clone.querySelectorAll<HTMLElement>('[id]'))
  for (const link of clone.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    const href = link.getAttribute('href')!.slice(1)
    let fragment = href
    try { fragment = decodeURIComponent(href) } catch { fragment = href }
    const target = targets.find((element) => [fragment, `markdown-${fragment}`, `user-content-${fragment}`].includes(element.id))
    if (target) link.setAttribute('href', `#${encodeURIComponent(`refora-print-${target.id}`)}`)
  }
  for (const target of targets) target.id = `refora-print-${target.id}`
  for (const image of clone.querySelectorAll('img')) image.loading = 'eager'
  for (const element of clone.querySelectorAll('.markdown-code-collapsed')) element.classList.remove('markdown-code-collapsed')
  document.body.appendChild(clone)
  try {
    await Promise.all(Array.from(clone.querySelectorAll('img'), (image) => image.decode?.().catch(() => undefined)))
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return await window.api.export.markdownPdf(title)
  } finally {
    clone.remove()
  }
}
