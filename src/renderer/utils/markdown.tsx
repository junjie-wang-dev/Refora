import type { Components, Options } from 'react-markdown'
import { useTranslation } from 'react-i18next'
import { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { PdfOpenOptions } from './openPdf'
import { MarkdownCodeBlock, MarkdownTable } from '../components/markdown/RichMarkdown'
import { MarkdownMediaComponents } from '../components/workspace/ChatMedia'
import { isSafeMediaUrl } from './mediaSources'

interface MarkdownAstNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownAstNode[]
}

function containsMedia(node: MarkdownAstNode | undefined): boolean {
  return Boolean(node && (['img', 'audio', 'video'].includes(node.tagName ?? '') || node.children?.some(containsMedia)))
}

function MediaSourceLabel() {
  const { t } = useTranslation()
  return <>{t('markdown.mediaSource')}</>
}

function inlineMathNodes(value: string): MarkdownAstNode[] {
  const nodes: MarkdownAstNode[] = []
  const pattern = /(?<!\\)\$(?!\$)([^$\n]+?)(?<!\\)\$/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) nodes.push({ type: 'text', value: value.slice(cursor, match.index) })
    nodes.push({
      type: 'element',
      tagName: 'code',
      properties: { className: ['language-math', 'math-inline'] },
      children: [{ type: 'text', value: match[1] }]
    })
    cursor = match.index + match[0].length
  }
  if (cursor === 0) return [{ type: 'text', value }]
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes
}

function replaceTableMath(node: MarkdownAstNode, insideTable = false): void {
  if (!node.children) return
  const tableContent = insideTable || (node.type === 'element' && node.tagName === 'table')
  node.children = node.children.flatMap((child) => {
    if (tableContent && child.type === 'text' && typeof child.value === 'string') {
      return inlineMathNodes(child.value)
    }
    replaceTableMath(child, tableContent)
    return child
  })
}

function rehypeTableMath() {
  return (tree: unknown) => replaceTableMath(tree as MarkdownAstNode)
}

export const REMARK_PLUGINS = [remarkGfm, remarkMath]
export const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), 'audio', 'video'],
    attributes: {
      ...defaultSchema.attributes,
      audio: ['src', 'title', 'controls'],
      video: ['src', 'title', 'controls', 'poster'],
      code: [
        ...(defaultSchema.attributes?.code ?? []),
        ['className', 'math-inline', 'math-display']
      ]
    },
    protocols: {
      ...defaultSchema.protocols,
      href: [...(defaultSchema.protocols?.href ?? []), 'refora'],
      src: [...(defaultSchema.protocols?.src ?? []), 'refora-document', 'refora-asset', 'data'],
      poster: [...(defaultSchema.protocols?.src ?? []), 'refora-document', 'refora-asset', 'data']
    }
  }],
  rehypeTableMath,
  rehypeKatex
]

export function urlTransform(url: string, key?: string): string {
  if ((!key || key === 'href') && parseReforaDocLink(url)) return url
  if (key === 'src' || key === 'poster') return isSafeMediaUrl(url) ? url : ''
  return defaultUrlTransform(url)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseReforaDocLink(href: string): {
  docId: string
  query?: string
  page?: number
  search?: string
} | null {
  if (!href) return null
  const match = href.match(/^refora:\/\/doc\/([^?#]+)(?:\?([^#]*))?(?:#.*)?$/)
  if (!match) return null
  const parameters = new URLSearchParams(match[2] ?? '')
  const pageValue = parameters.get('page')
  const page = pageValue && /^\d+$/.test(pageValue) ? Number(pageValue) : undefined
  const search = (parameters.get('quote') ?? parameters.get('search') ?? parameters.get('q') ??
    (match[2] && !match[2].includes('=') ? safeDecode(match[2]) : undefined))?.trim()
  return {
    docId: safeDecode(match[1]),
    query: match[2] ? safeDecode(match[2]) : undefined,
    ...(page !== undefined && Number.isSafeInteger(page) && page > 0 ? { page } : {}),
    ...(search ? { search } : {})
  }
}

const BASE_MARKDOWN_COMPONENTS: Components = {
  ...MarkdownMediaComponents,
  a: ({ href, children, node }) => containsMedia(node) ? (
    <span className="markdown-linked-media">{children}<a href={href} target="_blank" rel="noopener noreferrer"><MediaSourceLabel /></a></span>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  pre: MarkdownCodeBlock,
  table: MarkdownTable
}

export const MARKDOWN_COMPONENTS: Components = BASE_MARKDOWN_COMPONENTS

export function createMarkdownComponents(
  overrides?: Partial<Components>
): Components {
  return { ...BASE_MARKDOWN_COMPONENTS, ...overrides }
}

export function createReforaDocMarkdownComponents(
  onOpenDocument: (docId: string, options?: PdfOpenOptions) => Promise<unknown>,
  onOpenError?: () => void
): Components {
  return createMarkdownComponents({
    a: ({ href, children, node }) => {
      const parsed = href ? parseReforaDocLink(href) : null
      const media = containsMedia(node)
      if (!parsed) {
        if (media) return <span className="markdown-linked-media">{children}<a href={href} target="_blank" rel="noopener noreferrer"><MediaSourceLabel /></a></span>
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        )
      }
      const link = (
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-0.5 text-accent underline transition-opacity duration-150 hover:opacity-80"
          onClick={async (event) => {
            event.stopPropagation()
            try {
              await onOpenDocument(parsed.docId, {
                forceBuiltin: true,
                ...(parsed.page !== undefined ? { page: parsed.page } : {}),
                ...(parsed.search ? { search: parsed.search } : {})
              })
            } catch {
              onOpenError?.()
            }
          }}
          title={parsed.search ?? parsed.query ?? undefined}
        >
          {media ? <MediaSourceLabel /> : children}
        </button>
      )
      return media ? <span className="markdown-linked-media">{children}{link}</span> : link
    }
  })
}
