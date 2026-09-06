import { describe, expect, it } from 'vitest'
import { continueMarkdownList, indentMarkdown, markdownMatches, markdownTableAt, serializeMarkdownTable, wrapMarkdown } from '../../src/renderer/utils/markdownEditing'

describe('Markdown editing', () => {
  it('continues numeric list markers and nested indentation', () => {
    const value = '  9) next'
    expect(continueMarkdownList(value, { start: value.length, end: value.length })?.value).toBe('  9) next\n  10) ')
  })
  it('does not erase trailing list text or hijack ordinary paragraphs', () => {
    expect(continueMarkdownList('- content', { start: 2, end: 2 })?.value).toBe('- \n- content')
    expect(continueMarkdownList('hello', { start: 5, end: 5 })).toBeNull()
  })
  it('outdents mixed whitespace without removing actual content', () => {
    expect(indentMarkdown(' x\n\ty\nz', { start: 0, end: 7 }, true).value).toBe('x\ny\nz')
  })
  it('toggles existing formatting around a selection', () => {
    expect(wrapMarkdown('**hello**', { start: 2, end: 7 }, '**')).toEqual({ value: 'hello', start: 0, end: 5 })
  })
  it('treats search syntax literally and skips overlapping matches', () => {
    expect(markdownMatches('a.* a.* A.*', 'a.*')).toEqual([0, 4, 8])
    expect(markdownMatches('aaa', 'aa')).toEqual([0])
  })
  it('roundtrips escaped table pipes and recognizes only valid tables', () => {
    const table = '| A | B |\n| --- | --- |\n| a \\| b | c |'
    const parsed = markdownTableAt(table, table.indexOf('a \\|'))
    expect(parsed?.rows).toEqual([['A', 'B'], ['a | b', 'c']])
    expect(serializeMarkdownTable(parsed!.rows)).toBe(table)
    expect(markdownTableAt('ordinary | pipe', 2)).toBeNull()
  })
})
