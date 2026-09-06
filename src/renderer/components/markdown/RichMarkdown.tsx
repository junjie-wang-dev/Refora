import { Children, isValidElement, useEffect, useId, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowsOut, Check, Copy, DownloadSimple, X } from '@phosphor-icons/react'
import type { ExtraProps } from 'react-markdown'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { useModalDialog } from '../../hooks/useModalDialog'
import { tableCsv, tableRows } from '../../utils/markdownTable'
import './richMarkdown.css'

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return Children.toArray(node).map(nodeText).join('')
}

let mermaidReady: Promise<typeof import('mermaid')['default']> | undefined

async function renderDiagram(id: string, source: string): Promise<string> {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        suppressErrorRendering: true,
        maxTextSize: 50000,
        maxEdges: 500,
        theme: 'neutral',
        flowchart: { htmlLabels: false }
      })
      return mermaid
    })
  }
  const mermaid = await mermaidReady
  const container = document.createElement('div')
  container.className = 'markdown-diagram-render-container'
  document.body.appendChild(container)
  try {
    await mermaid.parse(source)
    const { svg } = await mermaid.render(id, source, container)
    const clean = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject', 'a', 'image', 'iframe', 'use'],
      FORBID_ATTR: ['href', 'xlink:href']
    })
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`
  } finally {
    container.remove()
  }
}

function MermaidDiagram({ source }: { source: string }) {
  const { t } = useTranslation()
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [preview, setPreview] = useState<{ source: string; image?: string; failed?: boolean }>()
  const [showSource, setShowSource] = useState(false)
  const current = preview?.source === source ? preview : undefined

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      if (source.length > 50000 || /(?:%%\s*\{|^---\s*$)/m.test(source)) {
        setPreview({ source, failed: true })
        return
      }
      void renderDiagram(`reforaDiagram${id}`, source).then(
        (image) => { if (active) setPreview({ source, image }) },
        () => { if (active) setPreview({ source, failed: true }) }
      )
    }, 300)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [id, source])

  return (
    <div className="markdown-diagram">
      {current?.image && <img className="markdown-diagram-image" src={current.image} alt={t('markdown.diagram')} />}
      {!current?.image && <p role="status" className="markdown-format-status">{t(current?.failed ? 'markdown.diagramUnavailable' : 'markdown.diagramLoading')}</p>}
      {current?.image && (
        <button type="button" className="markdown-format-button" aria-expanded={showSource} onClick={() => setShowSource((value) => !value)}>
          {t(showSource ? 'markdown.hideSource' : 'markdown.showSource')}
        </button>
      )}
      {(!current?.image || showSource) && <pre><code className="language-mermaid">{source}</code></pre>}
    </div>
  )
}

export function MarkdownCodeBlock({ children, node: _node, ...props }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const resetTimer = useRef<number | undefined>(undefined)
  const code = Children.toArray(children).find((child) => isValidElement(child))
  const codeProps = isValidElement<{ className?: string; children?: ReactNode }>(code) ? code.props : undefined
  const source = nodeText(codeProps?.children ?? children)
  const language = codeProps?.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase()
  const isMermaid = language === 'mermaid'
  const isLong = source.split('\n').length > 24 || source.length > 2400
  const highlighted = useMemo(() => {
    if (!language || isMermaid || source.length > 100000 || !hljs.getLanguage(language)) return undefined
    try {
      return DOMPurify.sanitize(hljs.highlight(source, { language, ignoreIllegals: true }).value, {
        ALLOWED_TAGS: ['span'],
        ALLOWED_ATTR: ['class']
      })
    } catch {
      return undefined
    }
  }, [isMermaid, language, source])

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  return (
    <div className="markdown-code-block">
      <div className="markdown-format-toolbar">
        <span className="markdown-code-language">{language ?? t('markdown.plainText')}</span>
        <div className="markdown-format-actions">
          {copyFailed && <span role="status">{t('markdown.copyFailed')}</span>}
          <button type="button" className="markdown-format-button" aria-label={t('common.copyCode')} onClick={() => {
            void navigator.clipboard.writeText(source).then(() => {
              setCopied(true)
              setCopyFailed(false)
              window.clearTimeout(resetTimer.current)
              resetTimer.current = window.setTimeout(() => setCopied(false), 1500)
            }).catch(() => setCopyFailed(true))
          }}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{t(copied ? 'markdown.copied' : 'markdown.copy')}</span>
          </button>
        </div>
      </div>
      {isMermaid ? <MermaidDiagram source={source} /> : (
        <>
          <pre {...props} className={`${props.className ?? ''} markdown-code-content${isLong && !expanded ? ' markdown-code-collapsed' : ''}`}>
            {highlighted !== undefined
              ? <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
              : <code className={codeProps?.className}>{source}</code>}
          </pre>
          {isLong && <button type="button" className="markdown-format-button markdown-code-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{t(expanded ? 'markdown.collapseCode' : 'markdown.expandCode')}</button>}
        </>
      )}
    </div>
  )
}

export function MarkdownTable({ children, node: _node, ...props }: ComponentPropsWithoutRef<'table'> & ExtraProps) {
  const { t } = useTranslation()
  const tableRef = useRef<HTMLTableElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<'copied' | 'copyFailed' | undefined>()
  const resetTimer = useRef<number | undefined>(undefined)
  const dialogRef = useModalDialog<HTMLDivElement>(expanded, () => setExpanded(false))

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const copy = () => {
    if (!tableRef.current) return
    const text = tableRows(tableRef.current).map((row) => row.join('\t')).join('\n')
    void navigator.clipboard.writeText(text).then(() => {
      setStatus('copied')
      window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setStatus(undefined), 1500)
    }).catch(() => setStatus('copyFailed'))
  }
  const download = () => {
    if (!tableRef.current) return
    const url = URL.createObjectURL(new Blob(['\uFEFF', tableCsv(tableRows(tableRef.current))], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'table.csv'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const actions = (
    <div className="markdown-format-actions">
      {status && <span role="status">{t(`markdown.${status}`)}</span>}
      <button type="button" className="markdown-format-button" onClick={copy} aria-label={t('markdown.copyTable')}><Copy size={14} /><span>{t('markdown.copy')}</span></button>
      <button type="button" className="markdown-format-button" onClick={download} aria-label={t('markdown.exportTable')}><DownloadSimple size={14} /><span>CSV</span></button>
    </div>
  )
  return (
    <div className="markdown-table-block">
      <div className="markdown-format-toolbar">
        <button type="button" className="markdown-format-button" onClick={() => setExpanded(true)} aria-label={t('markdown.expandTable')}><ArrowsOut size={14} /><span>{t('markdown.table')}</span></button>
        {actions}
      </div>
      <div className="markdown-table-scroll" role="region" aria-label={t('markdown.table')} tabIndex={0}>
        <table ref={tableRef} {...props}>{children}</table>
      </div>
      {expanded && createPortal(
        <div className="markdown-table-backdrop" onClick={() => setExpanded(false)}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('markdown.expandedTable')} tabIndex={-1} className="markdown-table-dialog chat-markdown" onClick={(event) => event.stopPropagation()}>
            <div className="markdown-format-toolbar">
              <span>{t('markdown.expandedTable')}</span>
              {actions}
              <button type="button" className="markdown-format-button" aria-label={t('common.close')} onClick={() => setExpanded(false)}><X size={18} /></button>
            </div>
            <div className="markdown-table-scroll"><table {...props}>{children}</table></div>
          </div>
        </div>, document.body
      )}
    </div>
  )
}
