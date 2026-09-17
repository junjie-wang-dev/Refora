import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { LatexSyncBox } from '../../../shared/latex-types'
import PdfReader, { type PdfReaderHandle } from '../PdfReader'

export interface LatexPdfPreviewHandle { locateSource: () => void }
interface Props {
  data: string
  documentId: string
  active?: boolean
  stale?: boolean
  onDownload?: () => void
  target?: { box: LatexSyncBox; request: number } | null
  syncEnabled?: boolean
  syncHint?: string
  onLocateSource?: (page: number, x: number, y: number) => void
}

const LatexPdfPreview = forwardRef<LatexPdfPreviewHandle, Props>(function LatexPdfPreview({ data, documentId, active = true, stale = false, onDownload, target, syncEnabled = false, syncHint, onLocateSource }, ref) {
  const { t } = useTranslation()
  const reader = useRef<PdfReaderHandle>(null)
  const source = useMemo(() => ({ id: documentId, title: 'LaTeX PDF', data: Uint8Array.from(atob(data), (character) => character.charCodeAt(0)) }), [data, documentId])
  useImperativeHandle(ref, () => ({ locateSource: () => {
    if (!syncEnabled) return
    void reader.current?.getPosition().then((point) => { if (point) onLocateSource?.(point.page, point.x, point.y) })
  } }))
  return <section className="latex-pdf" aria-label={t('latex.preview')} title={syncHint}>
    {stale && <div className="latex-preview-notice"><span />{t('latex.previewStale')}</div>}
    <PdfReader ref={reader} variant="preview" source={source} embedded active={active} onDownload={onDownload} location={syncEnabled ? target : null} onPageDoubleClick={syncEnabled ? (point) => onLocateSource?.(point.page, point.x, point.y) : undefined} />
  </section>
})
export default LatexPdfPreview
