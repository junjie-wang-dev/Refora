import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle,
  Highlighter,
  ListBullets,
  MagnifyingGlass,
  Trash,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import { usePdfReaderStore } from '../store/pdfReaderStore'
import type { PdfAnnotation } from '../store/pdfReaderStore'

export default function PdfAnnotationSidebar({
  annotations,
  documentId,
  overlay,
  onClose,
  onNavigate
}: {
  annotations: PdfAnnotation[]
  documentId: string
  overlay: boolean
  onClose: () => void
  onNavigate: (page: number, annotationId: string) => void
}) {
  const { t } = useTranslation()
  const selectedIds = usePdfReaderStore((state) => state.selectedAnnotationIds)
  const pendingCommentFocusId = usePdfReaderStore((state) => state.pendingCommentFocusId)
  const saveStatus = usePdfReaderStore(
    (state) => state.saveStatus[documentId] ?? 'idle'
  )
  const updateAnnotation = usePdfReaderStore((state) => state.updateAnnotation)
  const removeAnnotation = usePdfReaderStore((state) => state.removeAnnotation)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleAnnotations = annotations
    .filter((annotation) => {
      if (!normalizedQuery) return true
      return [
        annotation.text,
        annotation.comment,
        t(`pdfReader.tools.${annotation.kind}`),
        String(annotation.page)
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
    })
    .sort((first, second) =>
      first.page - second.page || first.createdAt - second.createdAt
    )

  useEffect(() => {
    if (!pendingCommentFocusId) return
    const frame = window.requestAnimationFrame(() => {
      const textarea = Array.from(
        listRef.current?.querySelectorAll<HTMLTextAreaElement>(
          '[data-comment-annotation-id]'
        ) ?? []
      ).find((element) => element.dataset.commentAnnotationId === pendingCommentFocusId)
      textarea?.focus()
      textarea?.scrollIntoView({ block: 'nearest' })
      usePdfReaderStore.getState().consumeCommentFocus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [annotations, pendingCommentFocusId])

  useEffect(() => {
    if (pendingCommentFocusId) return
    const selectedId = selectedIds.at(-1)
    if (!selectedId) return
    const frame = window.requestAnimationFrame(() => {
      const card = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>('[data-annotation-card]') ?? []
      ).find((element) => element.dataset.annotationCard === selectedId)
      card?.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pendingCommentFocusId, selectedIds])

  return (
    <aside
      data-annotation-sidebar
      data-overlay={overlay || undefined}
      aria-label={t('pdfReader.annotations')}
      className={`flex w-72 shrink-0 flex-col border-l border-border bg-panel ${
      overlay
        ? 'absolute inset-y-0 right-0 z-40 max-w-[calc(100%-3rem)] shadow-[-12px_0_32px_rgba(0,0,0,0.22)]'
        : ''
      }`}
    >
      <div className="flex h-11 items-center gap-2 border-b border-border px-3">
        <ListBullets className="h-4 w-4 text-muted" />
        <span className="text-xs font-medium">{t('pdfReader.annotations')}</span>
        <span className="rounded-full bg-panel-2 px-2 py-0.5 text-label text-muted">
          {annotations.length}
        </span>
        <button
          type="button"
          disabled={saveStatus !== 'error'}
          aria-live="polite"
          className={`ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-label ${
            saveStatus === 'error' ? 'text-error' : 'text-muted'
          } disabled:cursor-default`}
          title={t(`pdfReader.saveStatus.${saveStatus}`)}
          onClick={() => usePdfReaderStore.getState().retrySave(documentId)}
        >
          {saveStatus === 'saved' && <CheckCircle className="h-3.5 w-3.5" weight="fill" />}
          {saveStatus === 'error' && <WarningCircle className="h-3.5 w-3.5" weight="fill" />}
          <span>
            {saveStatus === 'error'
              ? t('pdfReader.retrySave')
              : t(`pdfReader.saveStatus.${saveStatus}`)}
          </span>
        </button>
        {overlay && (
          <button
            type="button"
            className="rounded-md p-1 text-muted hover:bg-hover hover:text-foreground"
            aria-label={t('pdfReader.closeAnnotations')}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="border-b border-border p-2">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute left-2 top-1.5 h-4 w-4 text-muted" />
          <input
            value={query}
            aria-label={t('pdfReader.searchAnnotations')}
            placeholder={t('pdfReader.searchAnnotations')}
            className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground outline-none focus:border-accent"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {annotations.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-12 text-center text-xs text-muted">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-panel-2 text-accent">
              <Highlighter className="h-5 w-5" />
            </div>
            <span className="font-medium text-foreground">
              {t('pdfReader.noAnnotationsTitle')}
            </span>
            <span className="mt-1.5 leading-relaxed">
              {t('pdfReader.noAnnotations')}
            </span>
            <span className="mt-3 rounded-md bg-panel-2 px-2 py-1 text-label">
              {t('pdfReader.annotationHint')}
            </span>
          </div>
        ) : visibleAnnotations.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted">
            {t('pdfReader.noAnnotationResults')}
          </div>
        ) : visibleAnnotations.map((annotation) => (
          <div
            key={annotation.id}
            data-annotation-card={annotation.id}
            className={`mb-2 rounded-lg border p-2.5 ${
              selectedIds.includes(annotation.id)
                ? 'border-accent bg-active'
                : 'border-border bg-background'
            }`}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left"
              onClick={() => onNavigate(annotation.page, annotation.id)}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: annotation.color }}
              />
              <span className="text-label font-medium text-foreground">
                {t(`pdfReader.tools.${annotation.kind}`)}
              </span>
              <span className="ml-auto text-label text-muted">
                {t('pdfReader.pageShort', { page: annotation.page })}
              </span>
            </button>
            {annotation.text && (
              <button
                type="button"
                className="mt-2 line-clamp-3 w-full border-l-2 pl-2 text-left text-label leading-relaxed text-muted"
                style={{ borderColor: annotation.color }}
                onClick={() => onNavigate(annotation.page, annotation.id)}
              >
                {annotation.text}
              </button>
            )}
            <textarea
              value={annotation.comment}
              rows={selectedIds.includes(annotation.id) ? 3 : 1}
              data-comment-annotation-id={annotation.id}
              placeholder={t('pdfReader.addComment')}
              className="mt-2 w-full resize-none rounded-md border border-border bg-panel-2 px-2 py-1.5 text-label text-foreground outline-none focus:border-accent"
              onFocus={() => {
                usePdfReaderStore.getState().setTool(null)
                usePdfReaderStore.getState().selectAnnotation(annotation.id)
              }}
              onChange={(event) => updateAnnotation(
                documentId,
                annotation.id,
                { comment: event.target.value }
              )}
            />
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                className="rounded p-1 text-muted hover:bg-hover hover:text-error"
                aria-label={t('common.delete')}
                onClick={() => removeAnnotation(documentId, annotation.id)}
              >
                <Trash className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
