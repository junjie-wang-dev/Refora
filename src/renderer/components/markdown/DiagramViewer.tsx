import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowsOut, DownloadSimple, Minus, Plus, X } from '@phosphor-icons/react'
import { useModalDialog } from '../../hooks/useModalDialog'

function downloadImage(url: string, fileName: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
}

export function DiagramViewer({ image, onClose }: { image: string; onClose: () => void }) {
  const { t } = useTranslation()
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose)
  const viewportRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined)
  const [zoom, setZoom] = useState(1)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [exporting, setExporting] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dragging, setDragging] = useState(false)

  const fit = (width = size.width, height = size.height) => {
    const viewport = viewportRef.current
    if (!viewport || !width || !height) return
    setZoom(Math.max(0.02, Math.min(1, (viewport.clientWidth - 48) / width, (viewport.clientHeight - 48) / height)))
    viewport.scrollLeft = 0
    viewport.scrollTop = 0
  }
  const changeZoom = (factor: number) => setZoom((current) => Math.min(8, Math.max(0.02, current * factor)))
  const exportPng = async () => {
    const source = imageRef.current
    if (!source?.complete || !source.naturalWidth) return
    setExporting(true)
    setFailed(false)
    try {
      const ratio = Math.min(2, 8192 / source.naturalWidth, 8192 / source.naturalHeight, Math.sqrt(16000000 / (source.naturalWidth * source.naturalHeight)))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(source.naturalWidth * ratio))
      canvas.height = Math.max(1, Math.round(source.naturalHeight * ratio))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas unavailable')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Image unavailable')), 'image/png'))
      const url = URL.createObjectURL(blob)
      downloadImage(url, 'diagram.png')
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setFailed(true)
    } finally {
      setExporting(false)
    }
  }

  return createPortal(
    <div className="markdown-table-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="markdown-diagram-dialog" role="dialog" aria-modal="true" aria-label={t('markdown.diagram')} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="markdown-format-toolbar">
          <span>{t('markdown.diagram')}</span>
          <div className="markdown-format-actions">
            <button type="button" className="markdown-format-button" aria-label={t('markdown.zoomOut')} disabled={zoom <= 0.02} onClick={() => changeZoom(1 / 1.25)}><Minus size={16} /></button>
            <output className="markdown-diagram-zoom" aria-label={t('markdown.zoomLevel')}>{Math.round(zoom * 100)}%</output>
            <button type="button" className="markdown-format-button" aria-label={t('markdown.zoomIn')} disabled={zoom >= 8} onClick={() => changeZoom(1.25)}><Plus size={16} /></button>
            <button type="button" className="markdown-format-button" onClick={() => fit()}><ArrowsOut size={16} />{t('markdown.fitDiagram')}</button>
            <button type="button" className="markdown-format-button" aria-label={t('markdown.exportDiagramSvg')} onClick={() => downloadImage(image, 'diagram.svg')}><DownloadSimple size={16} />SVG</button>
            <button type="button" className="markdown-format-button" aria-label={t('markdown.exportDiagramPng')} disabled={exporting || !size.width} onClick={() => { void exportPng() }}><DownloadSimple size={16} />PNG</button>
            <button type="button" className="markdown-format-button" aria-label={t('common.close')} onClick={onClose}><X size={18} /></button>
          </div>
        </div>
        <p className="markdown-diagram-hint" role={failed ? 'alert' : undefined}>{t(failed ? 'markdown.diagramExportFailed' : 'markdown.diagramPanHint')}</p>
        <div ref={viewportRef} className={`markdown-diagram-viewport${dragging ? ' is-dragging' : ''}`} role="region" aria-label={t('markdown.diagram')} tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            const viewport = event.currentTarget
            drag.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }
            viewport.setPointerCapture(event.pointerId)
            setDragging(true)
          }}
          onPointerMove={(event) => {
            if (!drag.current) return
            event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x)
            event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y)
          }}
          onPointerUp={(event) => {
            drag.current = undefined
            setDragging(false)
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => { drag.current = undefined; setDragging(false) }}
          onKeyDown={(event) => {
            if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25) }
            if (event.key === '-') { event.preventDefault(); changeZoom(1 / 1.25) }
            if (event.key === '0') { event.preventDefault(); fit() }
          }}
        >
          <div className="markdown-diagram-canvas">
            <img ref={imageRef} src={image} alt={t('markdown.diagram')} draggable={false} style={size.width ? { width: size.width * zoom, height: size.height * zoom } : undefined} onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              setSize({ width, height })
              fit(width, height)
            }} />
          </div>
        </div>
      </div>
    </div>, document.body
  )
}
