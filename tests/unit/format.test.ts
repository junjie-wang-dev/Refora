import { describe, it, expect } from 'vitest'
import {
  formatAuthorName,
  formatAuthors,
  formatDate,
  formatFilePath
} from '../../src/renderer/utils/format'

describe('formatDate', () => {
  it('formats a timestamp as YYYY-MM-DD', () => {
    expect(formatDate(new Date('2024-03-09T15:30:00Z').getTime())).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('zero-pads month and day', () => {
    const ts = new Date('2024-01-05T00:00:00Z').getTime()
    const d = new Date(ts)
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(formatDate(ts)).toBe(expected)
  })
})

describe('formatFilePath', () => {
  it('collapses /Users/<user> prefix to ~ when followed by a subpath', () => {
    expect(formatFilePath('/Users/jane/Documents/paper.pdf')).toBe('~/Documents/paper.pdf')
  })

  it('returns the home root path unchanged when no subpath follows', () => {
    expect(formatFilePath('/Users/jane')).toBe('/Users/jane')
  })

  it('returns non-home paths unchanged', () => {
    expect(formatFilePath('/tmp/paper.pdf')).toBe('/tmp/paper.pdf')
  })

  it('returns paths without the home prefix unchanged', () => {
    expect(formatFilePath('/opt/local/share/paper.pdf')).toBe('/opt/local/share/paper.pdf')
  })
})

describe('author formatting', () => {
  it('uses given name before family name for legacy comma-form names', () => {
    expect(formatAuthorName('Lin, Ming C.')).toBe('Ming C. Lin')
    expect(formatAuthorName('Van Der Berg, Carl')).toBe('Carl Van Der Berg')
  })

  it('keeps names that are already given-name-first', () => {
    expect(formatAuthorName('Ming C. Lin')).toBe('Ming C. Lin')
  })

  it('formats semicolon-separated author lists and DBLP suffixes', () => {
    expect(formatAuthors('0003, Sanghyun Son; Zhou, Yang; Yi-Ling Qiao')).toBe(
      'Sanghyun Son; Yang Zhou; Yi-Ling Qiao'
    )
  })

  it('places generational suffixes after the family name', () => {
    expect(formatAuthorName('Doe, John, Jr.')).toBe('John Doe Jr.')
    expect(formatAuthorName('Doe, Jr., John')).toBe('John Doe Jr.')
  })
})
