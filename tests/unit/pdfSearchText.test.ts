import { describe, expect, it } from 'vitest'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import {
  findPdfPageMatches,
  normalizePdfSearchQuery,
  searchablePdfPage
} from '../../src/renderer/utils/pdfSearchText'

function item(str: string, x = 0, y = 100, extra: Partial<TextItem> = {}): TextItem {
  return {
    str,
    dir: 'ltr',
    transform: [10, 0, 0, 10, x, y],
    width: str.length * 5,
    height: 10,
    fontName: 'test',
    hasEOL: false,
    ...extra
  }
}

function search(items: TextItem[], query: string) {
  return findPdfPageMatches(3, searchablePdfPage(items), normalizePdfSearchQuery(query))
}

describe('PDF text search normalization', () => {
  it('finds a word divided into touching text items and maps its original fragments', () => {
    expect(search([item('trans'), item('former', 25)], 'TRANSFORMER')).toEqual([{
      page: 3,
      fragments: [
        { itemIndex: 0, start: 0, end: 5 },
        { itemIndex: 1, start: 0, end: 6 }
      ]
    }])
  })

  it('keeps separate words apart using their geometry', () => {
    const items = [item('deep'), item('learning', 23)]
    expect(search(items, 'deeplearning')).toEqual([])
    expect(search(items, 'deep learning')).toHaveLength(1)
  })

  it('joins adjacent CJK fragments and line wraps without inserting Latin spaces', () => {
    const items = [item('研'), item('究', 5, 100, { hasEOL: true }), item('方', 0, 88), item('法', 5, 88)]
    expect(search(items, '研究方法')[0].fragments).toEqual([
      { itemIndex: 0, start: 0, end: 1 },
      { itemIndex: 1, start: 0, end: 1 },
      { itemIndex: 2, start: 0, end: 1 },
      { itemIndex: 3, start: 0, end: 1 }
    ])
  })

  it('preserves explicit space items and collapses whitespace in the query and source', () => {
    const items = [item('neural'), item('  \u00a0', 30), item('network', 45)]
    expect(search(items, 'neuralnetwork')).toEqual([])
    expect(search(items, '  neural\n  network  ')[0].fragments).toEqual([
      { itemIndex: 0, start: 0, end: 6 },
      { itemIndex: 1, start: 0, end: 1 },
      { itemIndex: 2, start: 0, end: 7 }
    ])
  })

  it('removes a line-end hyphen while leaving source offsets intact', () => {
    const items = [item('a trans-', 0, 100, { hasEOL: true }), item('former model', 0, 88)]
    expect(search(items, 'transformer')[0].fragments).toEqual([
      { itemIndex: 0, start: 2, end: 7 },
      { itemIndex: 1, start: 0, end: 6 }
    ])
    expect(search([item('well-known')], 'wellknown')).toEqual([])
    expect(search([item('well-known')], 'well-known')).toHaveLength(1)
  })

  it('recognizes an empty end-of-line item and geometrically detected line ends', () => {
    expect(search([item('trans-'), item('', 30, 100, { hasEOL: true }), item('former')], 'transformer')).toHaveLength(1)
    expect(search([item('trans-'), item('former', 0, 88)], 'transformer')).toHaveLength(1)
    expect(search([item('neural'), item('network', 0, 88)], 'neural network')).toHaveLength(1)
  })

  it('recognizes a hyphen emitted as its own item at a line boundary', () => {
    const items = [item('trans'), item('-', 25, 100, { hasEOL: true }), item('former', 0, 88)]
    expect(search(items, 'transformer')[0].fragments).toEqual([
      { itemIndex: 0, start: 0, end: 5 },
      { itemIndex: 2, start: 0, end: 6 }
    ])
    expect(search([item('trans\u00ad', 0, 100, { hasEOL: true }), item('former', 0, 88)], 'transformer')).toHaveLength(1)
  })

  it('matches ligatures, fullwidth forms, and combining accents at their original offsets', () => {
    const items = [item('ﬁ Ａ cafe\u0301')]
    expect(search(items, 'FI a CAFÉ')[0].fragments).toEqual([
      { itemIndex: 0, start: 0, end: 9 }
    ])
    expect(search([item('x ﬁ y')], 'fi')[0].fragments).toEqual([
      { itemIndex: 0, start: 2, end: 3 }
    ])
  })

  it('maps partial Unicode case expansions and ignores invisible soft hyphens', () => {
    expect(search([item('İtem')], 'i')[0].fragments).toEqual([
      { itemIndex: 0, start: 0, end: 1 }
    ])
    expect(search([item('trans\u00adformer')], 'transformer')[0].fragments).toEqual([
      { itemIndex: 0, start: 0, end: 5 },
      { itemIndex: 0, start: 6, end: 12 }
    ])
  })

  it('normalizes typographic quotes and hyphens consistently', () => {
    expect(search([item('“reader’s” non\u2011breaking')], '"reader\'s" non-breaking')).toHaveLength(1)
  })

  it('calculates spacing along rotated text baselines', () => {
    const items = [
      item('trans', 0, 0, { transform: [0, 10, -10, 0, 100, 0] }),
      item('former', 0, 0, { transform: [0, 10, -10, 0, 100, 25] })
    ]
    expect(search(items, 'transformer')).toHaveLength(1)
  })

  it('finds repeated occurrences and does not search for an empty query', () => {
    expect(search([item('book book')], 'book')).toHaveLength(2)
    expect(search([item('book')], ' ')).toEqual([])
  })
})
