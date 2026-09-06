import type { Components, Options, ExtraProps } from 'react-markdown'
import type { ComponentPropsWithoutRef } from 'react'
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
  position?: { start?: { offset?: number } }
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
  if (!node.children || ['code', 'pre', 'kbd', 'samp', 'script', 'style'].includes(node.tagName ?? '')) return
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


export function markdownHeadingSlug(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/g, '-') || 'section'
}

export function createMarkdownHeadingIdFactory(): (text: string) => string {
  const used = new Set<string>()
  return (text) => {
    const base = `markdown-${markdownHeadingSlug(text)}`
    let id = base
    let suffix = 0
    while (used.has(id)) id = `${base}-${++suffix}`
    used.add(id)
    return id
  }
}

function rehypeHeadingIds() {
  return (tree: unknown) => {
    const nextId = createMarkdownHeadingIdFactory()
    const text = (node: MarkdownAstNode): string => node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(text).join('')
    const visit = (node: MarkdownAstNode) => {
      if (/^h[1-6]$/.test(node.tagName ?? '')) {
        node.properties = { ...node.properties, id: node.properties?.id ?? nextId(text(node)) }
      }
      if (/^(h[1-6]|p|li|pre|blockquote|table|hr)$/.test(node.tagName ?? '') && node.position?.start?.offset !== undefined) {
        node.properties = { ...node.properties, 'data-source-offset': node.position.start.offset }
      }
      node.children?.forEach(visit)
    }
    visit(tree as MarkdownAstNode)
  }
}

function MarkdownLink({ href, children, node, ...props }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const internal = href?.startsWith('#')
  const link = <a {...props} href={href} target={internal ? undefined : '_blank'} rel={internal ? undefined : 'noopener noreferrer'} onClick={internal ? (event) => {
    event.preventDefault()
    event.stopPropagation()
    const scope = event.currentTarget.closest('.markdown-body, .chat-markdown, [data-markdown-root]') ?? event.currentTarget.parentElement
    const fragment = safeDecode((href ?? '').slice(1))
    const target = Array.from(scope?.querySelectorAll<HTMLElement>('[id]') ?? []).find((element) => [fragment, `markdown-${fragment}`, `user-content-${fragment}`].includes(element.id))
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
  } : undefined}>{containsMedia(node) ? <MediaSourceLabel /> : children}</a>
  return containsMedia(node) ? <span className="markdown-linked-media">{children}{link}</span> : link
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
  rehypeHeadingIds,
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
  a: MarkdownLink,
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
    a: ({ href, children, node, ...props }) => {
      const parsed = href ? parseReforaDocLink(href) : null
      const media = containsMedia(node)
      if (!parsed) return <MarkdownLink {...props} href={href} node={node}>{children}</MarkdownLink>
      const link = (
        <button
          type="button"
          data-markdown-searchable="true"
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
