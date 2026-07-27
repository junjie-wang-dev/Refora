import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { Sparkle, FileText, Copy, Trash, CircleNotch, WarningCircle, ArrowClockwise } from '@phosphor-icons/react'
import { motion, MotionConfig } from 'motion/react'
import { Badge, cardClassName } from '../ui'
import type { AiSummary, Document } from '../../../shared/ipc-types'
import { formatAuthors } from '../../utils/format'

interface PaperCardProps {
  doc: Document | null
  summary: AiSummary | null
  summarizing: boolean
  summaryError: string | null
  onSummarize: () => void
  onOpenPdf: () => void
  onRemove: () => void
  onOpenSummary?: () => void
  onCopy?: () => void
}

function PaperPreview({
  doc,
  version,
  label,
  onOpenPdf
}: {
  doc: Document | null
  version: string
  label: string
  onOpenPdf: () => void
}) {
  const [failed, setFailed] = useState(false)
  const showFallback = failed || !doc || doc.fileMissing === 1

  return (
    <button
      type="button"
      data-paper-preview
      data-card-drag-click
      className={`relative h-full max-w-[70%] shrink-0 cursor-pointer overflow-hidden bg-white text-muted disabled:cursor-default ${showFallback ? 'aspect-[3/4]' : ''}`}
      aria-label={label}
      disabled={!doc || doc.fileMissing === 1}
      onClick={(event) => {
        event.stopPropagation()
        onOpenPdf()
      }}
    >
      <div className="absolute inset-0 flex items-center justify-center bg-panel-2 text-muted">
        <FileText className="h-8 w-8" />
      </div>
      {doc && doc.fileMissing !== 1 && !failed && (
        <img
          src={window.api.documents.previewUrl(doc.id, version)}
          alt=""
          data-paper-preview-image
          className="relative block h-full w-auto max-w-none object-cover"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </button>
  )
}

export default function PaperCard({
  doc,
  summary,
  summarizing,
  summaryError,
  onSummarize,
  onOpenPdf,
  onRemove,
  onOpenSummary,
  onCopy
}: PaperCardProps) {
  const { t } = useTranslation()

  const title = doc?.title || doc?.fileName || '…'
  const authors = formatAuthors(doc?.authors)
  const content = summary?.content ?? null
  const keyPoints = content?.keyPoints ?? []
  const previewVersion = doc ? `${doc.fileHash ?? 'unhashed'}-${doc.updatedAt}` : ''

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const menuItems: ContextMenuItem[] = [
      {
        key: 'copy',
        label: t('workspace.cardCopy'),
        icon: <Copy className="h-3.5 w-3.5" />,
        onClick: () => onCopy?.(),
        disabled: !doc
      },
      {
        key: 'summarize',
        label: t('workspace.aiSummary'),
        icon: <Sparkle className="h-3.5 w-3.5" />,
        onClick: onSummarize
      },
      {
        key: 'openPdf',
        label: t('workspace.openPdf'),
        icon: <FileText className="h-3.5 w-3.5" />,
        onClick: onOpenPdf
      },
      { type: 'divider', key: 'divider' },
      {
        key: 'remove',
        label: t('workspace.removeFromWorkspace'),
        icon: <Trash className="h-3.5 w-3.5" />,
        onClick: onRemove,
        danger: true
      }
    ]
    showContextMenu(menuItems)
  }

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        data-card-kind="document"
        className={cardClassName('default', false, 'workspace-content-card workspace-content-card--document group/card h-full w-full overflow-hidden')}
        onContextMenu={handleContextMenu}
      >
        <div className="flex h-full min-h-0">
          <PaperPreview
            key={`${doc?.id ?? 'missing'}-${previewVersion}`}
            doc={doc}
            version={previewVersion}
            label={t('workspace.pdfPreview')}
            onOpenPdf={onOpenPdf}
          />
          <div
            data-paper-details
            data-card-drag-click
            className={`flex min-w-0 flex-1 flex-col gap-2 p-3 ${onOpenSummary ? 'cursor-pointer' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onOpenSummary?.()
            }}
          >
            <div className="flex shrink-0 items-start gap-2">
              <div className="workspace-card-heading min-w-0 flex-1">
                <span className="workspace-card-type-label">{t('workspace.cardTypePaper')}</span>
                <h3 className="workspace-card-title line-clamp-2 text-base font-semibold text-foreground">{title}</h3>
                {authors && <p className="mt-0.5 truncate text-xs text-muted">{authors}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100">
                {!content && !summarizing && !summaryError && (
                  <button
                    type="button"
                    className="rounded p-1 text-muted transition-colors duration-150 hover:text-accent"
                    onClick={(e) => { e.stopPropagation(); onSummarize() }}
                    title={t('workspace.aiSummary')}
                    aria-label={t('workspace.aiSummary')}
                  >
                    <Sparkle className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  className="rounded p-1 text-muted transition-colors duration-150 hover:text-accent"
                  onClick={(e) => { e.stopPropagation(); onOpenPdf() }}
                  title={t('workspace.openPdf')}
                  aria-label={t('workspace.openPdf')}
                >
                  <FileText className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted transition-colors duration-150 hover:text-error"
                  onClick={(e) => { e.stopPropagation(); onRemove() }}
                  title={t('workspace.removeFromWorkspace')}
                  aria-label={t('workspace.removeFromWorkspace')}
                >
                  <Trash className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {(doc?.year || doc?.venue) && (
              <div className="flex shrink-0 flex-wrap gap-1">
                {doc?.year && <Badge variant="default" size="md">{doc.year}</Badge>}
                {doc?.venue && <Badge variant="default" size="md">{doc.venue}</Badge>}
              </div>
            )}

            <div
              data-card-scroll
              className="workspace-card-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain text-xs"
              onWheel={(event) => event.stopPropagation()}
            >
              {summarizing ? (
                <div className="flex items-center gap-1.5 text-muted">
                  <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                  <span>{t('workspace.summarizing')}</span>
                </div>
              ) : summaryError ? (
                <div className="space-y-1.5">
                  <div className="flex items-start gap-1.5 rounded-lg bg-error/10 px-2 py-1.5 text-error">
                    <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="line-clamp-3">{summaryError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSummarize()
                    }}
                    className="inline-flex items-center gap-1 text-muted transition-colors duration-150 hover:text-foreground"
                  >
                    <ArrowClockwise className="h-3 w-3" />
                    {t('workspace.retry')}
                  </button>
                </div>
              ) : content ? (
                <div className="space-y-2 text-foreground">
                  <p>{content.core}</p>
                  {keyPoints.length > 0 && (
                    <ul className="space-y-0.5">
                      {keyPoints.map((kp, i) => (
                        <li key={i} className="flex gap-1">
                          <span className="shrink-0 text-accent">•</span>
                          <span className="text-muted">{kp}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {content.methods && <p className="text-muted">{content.methods}</p>}
                  {content.contribution && <p className="text-muted">{content.contribution}</p>}
                </div>
              ) : (
                <p className="italic text-muted">{t('workspace.summarizeHint')}</p>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </MotionConfig>
  )
}
