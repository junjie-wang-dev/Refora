import type { AiSummary, Document } from '../../shared/ipc-types'
import { formatAuthors } from './format'

const BOARD_PREVIEW_MAX_CHARS = 1800
const BOARD_PREVIEW_MAX_LINES = 28

export function boardCardPreview(content: string): string {
  const lines = content.split(/\r?\n/)
  if (content.length <= BOARD_PREVIEW_MAX_CHARS && lines.length <= BOARD_PREVIEW_MAX_LINES) {
    return content
  }
  const selected: string[] = []
  let chars = 0
  for (const line of lines) {
    if (selected.length >= BOARD_PREVIEW_MAX_LINES) break
    const remaining = BOARD_PREVIEW_MAX_CHARS - chars
    if (remaining <= 0) break
    if (line.length > remaining) {
      selected.push(line.slice(0, remaining))
      break
    }
    selected.push(line)
    chars += line.length + 1
  }
  return `${selected.join('\n').trimEnd()}\n\n…`
}

export function markdownCardContent(title: string, content: string): string {
  const body = content.trim()
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`
}

export function paperCardMarkdown(doc: Document, summary: AiSummary | null): string {
  const title = doc.title || doc.fileName
  const metadata = [
    ['Authors', formatAuthors(doc.authors)],
    ['Year', doc.year],
    ['Venue', doc.venue],
    ['DOI', doc.doi],
    ['arXiv ID', doc.arxivId],
    ['URL', doc.url],
    ['Source file', doc.fileName]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  const sections: string[] = [`# ${title}`]

  if (metadata.length > 0) {
    sections.push(metadata.map(([label, value]) => `- **${label}:** ${value}`).join('\n'))
  }
  if (doc.abstract) sections.push(`## Abstract\n\n${doc.abstract}`)
  if (summary?.content) {
    const summarySections = [`## AI Summary\n\n${summary.content.core}`]
    if (summary.content.keyPoints.length > 0) {
      summarySections.push(`### Key Points\n\n${summary.content.keyPoints.map((point) => `- ${point}`).join('\n')}`)
    }
    if (summary.content.methods) summarySections.push(`### Methods\n\n${summary.content.methods}`)
    if (summary.content.contribution) summarySections.push(`### Contribution\n\n${summary.content.contribution}`)
    sections.push(summarySections.join('\n\n'))
  }
  if (doc.note) sections.push(`## Notes\n\n${doc.note}`)

  return `${sections.join('\n\n')}\n`
}

export function aiSummaryMarkdown(summary: AiSummary): string {
  const content = summary.content
  if (!content) return ''
  const sections = [content.core]
  if (content.keyPoints.length > 0) {
    sections.push('## Key Points\n\n' + content.keyPoints.map((point) => '- ' + point).join('\n'))
  }
  if (content.methods) sections.push('## Methods\n\n' + content.methods)
  if (content.contribution) sections.push('## Contribution\n\n' + content.contribution)
  return sections.join('\n\n') + '\n'
}
