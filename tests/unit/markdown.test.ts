import { describe, it, expect } from 'vitest'
import {
  REMARK_PLUGINS,
  REHYPE_PLUGINS,
  urlTransform,
  createMarkdownComponents,
  parseReforaDocLink,
  MARKDOWN_COMPONENTS
} from '../../src/renderer/utils/markdown'

describe('markdown plugin exports', () => {
  it('exports non-empty remark and rehype plugin arrays', () => {
    expect(REMARK_PLUGINS.length).toBeGreaterThan(0)
    expect(REHYPE_PLUGINS.length).toBeGreaterThan(0)
  })
})

describe('document citation locations', () => {
  it('decodes page and quoted evidence while preserving the legacy query', () => {
    expect(parseReforaDocLink('refora://doc/paper?page=3&quote=An+exact%20quotation')).toEqual({
      docId: 'paper', query: 'page=3&quote=An+exact quotation', page: 3, search: 'An exact quotation'
    })
  })

  it('accepts search aliases and legacy bare quotations', () => {
    expect(parseReforaDocLink('refora://doc/paper?search=target+text')?.search).toBe('target text')
    expect(parseReforaDocLink('refora://doc/paper?q=target+text')?.search).toBe('target text')
    expect(parseReforaDocLink('refora://doc/paper?target%20text')?.search).toBe('target text')
  })

  it('ignores invalid pages and empty quotations without turning unknown parameters into a search', () => {
    for (const page of ['0', '-1', '1.5', 'Infinity', '999999999999999999']) {
      expect(parseReforaDocLink(`refora://doc/paper?page=${page}`)?.page).toBeUndefined()
    }
    expect(parseReforaDocLink('refora://doc/paper?quote=+&unused=value')?.search).toBeUndefined()
  })
})

describe('urlTransform', () => {
  it('passes through refora:// urls untouched', () => {
    expect(urlTransform('refora://doc/abc')).toBe('refora://doc/abc')
  })

  it('defers to defaultUrlTransform for normal urls', () => {
    expect(urlTransform("https://example.com")).toBe("https://example.com")
  })

  it('retains validated media sources only in media attributes', () => {
    for (const url of ['refora-asset://asset/picture', 'refora-document://ocr/paper/result/assets/figure.png', 'data:image/png;base64,aGVsbG8=', 'images/figure.png', '/outputs/chart.png']) {
      expect(urlTransform(url, 'src')).toBe(url)
    }
    expect(urlTransform('refora-asset://asset/picture', 'href')).toBe('')
    expect(urlTransform('refora://doc/paper', 'src')).toBe('')
    expect(urlTransform('refora://settings', 'href')).toBe('')
  })

  it('rejects executable media, local file paths, and traversals', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html;base64,aGVsbG8=', 'data:image/svg+xml;base64,aGVsbG8=', 'file:///private/photo.png', 'blob:untrusted', 'images/../secret.png', 'refora-document://ocr/paper/result/assets/%2e%2e/secret.png']) {
      expect(urlTransform(url, 'src')).toBe('')
    }
  })
})

describe('createMarkdownComponents', () => {
  it('returns the base components when no overrides given', () => {
    const comps = createMarkdownComponents()
    expect(comps.pre).toBe(MARKDOWN_COMPONENTS.pre)
    expect(comps.a).toBe(MARKDOWN_COMPONENTS.a)
  })

  it('merges overrides over base components', () => {
    const customPre = () => null
    const comps = createMarkdownComponents({ pre: customPre })
    expect(comps.pre).toBe(customPre)
    expect(comps.a).toBe(MARKDOWN_COMPONENTS.a)
  })

  it('does not mutate the shared base components object', () => {
    const before = { ...MARKDOWN_COMPONENTS }
    createMarkdownComponents({ a: () => null })
    expect(MARKDOWN_COMPONENTS).toEqual(before)
  })
})
