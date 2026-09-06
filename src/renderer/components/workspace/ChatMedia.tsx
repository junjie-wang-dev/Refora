import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react'
import { createPortal } from 'react-dom'
import type { Components } from 'react-markdown'
import { useTranslation } from 'react-i18next'
import { ArrowSquareOut, ArrowsOut, ArrowClockwise, Copy, DownloadSimple, File, FolderOpen, Minus, Plus, X } from '@phosphor-icons/react'
import { errorMessage, type ChatMediaContext, type ChatMediaItem, type ChatMediaResource, type ChatMediaSource } from '../../../shared/ipc-types'
import { mediaSourceFromUrl } from '../../utils/mediaSources'
import { canOpenChatMedia } from '../../../shared/chatMedia'
import { api } from '../../ipc'
import { openDocumentPdf } from '../../utils/openPdf'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { canPreviewMediaFile, ChatFilePreview } from './ChatFilePreview'
import './chatMedia.css'

const MediaContext = createContext<ChatMediaContext>({})
const MessageMediaSources = createContext<Set<string>>(new Set())

export function mediaSourceKey(source: ChatMediaSource): string {
  return JSON.stringify(Object.entries(source).sort(([left], [right]) => left.localeCompare(right)))
}

export function useMessageMediaSources(): Set<string> {
  return useContext(MessageMediaSources)
}

export function ChatMediaContextProvider({ value, media, children }: PropsWithChildren<{ value: ChatMediaContext; media?: ChatMediaItem[] }>) {
  const sources = useMemo(() => new Set(media?.map((item) => mediaSourceKey(item.source)) ?? []), [media])
  return <MediaContext.Provider value={value}><MessageMediaSources.Provider value={sources}>{children}</MessageMediaSources.Provider></MediaContext.Provider>
}

function ImageViewer({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const updateZoom = (next: number) => {
    const value = Math.min(5, Math.max(0.25, next))
    setZoom(value)
    if (value <= 1) setPosition({ x: 0, y: 0 })
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => previous?.focus()
  }, [])
  return createPortal(
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="chat-image-viewer" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === '+' || event.key === '=') updateZoom(zoom + 0.25)
      if (event.key === '-') updateZoom(zoom - 0.25)
      if (event.key === '0') { updateZoom(1); setPosition({ x: 0, y: 0 }) }
      if (event.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button')
        if (!buttons?.length) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
        if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
      }
    }}>
      <div className="chat-image-viewer-toolbar">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button type="button" onClick={() => updateZoom(zoom - 0.25)} aria-label={t('workspace.chat.media.zoomOut')}><Minus /></button>
        <button type="button" onClick={() => { updateZoom(1); setPosition({ x: 0, y: 0 }) }} aria-label={t('workspace.chat.media.fit')}>{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => updateZoom(zoom + 0.25)} aria-label={t('workspace.chat.media.zoomIn')}><Plus /></button>
        <button type="button" onClick={onClose} aria-label={t('workspace.chat.media.close')}><X /></button>
      </div>
      <div className="chat-image-viewer-stage" onWheel={(event) => updateZoom(zoom + (event.deltaY < 0 ? 0.15 : -0.15))}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, px: position.x, py: position.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (drag.current) setPosition({ x: drag.current.px + event.clientX - drag.current.x, y: drag.current.py + event.clientY - drag.current.y })
        }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        <img src={url} alt={title} draggable={false} style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }} />
      </div>
    </div>, document.body
  )
}

export const ChatMediaCard = memo(function ChatMediaCard({ item, context }: { item: ChatMediaItem; context?: ChatMediaContext }) {
  const { t } = useTranslation()
  const inheritedContext = useContext(MediaContext)
  const runId = context?.runId ?? inheritedContext.runId
  const [resource, setResource] = useState<ChatMediaResource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [requestedSource, setRequestedSource] = useState<string | null>(null)
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  const [viewer, setViewer] = useState(false)
  const [actionStatus, setActionStatus] = useState('')
  const [filePreviewOpen, setFilePreviewOpen] = useState(false)
  const container = useRef<HTMLSpanElement>(null)
  const sourceKey = JSON.stringify(item.source)
  const remote = item.source.type === 'remote'
  const title = item.title || resource?.fileName || t(`workspace.chat.media.${item.kind}`)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !container.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.disconnect() }
    }, { rootMargin: '320px' })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    setViewer(false)
    setFilePreviewOpen(false)
    setResource(null)
    setLoaded(false)
    setError(null)
  }, [sourceKey])
  useEffect(() => {
    if (!near || (remote && requestedSource !== sourceKey) || item.source.type === 'unavailable') return
    let cancelled = false
    setError(null)
    setLoaded(false)
    setResource(null)
    void api.ai.resolveMedia({ source: JSON.parse(sourceKey) as ChatMediaSource, kind: item.kind, fileName: item.title, runId }).then((value) => {
      if (!cancelled) setResource(value)
    }).catch((value) => { if (!cancelled) setError(errorMessage(value)) })
    return () => { cancelled = true }
  }, [sourceKey, item.kind, item.title, runId, near, requestedSource, remote, attempt])
  const action = (operation: () => Promise<unknown>, success?: string) => {
    setActionStatus('')
    void operation().then((result) => { if (success && result !== false) setActionStatus(success) }).catch((value) => setActionStatus(errorMessage(value)))
  }
  const mediaError = () => setError(t('workspace.chat.media.loadFailed'))
  return (
    <span ref={container} className="chat-media-card" data-media-kind={resource?.kind ?? item.kind}>
      {item.source.type === 'unavailable' ? (<span className="chat-media-placeholder" role="status"><span>{t('workspace.chat.media.loadFailed')}</span><span>{item.source.reason}</span></span>) : remote && requestedSource !== sourceKey ? (
        <span className="chat-media-placeholder">
          <span>{t('workspace.chat.media.remoteHint')}</span>
          <span className="break-all text-xs text-muted">{item.source.type === 'remote' ? (() => { try { return new URL(item.source.url).hostname } catch { return '' } })() : ''}</span>
          <button type="button" onClick={() => { setRequestedSource(sourceKey); setNear(true) }}>{t('workspace.chat.media.loadRemote')}</button>
        </span>
      ) : error ? (
        <span className="chat-media-placeholder" role="status">
          <span>{t('workspace.chat.media.loadFailed')}</span>
          <span className="break-all text-xs text-muted">{error}</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}><ArrowClockwise />{t('workspace.chat.media.retry')}</button>
        </span>
      ) : resource ? (
        resource.kind === 'image' ? (
          <span className="chat-media-preview">
            {!loaded && <span role="status" className="chat-media-loading">{t('workspace.chat.media.loading')}</span>}
            <button type="button" className="chat-media-image-button" aria-label={t('workspace.chat.media.expandImage', { title })} onClick={() => setViewer(true)}>
              <img src={resource.url} alt={title} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={mediaError} />
              <ArrowsOut className="chat-media-expand" aria-hidden="true" />
            </button>
          </span>
        ) : resource.kind === 'audio' ? (
          <audio controls preload="metadata" src={resource.url} aria-label={title} onError={mediaError} />
        ) : resource.kind === 'video' ? (
          <video controls preload="metadata" src={resource.url} aria-label={title} onError={mediaError} />
        ) : <span className="chat-media-file"><File aria-hidden="true" /><span>{title}</span></span>
      ) : <span className="chat-media-placeholder" role="status">{t('workspace.chat.media.loading')}</span>}
      <span className="chat-media-caption">
        <span className="min-w-0 flex-1">{resource && canOpenChatMedia(resource.mimeType) ? <button type="button" className="block max-w-full truncate text-left" title={title} onClick={() => action(() => api.ai.openMedia(resource.id))}>{title}</button> : <span className="block truncate" title={title}>{title}</span>}
          {resource && <span className="block text-xs text-muted">{resource.mimeType} · {resource.byteLength < 1024 * 1024 ? `${Math.ceil(resource.byteLength / 1024)} KB` : `${(resource.byteLength / 1024 / 1024).toFixed(1)} MB`}</span>}
        </span>
        {resource && <span className="chat-media-actions">
          {canOpenChatMedia(resource.mimeType) && <button type="button" aria-label={t('workspace.chat.media.open')} title={t('workspace.chat.media.open')} onClick={() => action(() => api.ai.openMedia(resource.id))}><ArrowSquareOut /></button>}
          <button type="button" aria-label={t('workspace.chat.media.copy')} title={t('workspace.chat.media.copy')} onClick={() => action(() => api.ai.copyMedia(resource.id), t('workspace.chat.media.copied'))}><Copy /></button>
          <button type="button" aria-label={t('workspace.chat.media.save')} title={t('workspace.chat.media.save')} onClick={() => action(() => api.ai.saveMedia(resource.id), t('workspace.chat.media.saved'))}><DownloadSimple /></button>
          <button type="button" aria-label={t('workspace.chat.media.reveal')} title={t('workspace.chat.media.reveal')} onClick={() => action(() => api.ai.revealMedia(resource.id))}><FolderOpen /></button>
        </span>}
      </span>
      {resource && canPreviewMediaFile(resource) && <button type="button" className="chat-media-origin" aria-expanded={filePreviewOpen} onClick={() => setFilePreviewOpen((value) => !value)}>{t(filePreviewOpen ? 'workspace.chat.media.hidePreview' : 'workspace.chat.media.preview')}</button>}
      {resource && filePreviewOpen && <ChatFilePreview resource={resource} />}
      {item.source.type === 'asset' && <button type="button" className="chat-media-origin" onClick={() => useWorkspaceStore.getState().showWorkspace()}>{t('workspace.chat.media.workspace')}</button>}
      {item.source.type === 'ocr' && <button type="button" className="chat-media-origin" onClick={() => action(() => openDocumentPdf(item.source.type === 'ocr' ? item.source.documentId : ''))}>{t('workspace.chat.media.sourcePaper')}</button>}
      {resource?.sourceUrl && <a className="chat-media-origin" href={resource.sourceUrl} target="_blank" rel="noreferrer">{t('workspace.chat.media.source')}</a>}
      {actionStatus && <span className="px-3 pb-2 text-xs text-muted" role="status">{actionStatus}</span>}
      {viewer && resource && <ImageViewer url={resource.url} title={title} onClose={() => setViewer(false)} />}
    </span>
  )
})

export function ChatMedia({ media, context, excludeMarkdown }: { media?: ChatMediaItem[]; context?: ChatMediaContext; excludeMarkdown?: string }) {
  const inheritedContext = useContext(MediaContext)
  const inlineSources = new Set([...((excludeMarkdown ?? '').matchAll(/!\[[^\]]*\]\(<?([^\s>)]+)>?|<(?:img|audio|video)\b[^>]*?\bsrc=["']([^"']+)["']/gi))].flatMap((match) => {
    const source = mediaSourceFromUrl(match[1] || match[2], context ?? inheritedContext)
    return source ? [mediaSourceKey(source)] : []
  }))
  const visible = media?.filter((item) => !inlineSources.has(mediaSourceKey(item.source)))
  if (!visible?.length) return null
  return <div className="chat-media-list">{visible.map((item) => <ChatMediaCard key={item.id} item={item} context={context} />)}</div>
}

function MarkdownMedia({ src, title, kind }: { src?: string; title?: string; kind: ChatMediaItem['kind'] }) {
  const { t } = useTranslation()
  const context = useContext(MediaContext)
  const source = useMemo(() => src ? mediaSourceFromUrl(src, context) : null, [src, context])
  if (!source) return <span className="chat-media-unavailable" role="status">{title || t(`workspace.chat.media.${kind}`)}: {t('workspace.chat.media.invalidSource')}</span>
  return <ChatMediaCard item={{ id: src!, kind, source, title }} />
}

export const MarkdownMediaComponents: Partial<Components> = {
  img: ({ src, alt, title }) => <MarkdownMedia src={typeof src === 'string' ? src : undefined} title={alt || title} kind="image" />,
  audio: ({ src, title }) => <MarkdownMedia src={src} title={title} kind="audio" />,
  video: ({ src, title }) => <MarkdownMedia src={src} title={title} kind="video" />
}
