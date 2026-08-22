import { useState, useRef, type ComponentPropsWithoutRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from '@phosphor-icons/react'
import type { Components, Options } from 'react-markdown'
import { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

interface MarkdownAstNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownAstNode[]
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
    attributes: {
      ...defaultSchema.attributes,
      code: [
        ...(defaultSchema.attributes?.code ?? []),
        ['className', 'math-inline', 'math-display']
      ]
    },
    protocols: {
      ...defaultSchema.protocols,
      href: [...(defaultSchema.protocols?.href ?? []), 'refora'],
      src: [...(defaultSchema.protocols?.src ?? []), 'refora-document']
    }
  }],
  rehypeTableMath,
  rehypeKatex
]

export function urlTransform(url: string): string {
  if (url.startsWith('refora://')) return url
  return defaultUrlTransform(url)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseReforaDocLink(href: string): { docId: string; query?: string } | null {
  if (!href) return null
  const match = href.match(/^refora:\/\/doc\/([^?]+)(?:\?(.*))?$/)
  if (!match) return null
  return {
    docId: safeDecode(match[1]),
    query: match[2] ? safeDecode(match[2]) : undefined
  }
}

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const { t } = useTranslation()
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  return (
    <div className="group/code relative">
      <button
        type="button"
        className="absolute right-1 top-1 z-10 rounded p-1 text-muted opacity-0 transition-opacity hover:text-foreground group-hover/code:opacity-100"
        onClick={() => {
          const text =
            ref.current?.querySelector('code')?.textContent ??
            ref.current?.textContent ??
            ''
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
        }}
        aria-label={t('common.copyCode')}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  )
}

const BASE_MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: CodeBlock
}

export const MARKDOWN_COMPONENTS: Components = BASE_MARKDOWN_COMPONENTS

export function createMarkdownComponents(
  overrides?: Partial<Components>
): Components {
  return { ...BASE_MARKDOWN_COMPONENTS, ...overrides }
}

export function createReforaDocMarkdownComponents(
  onOpenDocument: (docId: string) => Promise<unknown>,
  onOpenError?: () => void
): Components {
  return createMarkdownComponents({
    a: ({ href, children }) => {
      const parsed = href ? parseReforaDocLink(href) : null
      if (!parsed) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        )
      }
      return (
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-0.5 text-accent underline transition-opacity duration-150 hover:opacity-80"
          onClick={async (event) => {
            event.stopPropagation()
            try {
              await onOpenDocument(parsed.docId)
            } catch {
              onOpenError?.()
            }
          }}
          title={parsed.query ?? undefined}
        >
          {children}
        </button>
      )
    }
  })
}
