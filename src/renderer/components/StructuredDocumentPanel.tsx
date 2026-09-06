import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Copy, DownloadSimple, FilePdf, FileText, List, MagnifyingGlass } from '@phosphor-icons/react'
import { api } from '../ipc'
import { useOcrReaderStore } from '../store/ocrReaderStore'
import {
  createMarkdownComponents,
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  urlTransform
} from '../utils/markdown'
import { EmptyState, IconTooltip, PanelHeader } from './ui'
import MarkdownNavigation from './markdown/MarkdownNavigation'
import { downloadMarkdown, exportMarkdownPdf, markdownDocument } from '../utils/markdownExport'
import { useDocumentStore } from '../store/documentStore'
import './markdown/markdownWorkspace.css'

const readingPositions = new Map<string, number>()

export default function StructuredDocumentPanel() {
  const { t } = useTranslation()
  const documentId = useOcrReaderStore((state) => state.documentId)
  const resultKey = useOcrReaderStore((state) => state.resultKey)
  const title = useOcrReaderStore((state) => state.title)
  const close = useOcrReaderStore((state) => state.close)
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const articleRef = useRef<HTMLElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const positionKey = `${documentId}:${resultKey}`
  const documentTitle = title || t('ocr.title')

  useEffect(() => {
    const surface = surfaceRef.current
    const openFind = () => setFindOpen(true)
    surface?.addEventListener('refora-markdown-find', openFind)
    return () => surface?.removeEventListener('refora-markdown-find', openFind)
  }, [])

  useEffect(() => {
    if (!loading && scrollRef.current) scrollRef.current.scrollTop = readingPositions.get(positionKey) ?? 0
  }, [loading, positionKey])

  useEffect(() => {
    let active = true
    setMarkdown('')
    setLoading(true)
    setFailed(false)
    setFindOpen(false)
    setOutlineOpen(false)
    if (!documentId || !resultKey) {
      setLoading(false)
      return
    }
    void api.ocr.readMarkdown(documentId, resultKey).then((content) => {
      if (!active) return
      setMarkdown(content)
      setLoading(false)
    }).catch(() => {
      if (!active) return
      setFailed(true)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [documentId, resultKey])

  const components = useMemo(() => createMarkdownComponents({
    img: ({ src, alt, ...props }) => {
      const assetPath = src?.startsWith('images/')
        ? `assets/${src.slice('images/'.length)}`
        : src?.startsWith('assets/') ? src : null
      const resolved = documentId && resultKey && assetPath
        ? api.ocr.assetUrl(documentId, resultKey, assetPath)
        : src
      return <img {...props} src={resolved} alt={alt ?? ''} loading="lazy" />
    }
  }), [documentId, resultKey])

  const action = (label: string, icon: ReactNode, onClick: () => void, pressed?: boolean) => (
    <IconTooltip label={label} appearance="sidebar">
      <button type="button" className="sidebar-header-btn" aria-label={label} aria-pressed={pressed} disabled={loading || failed || exporting} onClick={onClick}>{icon}</button>
    </IconTooltip>
  )

  const copyMarkdown = async () => {
    try {
      await api.clipboard.writeText(markdownDocument(documentTitle, markdown))
      useDocumentStore.getState().showToast(t('markdown.copied'))
    } catch {
      useDocumentStore.getState().showToast(t('common.copyFailed'))
    }
  }

  const exportPdf = async () => {
    if (!articleRef.current || exporting) return
    setExporting(true)
    try {
      await exportMarkdownPdf(articleRef.current, documentTitle)
    } catch {
      useDocumentStore.getState().showToast(t('markdown.exportFailed'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div ref={surfaceRef} className="markdown-workspace flex-1" data-markdown-surface="ocr" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.nativeEvent.isComposing) {
        event.preventDefault()
        event.stopPropagation()
        setFindOpen(true)
      }
    }}>
      <PanelHeader title={documentTitle} onClose={close} />
      <div className="markdown-workspace-toolbar">
        <div className="markdown-toolbar-group">
          {action(t('markdown.findDocument'), <MagnifyingGlass size={17} />, () => setFindOpen(true))}
          {action(t('markdown.outline'), <List size={17} />, () => setOutlineOpen((open) => !open), outlineOpen)}
        </div>
        <div className="markdown-toolbar-group">
          {exporting && <span role="status" className="markdown-save-state">{t('markdown.exporting')}</span>}
          {action(t('markdown.copyMarkdown'), <Copy size={17} />, () => void copyMarkdown())}
          {action(t('markdown.exportMarkdown'), <DownloadSimple size={17} />, () => downloadMarkdown(documentTitle, markdown))}
          {action(t('markdown.exportPdf'), <FilePdf size={17} />, () => void exportPdf())}
        </div>
      </div>
      <div className="markdown-content-region">
        <MarkdownNavigation articleRef={articleRef} content={markdown} findOpen={findOpen} outlineOpen={outlineOpen} onCloseFind={() => setFindOpen(false)} onCloseOutline={() => setOutlineOpen(false)} onNavigate={() => setOutlineOpen(false)} />
        <div ref={scrollRef} className="markdown-reading-scroll" onScroll={(event) => {
          if (loading) return
          readingPositions.delete(positionKey)
          readingPositions.set(positionKey, event.currentTarget.scrollTop)
          if (readingPositions.size > 100) readingPositions.delete(readingPositions.keys().next().value!)
        }}>
          {loading ? (
            <EmptyState icon={<FileText className="h-10 w-10" />} title={t('ocr.readerLoading')} />
          ) : failed ? (
            <EmptyState icon={<FileText className="h-10 w-10" />} title={t('ocr.readerFailed')} />
          ) : (
            <article ref={articleRef} className="markdown-body select-text">
              {markdown ? (
                <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components} urlTransform={urlTransform}>
                  {markdown}
                </ReactMarkdown>
              ) : <p className="italic text-muted">{t('ocr.empty')}</p>}
            </article>
          )}
        </div>
      </div>
    </div>
  )
}
