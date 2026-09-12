import { useEffect, useRef, useState } from 'react'
import { ArrowLineDown, ArrowsOutSimple, CaretLeft, CaretRight, Minus, Plus } from '@phosphor-icons/react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useTranslation } from 'react-i18next'

export default function LatexPdfPreview({ data, stale = false, onDownload }: { data: string; stale?: boolean; onDownload?: () => void }) {
  const { t } = useTranslation()
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState('')
  const [availableWidth, setAvailableWidth] = useState(600)
  const scroller = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0) setAvailableWidth(element.clientWidth)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | undefined
    setPdf(null)
    setError('')
    void Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(async ([runtime, worker]) => {
      if (cancelled) return
      runtime.GlobalWorkerOptions.workerSrc = worker.default
      const task = runtime.getDocument({ data: Uint8Array.from(atob(data), (character) => character.charCodeAt(0)) })
      cleanup = () => { void task.destroy() }
      const document = await task.promise
      if (!cancelled) { setPdf(document); setPage((current) => Math.min(current, document.numPages)) }
    }).catch((reason: unknown) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true; cleanup?.() }
  }, [data])
  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    let cleanup: (() => void) | undefined
    void pdf.getPage(page).then((documentPage) => {
      if (cancelled || !canvas.current) return
      const pageWidth = documentPage.getViewport({ scale: 1 }).width
      const viewport = documentPage.getViewport({ scale: Math.max(0.1, (availableWidth - 32) / pageWidth) * zoom })
      const ratio = window.devicePixelRatio || 1
      canvas.current.width = viewport.width * ratio
      canvas.current.height = viewport.height * ratio
      canvas.current.style.width = `${viewport.width}px`
      canvas.current.style.height = `${viewport.height}px`
      const task = documentPage.render({ canvas: canvas.current, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
      cleanup = () => task.cancel()
      return task.promise
    }).catch((reason: unknown) => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true; cleanup?.() }
  }, [pdf, page, zoom, availableWidth])
  return <section className="latex-pdf" aria-label={t('latex.preview')}>
    <div className="latex-pdf-toolbar">
      <div className="latex-pdf-pagination"><button type="button" className="latex-icon-button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('latex.previousPage')}><CaretLeft size={14} /></button><span className="latex-page-indicator">{page} / {pdf?.numPages ?? '…'}</span><button type="button" className="latex-icon-button" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(page + 1)} aria-label={t('latex.nextPage')}><CaretRight size={14} /></button></div>
      <div className="latex-pdf-zoom"><button type="button" className="latex-icon-button" disabled={zoom <= 0.5} onClick={() => setZoom(zoom - 0.25)} aria-label={t('latex.zoomOut')}><Minus size={13} /></button><button type="button" className="latex-fit-button" title={t('latex.fitWidth')} aria-label={t('latex.fitWidth')} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" className="latex-icon-button" disabled={zoom >= 3} onClick={() => setZoom(zoom + 0.25)} aria-label={t('latex.zoomIn')}><Plus size={13} /></button><button type="button" className="latex-icon-button latex-fit-icon" title={t('latex.fitWidth')} aria-label={t('latex.fitWidth')} onClick={() => setZoom(1)}><ArrowsOutSimple size={14} /></button></div>
      {onDownload && <button type="button" className="latex-icon-button latex-pdf-download" title={t('latex.exportPdf')} aria-label={t('latex.exportPdf')} onClick={onDownload}><ArrowLineDown size={15} /></button>}
    </div>
    {stale && <div className="latex-preview-notice"><span />{t('latex.previewStale')}</div>}
    {error && <p className="latex-pdf-error" role="alert">{error}</p>}
    <div ref={scroller} className="latex-pdf-scroll"><canvas ref={canvas} />{!pdf && !error && <div className="latex-pdf-loading">{t('latex.loadingPreview')}</div>}</div>
  </section>
}
