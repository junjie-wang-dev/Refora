export interface MarkdownSelection { start: number; end: number }
export interface MarkdownEdit extends MarkdownSelection { value: string }

export function replaceMarkdown(value: string, selection: MarkdownSelection, text: string, selectStart = text.length, selectEnd = selectStart): MarkdownEdit {
  return { value: value.slice(0, selection.start) + text + value.slice(selection.end), start: selection.start + selectStart, end: selection.start + selectEnd }
}

export function wrapMarkdown(value: string, selection: MarkdownSelection, before: string, after = before, placeholder = ''): MarkdownEdit {
  const selected = value.slice(selection.start, selection.end) || placeholder
  if (selection.start >= before.length && value.slice(selection.start - before.length, selection.start) === before && value.slice(selection.end, selection.end + after.length) === after) {
    return replaceMarkdown(value, { start: selection.start - before.length, end: selection.end + after.length }, selected, 0, selected.length)
  }
  return replaceMarkdown(value, selection, before + selected + after, before.length, before.length + selected.length)
}

export function indentMarkdown(value: string, selection: MarkdownSelection, outdent = false): MarkdownEdit {
  const start = value.lastIndexOf('\n', selection.start - 1) + 1
  const lineEnd = value.indexOf('\n', Math.max(selection.start, selection.end - 1))
  const end = lineEnd < 0 ? value.length : lineEnd
  const lines = value.slice(start, end).split('\n')
  const changes = lines.map((line) => outdent ? -(line.match(/^(?:\t| {1,2})/)?.[0].length ?? 0) : 2)
  const next = lines.map((line, index) => outdent ? line.slice(-changes[index]) : `  ${line}`).join('\n')
  return { value: value.slice(0, start) + next + value.slice(end), start: Math.max(start, selection.start + changes[0]), end: Math.max(start, selection.end + changes.reduce((a, b) => a + b, 0)) }
}

export function continueMarkdownList(value: string, selection: MarkdownSelection): MarkdownEdit | null {
  if (selection.start !== selection.end) return null
  const start = value.lastIndexOf('\n', selection.start - 1) + 1
  const prefix = value.slice(start, selection.start)
  const match = /^(\s*)([-+*]|\d+[.)]) (\[[ xX]\] )?(.*)$/.exec(prefix)
  if (!match) return null
  if (!match[4].trim() && (selection.start === value.length || value[selection.start] === '\n')) {
    return replaceMarkdown(value, { start, end: selection.start }, '')
  }
  const marker = /^\d/.test(match[2]) ? `${Number.parseInt(match[2]) + 1}${match[2].slice(-1)}` : match[2]
  return replaceMarkdown(value, selection, `\n${match[1]}${marker} ${match[3] ? '[ ] ' : ''}`)
}

export function markdownMatches(value: string, query: string): number[] {
  if (!query) return []
  const haystack = value.toLowerCase()
  const needle = query.toLowerCase()
  const matches: number[] = []
  for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + needle.length)) matches.push(start)
  return matches
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

export function markdownTableAt(value: string, offset: number): { start: number; end: number; rows: string[][]; alignments: string[] } | null {
  const lines = value.split('\n')
  let line = value.slice(0, offset).split('\n').length - 1
  if (!lines[line]?.includes('|')) return null
  while (line > 0 && lines[line - 1].includes('|') && lines[line - 1].trim()) line--
  const first = line
  const separator = tableCells(lines[line + 1] ?? '')
  if (!separator.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return null
  const rows = [tableCells(lines[line])]
  line += 2
  while (line < lines.length && lines[line].trim() && lines[line].includes('|')) rows.push(tableCells(lines[line++]))
  const width = Math.max(...rows.map((row) => row.length))
  const start = lines.slice(0, first).reduce((length, text) => length + text.length + 1, 0)
  return { start, end: start + lines.slice(first, line).join('\n').length, rows: rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? '')), alignments: separator }
}

export function serializeMarkdownTable(rows: string[][], alignments: string[] = []): string {
  const line = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(rows[0]), line(rows[0].map((_, index) => alignments[index] ?? '---')), ...rows.slice(1).map(line)].join('\n')
}
