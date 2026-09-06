import { useEffect, useId, useRef, useState } from 'react'
import { BookmarkSimple, CaretDown, CaretRight, PencilSimple, Plus, Trash, X } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/types/src/display/api'

export interface PdfNavigationBookmark {
  id: string
  title: string
  page: number
  x: number
  y: number
}

interface OutlineItem {
  title: string
  dest: string | unknown[] | null
  items: OutlineItem[]
}

interface PdfNavigationSidebarProps {
  pdf: PDFDocumentProxy
  currentPage: number
  rotation: number
  bookmarks: PdfNavigationBookmark[]
  onNavigate: (page: number, position?: { x: number; y: number }) => void
  onNavigateDestination: (destination: string | unknown[]) => void
  onAddBookmark: () => void
  onRenameBookmark: (id: string, title: string) => void
  onRemoveBookmark: (id: string) => void
  onClose: () => void
  overlay: boolean
}

type NavigationSection = 'outline' | 'pages' | 'bookmarks'
const sections: NavigationSection[] = ['outline', 'pages', 'bookmarks']
const thumbnailRowHeight = 184

function OutlineBranch({
  item,
  depth,
  onNavigate
}: {
  item: OutlineItem
  depth: number
  onNavigate: PdfNavigationSidebarProps['onNavigateDestination']
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(depth === 0)
  const childrenId = useId()
  const hasChildren = item.items.length > 0

  return (
    <li>
      <div className="flex items-start gap-1 rounded-md hover:bg-hover">
        {hasChildren ? (
          <button
            type="button"
            className="mt-1 shrink-0 rounded p-1 text-muted focus-visible:outline-accent"
            aria-label={t(expanded ? 'pdfReader.navigation.collapse' : 'pdfReader.navigation.expand', { title: item.title })}
            aria-expanded={expanded}
            aria-controls={childrenId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <CaretDown className="h-3 w-3" /> : <CaretRight className="h-3 w-3" />}
          </button>
        ) : <span className="w-5 shrink-0" />}
        <button
          type="button"
          className="min-w-0 flex-1 break-words rounded py-2 pr-2 text-left text-xs leading-5 focus-visible:outline-accent disabled:text-muted"
          disabled={!item.dest && !hasChildren}
          onClick={() => {
            if (item.dest) onNavigate(item.dest)
            else setExpanded((value) => !value)
          }}
        >
          {item.title}
        </button>
      </div>
      {hasChildren && expanded && (
        <ul id={childrenId} className="ml-3 border-l border-border pl-1">
          {item.items.map((child, index) => (
            <OutlineBranch key={index} item={child} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </li>
  )
}

function PdfOutline({ pdf, onNavigate }: {
  pdf: PDFDocumentProxy
  onNavigate: PdfNavigationSidebarProps['onNavigateDestination']
}) {
  const { t } = useTranslation()
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setOutline([])
    void pdf.getOutline().then((items) => {
      if (cancelled) return
      setOutline(items ?? [])
      setStatus('loaded')
    }).catch(() => {
      if (!cancelled) setStatus('error')
    })
    return () => { cancelled = true }
  }, [pdf, attempt])

  if (status === 'loading') {
    return <p role="status" className="p-5 text-center text-xs text-muted">{t('pdfReader.navigation.loadingOutline')}</p>
  }
  if (status === 'error') {
    return (
      <div className="p-5 text-center text-xs">
        <p role="alert" className="text-error">{t('pdfReader.navigation.outlineError')}</p>
        <button type="button" className="mt-3 rounded border border-border px-3 py-1.5 hover:bg-hover" onClick={() => setAttempt((value) => value + 1)}>
          {t('pdfReader.navigation.retry')}
        </button>
      </div>
    )
  }
  if (outline.length === 0) {
    return <p className="p-5 text-center text-xs text-muted">{t('pdfReader.navigation.noOutline')}</p>
  }
  return (
    <ul className="p-2">
      {outline.map((item, index) => <OutlineBranch key={index} item={item} depth={0} onNavigate={onNavigate} />)}
    </ul>
  )
}

function PdfThumbnail({ pdf, pageNumber, rotation, selected, onNavigate }: {
  pdf: PDFDocumentProxy
  pageNumber: number
  rotation: number
  selected: boolean
  onNavigate: PdfNavigationSidebarProps['onNavigate']
}) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let renderTask: RenderTask | undefined
    setStatus('loading')
    void pdf.getPage(pageNumber).then(async (page) => {
      const canvas = canvasRef.current
      if (cancelled || !canvas) return
      const pageRotation = ((page.rotate + rotation) % 360 + 360) % 360
      const originalViewport = page.getViewport({ scale: 1, rotation: pageRotation })
      const scale = Math.min(160 / originalViewport.width, 136 / originalViewport.height)
      const viewport = page.getViewport({ scale, rotation: pageRotation })
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.ceil(viewport.width * pixelRatio)
      canvas.height = Math.ceil(viewport.height * pixelRatio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      renderTask = page.render({
        canvas,
        viewport,
        transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
        background: '#ffffff'
      })
      await renderTask.promise
      if (!cancelled) setStatus('loaded')
    }).catch(() => {
      if (!cancelled) setStatus('error')
    })
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [pdf, pageNumber, rotation, attempt])

  return (
    <div className="relative mx-3 h-full py-2" data-thumbnail-page={pageNumber}>
      <button
        type="button"
        className={`flex h-full w-full flex-col items-center justify-between rounded-lg border p-2 focus-visible:outline-accent ${selected ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-hover'}`}
        aria-label={t('pdfReader.navigation.page', { page: pageNumber })}
        aria-current={selected ? 'page' : undefined}
        onClick={() => onNavigate(pageNumber)}
      >
        <span className="relative flex h-[136px] w-full items-center justify-center overflow-hidden">
          <canvas ref={canvasRef} className={status === 'loaded' ? 'block shadow-sm' : 'invisible'} aria-hidden="true" />
          {status !== 'loaded' && (
            <span className={`absolute inset-0 flex items-center justify-center text-label ${status === 'error' ? 'text-error' : 'text-muted'}`}>
              {t(status === 'error' ? 'pdfReader.navigation.thumbnailError' : 'pdfReader.navigation.thumbnailLoading')}
            </span>
          )}
        </span>
        <span className={`text-xs ${selected ? 'font-medium text-accent' : 'text-muted'}`}>{pageNumber}</span>
      </button>
      {status === 'error' && (
        <button type="button" className="absolute bottom-4 right-3 rounded bg-panel px-2 text-label text-accent hover:bg-hover" onClick={() => setAttempt((value) => value + 1)}>
          {t('pdfReader.navigation.retry')}
        </button>
      )}
    </div>
  )
}

function PdfThumbnails({ pdf, currentPage, rotation, onNavigate }: {
  pdf: PDFDocumentProxy
  currentPage: number
  rotation: number
  onNavigate: PdfNavigationSidebarProps['onNavigate']
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(552)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => setHeight(container.clientHeight || 552))
    observer.observe(container)
    setHeight(container.clientHeight || 552)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const pageTop = (currentPage - 1) * thumbnailRowHeight
    const visibleHeight = container.clientHeight || 552
    let nextScroll = container.scrollTop
    if (pageTop < nextScroll) nextScroll = pageTop
    else if (pageTop + thumbnailRowHeight > nextScroll + visibleHeight) {
      nextScroll = pageTop + thumbnailRowHeight - visibleHeight
    }
    container.scrollTop = Math.max(0, nextScroll)
    setScrollTop(container.scrollTop)
  }, [currentPage, pdf])

  const startIndex = Math.max(0, Math.floor(scrollTop / thumbnailRowHeight) - 2)
  const endIndex = Math.min(pdf.numPages, Math.ceil((scrollTop + height) / thumbnailRowHeight) + 2)

  return (
    <div ref={containerRef} className="h-full overflow-y-auto" data-pdf-thumbnails onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div className="relative" style={{ height: pdf.numPages * thumbnailRowHeight }}>
        {Array.from({ length: Math.max(0, endIndex - startIndex) }, (_, index) => {
          const pageNumber = startIndex + index + 1
          return (
            <div key={`${pageNumber}:${rotation}`} className="absolute left-0 right-0" style={{ top: (pageNumber - 1) * thumbnailRowHeight, height: thumbnailRowHeight }}>
              <PdfThumbnail pdf={pdf} pageNumber={pageNumber} rotation={rotation} selected={currentPage === pageNumber} onNavigate={onNavigate} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BookmarkRow({ bookmark, onNavigate, onRename, onRemove }: {
  bookmark: PdfNavigationBookmark
  onNavigate: PdfNavigationSidebarProps['onNavigate']
  onRename: PdfNavigationSidebarProps['onRenameBookmark']
  onRemove: PdfNavigationSidebarProps['onRemoveBookmark']
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(bookmark.title)

  if (editing) {
    return (
      <li className="rounded-lg border border-accent p-2">
        <form onSubmit={(event) => {
          event.preventDefault()
          const nextTitle = title.trim()
          if (!nextTitle) return
          onRename(bookmark.id, nextTitle)
          setEditing(false)
        }}>
          <input
            autoFocus
            aria-label={t('pdfReader.navigation.bookmarkTitle')}
            value={title}
            maxLength={200}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-accent"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setEditing(false)
              }
            }}
          />
          <div className="mt-2 flex justify-end gap-1">
            <button type="button" className="rounded px-2 py-1 text-xs text-muted hover:bg-hover" onClick={() => setEditing(false)}>{t('pdfReader.navigation.cancelBookmark')}</button>
            <button type="submit" disabled={!title.trim()} className="rounded bg-accent px-2 py-1 text-xs text-white disabled:opacity-50">{t('pdfReader.navigation.saveBookmark')}</button>
          </div>
        </form>
      </li>
    )
  }

  return (
    <li className="group flex items-start gap-1 rounded-lg p-2 hover:bg-hover">
      <button type="button" aria-label={`${bookmark.title}, ${t('pdfReader.navigation.page', { page: bookmark.page })}`} className="min-w-0 flex-1 rounded text-left focus-visible:outline-accent" onClick={() => onNavigate(bookmark.page, { x: bookmark.x, y: bookmark.y })}>
        <span className="flex items-start gap-2 text-xs leading-5"><BookmarkSimple className="mt-0.5 h-4 w-4 shrink-0 text-accent" /><span className="break-words">{bookmark.title}</span></span>
        <span className="ml-6 text-label text-muted">{t('pdfReader.navigation.page', { page: bookmark.page })}</span>
      </button>
      <button type="button" aria-label={t('pdfReader.navigation.renameBookmark', { title: bookmark.title })} className="rounded p-1 text-muted hover:bg-panel hover:text-foreground" onClick={() => { setTitle(bookmark.title); setEditing(true) }}><PencilSimple className="h-3.5 w-3.5" /></button>
      <button type="button" aria-label={t('pdfReader.navigation.removeBookmark', { title: bookmark.title })} className="rounded p-1 text-muted hover:bg-panel hover:text-error" onClick={() => onRemove(bookmark.id)}><Trash className="h-3.5 w-3.5" /></button>
    </li>
  )
}

export default function PdfNavigationSidebar({
  pdf,
  currentPage,
  rotation,
  bookmarks,
  onNavigate,
  onNavigateDestination,
  onAddBookmark,
  onRenameBookmark,
  onRemoveBookmark,
  onClose,
  overlay
}: PdfNavigationSidebarProps) {
  const { t } = useTranslation()
  const [section, setSection] = useState<NavigationSection>('outline')
  const id = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  return (
    <aside
      data-pdf-navigation
      data-overlay={overlay || undefined}
      aria-label={t('pdfReader.navigation.title')}
      className={`flex w-60 shrink-0 flex-col border-r border-border bg-panel ${overlay ? 'absolute inset-y-0 left-0 z-40 max-w-[calc(100%-3rem)] shadow-[12px_0_32px_rgba(0,0,0,0.22)]' : ''}`}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-xs font-medium">{t('pdfReader.navigation.title')}</span>
        <button type="button" aria-label={t('pdfReader.navigation.close')} className="rounded p-1 text-muted hover:bg-hover hover:text-foreground" onClick={onClose}><X className="h-4 w-4" /></button>
      </div>
      <div role="tablist" aria-label={t('pdfReader.navigation.title')} className="flex shrink-0 gap-1 border-b border-border p-2">
        {sections.map((entry, index) => (
          <button
            key={entry}
            ref={(element) => { tabRefs.current[index] = element }}
            type="button"
            role="tab"
            id={`${id}-${entry}`}
            aria-controls={`${id}-panel`}
            aria-selected={section === entry}
            tabIndex={section === entry ? 0 : -1}
            className={`flex-1 rounded py-1.5 text-xs focus-visible:outline-accent ${section === entry ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-hover'}`}
            onClick={() => setSection(entry)}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowRight' ? (index + 1) % sections.length
                : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : -1
              if (next < 0) return
              event.preventDefault()
              setSection(sections[next])
              tabRefs.current[next]?.focus()
            }}
          >
            {t(`pdfReader.navigation.${entry}`)}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${section}`} className={`min-h-0 flex-1 ${section === 'pages' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        {section === 'outline' && <PdfOutline pdf={pdf} onNavigate={onNavigateDestination} />}
        {section === 'pages' && <PdfThumbnails pdf={pdf} currentPage={currentPage} rotation={rotation} onNavigate={onNavigate} />}
        {section === 'bookmarks' && (
          <div className="p-2">
            <button type="button" className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-2 text-xs hover:bg-hover" onClick={onAddBookmark}><Plus className="h-3.5 w-3.5" />{t('pdfReader.navigation.addBookmark')}</button>
            {bookmarks.length === 0
              ? <p className="px-3 py-5 text-center text-xs text-muted">{t('pdfReader.navigation.noBookmarks')}</p>
              : <ul className="space-y-1">{bookmarks.map((bookmark) => <BookmarkRow key={bookmark.id} bookmark={bookmark} onNavigate={onNavigate} onRename={onRenameBookmark} onRemove={onRemoveBookmark} />)}</ul>}
          </div>
        )}
      </div>
    </aside>
  )
}
