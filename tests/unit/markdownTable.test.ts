import { describe, expect, it } from 'vitest'
import { tableCsv, tableRows } from '../../src/renderer/utils/markdownTable'

describe('table export', () => {
  it('quotes CSV delimiters, quotes and newlines without changing numeric values', () => {
    expect(tableCsv([['Name', 'Value'], ['A, B', 'a"b\nc'], ['-1.2e3', '42']])).toBe('Name,Value\r\n"A, B","a""b\nc"\r\n-1.2e3,42')
  })

  it('prevents exported text from becoming a spreadsheet formula', () => {
    expect(tableCsv([['=HYPERLINK("https://example.com")', '+SUM(A1)', '@import', ' -cmd']])).toBe('"\'=HYPERLINK(""https://example.com"")",\'+SUM(A1),\'@import,\' -cmd')
  })

  it('copies mathematical notation once from rendered cells', () => {
    const table = document.createElement('table')
    table.innerHTML = '<tbody><tr><td>Value <span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation>x^2</annotation></semantics></math></span><span class="katex-html">x2</span></span></td></tr></tbody>'
    expect(tableRows(table)).toEqual([['Value x^2']])
    expect(table.querySelector('.katex')).toBeTruthy()
  })
})
