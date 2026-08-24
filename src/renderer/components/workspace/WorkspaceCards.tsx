import { memo } from 'react'
import type { ComponentProps } from 'react'
import type {
  AiSummary,
  AiReport,
  Document,
  WorkspaceAsset,
  WorkspaceItem,
  WorkspaceNote
} from '../../../shared/ipc-types'
import { markdownCardContent, paperCardMarkdown } from '../../utils/workspaceCardMarkdown'
import { openDocumentPdf } from '../../utils/openPdf'
import AssetCard from './AssetCard'
import NoteCard from './NoteCard'
import PaperCard from './PaperCard'
import ReportCard from './ReportCard'
import ResizableCard, { clampCardSize } from './ResizableCard'
import StickyNoteCard from './StickyNoteCard'

const MemoizedPaperCard = memo(PaperCard)
const MemoizedReportCard = memo(ReportCard)
const MemoizedNoteCard = memo(NoteCard)
const MemoizedStickyNoteCard = memo(StickyNoteCard)
const MemoizedAssetCard = memo(AssetCard)

type CardShellProps = Omit<
  ComponentProps<typeof ResizableCard>,
  'children' | 'sizeKey' | 'size' | 'position' | 'selected' | 'animatePosition' | 'className'
>

type OpenMarkdownCard = (
  card:
    | { kind: 'note' | 'report'; id: string }
    | { kind: 'summary'; doc: Document; summary: AiSummary },
  mode?: 'read' | 'edit'
) => void

interface CardFrameProps {
  item: WorkspaceItem
  shell: CardShellProps
  selected: boolean
  animatePosition: boolean
}

interface DocumentCardProps extends CardFrameProps {
  doc: Document | null
  summary: AiSummary | null
  summaryLoading: boolean
  summarizing: boolean
  summaryError: string | null
  onSummarize: (docId: string) => void
  onRemoveItem: (itemId: string) => void
  onCopyMarkdown: (title: string, content: string) => void
  onOpenMarkdownCard?: OpenMarkdownCard
}

const DocumentCard = memo(function DocumentCard({
  item,
  shell,
  selected,
  animatePosition,
  doc,
  summary,
  summaryLoading,
  summarizing,
  summaryError,
  onSummarize,
  onRemoveItem,
  onCopyMarkdown,
  onOpenMarkdownCard
}: DocumentCardProps) {
  const docId = item.docId ?? ''
  const summaryForReader = summary?.content ? summary : null
  return (
    <ResizableCard
      {...shell}
      sizeKey={item.id}
      size={clampCardSize({ width: item.width, height: item.height })}
      position={{ x: item.x, y: item.y, zIndex: item.zIndex }}
      selected={selected}
      animatePosition={animatePosition}
      className="workspace-connection-accent--document"
    >
      <MemoizedPaperCard
        doc={doc}
        summary={summary}
        summaryLoading={summaryLoading}
        summarizing={summarizing}
        summaryError={summaryError}
        onSummarize={() => onSummarize(docId)}
        onOpenPdf={() => void openDocumentPdf(docId)}
        onRemove={() => onRemoveItem(item.id)}
        onOpenSummary={doc && summaryForReader && onOpenMarkdownCard
          ? () => onOpenMarkdownCard({ kind: 'summary', doc, summary: summaryForReader })
          : undefined}
        onCopy={doc
          ? () => onCopyMarkdown(doc.title || doc.fileName, paperCardMarkdown(doc, summary))
          : undefined}
      />
    </ResizableCard>
  )
})

interface ReportCardItemProps extends CardFrameProps {
  report: AiReport
  documents: Map<string, Document>
  onDeleteReport: (reportId: string) => void
  onUpdateReport: ComponentProps<typeof ReportCard>['onUpdate']
  onCopyMarkdown: (title: string, content: string) => void
  onOpenMarkdownCard?: OpenMarkdownCard
}

const ReportCardItem = memo(function ReportCardItem({
  item,
  shell,
  selected,
  animatePosition,
  report,
  documents,
  onDeleteReport,
  onUpdateReport,
  onCopyMarkdown,
  onOpenMarkdownCard
}: ReportCardItemProps) {
  return (
    <ResizableCard
      {...shell}
      sizeKey={item.id}
      size={clampCardSize({ width: item.width, height: item.height })}
      position={{ x: item.x, y: item.y, zIndex: item.zIndex }}
      selected={selected}
      animatePosition={animatePosition}
      className="workspace-connection-accent--report"
    >
      <MemoizedReportCard
        report={report}
        sourceDocuments={documents}
        onOpenSource={(docId) => void openDocumentPdf(docId)}
        onDelete={() => onDeleteReport(report.id)}
        onUpdate={onUpdateReport}
        onOpen={onOpenMarkdownCard
          ? () => onOpenMarkdownCard({ kind: 'report', id: report.id })
          : undefined}
        onEdit={onOpenMarkdownCard
          ? () => onOpenMarkdownCard({ kind: 'report', id: report.id }, 'edit')
          : undefined}
        onCopy={() => onCopyMarkdown(
          report.title,
          markdownCardContent(report.title, report.contentMd)
        )}
      />
    </ResizableCard>
  )
})

interface StickyNoteCardItemProps extends CardFrameProps {
  note: WorkspaceNote
  autoFocus: boolean
  onAutoFocusHandled: () => void
  onDeleteNote: (noteId: string) => void
  onUpdateNote: ComponentProps<typeof StickyNoteCard>['onUpdate']
  onCopyText: (text: string) => void
}

const StickyNoteCardItem = memo(function StickyNoteCardItem({
  item,
  shell,
  selected,
  animatePosition,
  note,
  autoFocus,
  onAutoFocusHandled,
  onDeleteNote,
  onUpdateNote,
  onCopyText
}: StickyNoteCardItemProps) {
  return (
    <ResizableCard
      {...shell}
      sizeKey={item.id}
      size={clampCardSize({ width: item.width, height: item.height })}
      position={{ x: item.x, y: item.y, zIndex: item.zIndex }}
      selected={selected}
      animatePosition={animatePosition}
      className="workspace-connection-accent--sticky"
    >
      <MemoizedStickyNoteCard
        note={note}
        autoFocus={autoFocus}
        onAutoFocusHandled={onAutoFocusHandled}
        onDelete={() => onDeleteNote(note.id)}
        onUpdate={onUpdateNote}
        onCopy={onCopyText}
      />
    </ResizableCard>
  )
})

interface NoteCardItemProps extends CardFrameProps {
  note: WorkspaceNote
  autoEdit: boolean
  onAutoEditHandled: () => void
  onDeleteNote: (noteId: string) => void
  onUpdateNote: ComponentProps<typeof NoteCard>['onUpdate']
  onCopyMarkdown: (title: string, content: string) => void
  onOpenMarkdownCard?: OpenMarkdownCard
}

const NoteCardItem = memo(function NoteCardItem({
  item,
  shell,
  selected,
  animatePosition,
  note,
  autoEdit,
  onAutoEditHandled,
  onDeleteNote,
  onUpdateNote,
  onCopyMarkdown,
  onOpenMarkdownCard
}: NoteCardItemProps) {
  return (
    <ResizableCard
      {...shell}
      sizeKey={item.id}
      size={clampCardSize({ width: item.width, height: item.height })}
      position={{ x: item.x, y: item.y, zIndex: item.zIndex }}
      selected={selected}
      animatePosition={animatePosition}
      className="workspace-connection-accent--note"
    >
      <MemoizedNoteCard
        note={note}
        autoEdit={autoEdit}
        onAutoEditHandled={onAutoEditHandled}
        onDelete={() => onDeleteNote(note.id)}
        onUpdate={onUpdateNote}
        onOpen={onOpenMarkdownCard
          ? () => onOpenMarkdownCard({ kind: 'note', id: note.id })
          : undefined}
        onEdit={onOpenMarkdownCard
          ? () => onOpenMarkdownCard({ kind: 'note', id: note.id }, 'edit')
          : undefined}
        onCopy={() => onCopyMarkdown(
          note.title,
          markdownCardContent(note.title, note.contentMd)
        )}
      />
    </ResizableCard>
  )
})

interface AssetCardItemProps extends CardFrameProps {
  asset: WorkspaceAsset
  onDeleteAsset: (assetId: string) => void
  onOpenAsset: (assetId: string) => void
  onRevealAsset: (assetId: string) => void
  onCopyAsset: (assetId: string) => void
}

const AssetCardItem = memo(function AssetCardItem({
  item,
  shell,
  selected,
  animatePosition,
  asset,
  onDeleteAsset,
  onOpenAsset,
  onRevealAsset,
  onCopyAsset
}: AssetCardItemProps) {
  return (
    <ResizableCard
      {...shell}
      sizeKey={item.id}
      size={clampCardSize({ width: item.width, height: item.height })}
      position={{ x: item.x, y: item.y, zIndex: item.zIndex }}
      selected={selected}
      animatePosition={animatePosition}
      className="workspace-connection-accent--asset"
    >
      <MemoizedAssetCard
        asset={asset}
        onOpen={() => onOpenAsset(asset.id)}
        onReveal={() => onRevealAsset(asset.id)}
        onDelete={() => onDeleteAsset(asset.id)}
        onCopy={() => onCopyAsset(asset.id)}
      />
    </ResizableCard>
  )
})

interface WorkspaceCardsProps {
  items: WorkspaceItem[]
  documents: Map<string, Document>
  summaries: Map<string, AiSummary>
  reports: Map<string, AiReport>
  notes: Map<string, WorkspaceNote>
  assets: Map<string, WorkspaceAsset>
  loadedSummaryDocIds: Set<string>
  summarizing: Set<string>
  summaryErrors: Map<string, string>
  autoEditNoteId: string | null
  autoEditStickyNoteId: string | null
  shell: CardShellProps
  selectedItemIds: Set<string>
  animatingItemIds: Set<string>
  onSummarize: (docId: string) => void
  onRemoveItem: (itemId: string) => void
  onDeleteReport: (reportId: string) => void
  onUpdateReport: ComponentProps<typeof ReportCard>['onUpdate']
  onDeleteNote: (noteId: string) => void
  onUpdateNote: ComponentProps<typeof NoteCard>['onUpdate']
  onDeleteAsset: (assetId: string) => void
  onOpenAsset: (assetId: string) => void
  onRevealAsset: (assetId: string) => void
  onCopyAsset: (assetId: string) => void
  onCopyMarkdown: (title: string, content: string) => void
  onCopyText: (text: string) => void
  onAutoEditNoteHandled: () => void
  onAutoEditStickyNoteHandled: () => void
  onOpenMarkdownCard?: OpenMarkdownCard
}

export default function WorkspaceCards({
  items,
  documents,
  summaries,
  reports,
  notes,
  assets,
  loadedSummaryDocIds,
  summarizing,
  summaryErrors,
  autoEditNoteId,
  autoEditStickyNoteId,
  shell,
  selectedItemIds,
  animatingItemIds,
  onSummarize,
  onRemoveItem,
  onDeleteReport,
  onUpdateReport,
  onDeleteNote,
  onUpdateNote,
  onDeleteAsset,
  onOpenAsset,
  onRevealAsset,
  onCopyAsset,
  onCopyMarkdown,
  onCopyText,
  onAutoEditNoteHandled,
  onAutoEditStickyNoteHandled,
  onOpenMarkdownCard
}: WorkspaceCardsProps) {
  return items.map((item) => {
    if (item.kind === 'document' && item.docId) {
      const docId = item.docId
      return (
        <DocumentCard
          key={item.id}
          item={item}
          shell={shell}
          selected={selectedItemIds.has(item.id)}
          animatePosition={animatingItemIds.has(item.id)}
          doc={documents.get(docId) ?? null}
          summary={summaries.get(docId) ?? null}
          summaryLoading={!loadedSummaryDocIds.has(docId)}
          summarizing={summarizing.has(docId)}
          summaryError={summaryErrors.get(docId) ?? null}
          onSummarize={onSummarize}
          onRemoveItem={onRemoveItem}
          onCopyMarkdown={onCopyMarkdown}
          onOpenMarkdownCard={onOpenMarkdownCard}
        />
      )
    }
    if (item.kind === 'report' && item.reportId) {
      const report = reports.get(item.reportId)
      if (!report) return null
      return (
        <ReportCardItem
          key={item.id}
          item={item}
          shell={shell}
          selected={selectedItemIds.has(item.id)}
          animatePosition={animatingItemIds.has(item.id)}
          report={report}
          documents={documents}
          onDeleteReport={onDeleteReport}
          onUpdateReport={onUpdateReport}
          onCopyMarkdown={onCopyMarkdown}
          onOpenMarkdownCard={onOpenMarkdownCard}
        />
      )
    }
    if (item.kind === 'note' && item.noteId) {
      const note = notes.get(item.noteId)
      if (!note) return null
      if (note.noteType === 'plain') {
        return (
          <StickyNoteCardItem
            key={item.id}
            item={item}
            shell={shell}
            selected={selectedItemIds.has(item.id)}
            animatePosition={animatingItemIds.has(item.id)}
            note={note}
            autoFocus={autoEditStickyNoteId === note.id}
            onAutoFocusHandled={onAutoEditStickyNoteHandled}
            onDeleteNote={onDeleteNote}
            onUpdateNote={onUpdateNote}
            onCopyText={onCopyText}
          />
        )
      }
      return (
        <NoteCardItem
          key={item.id}
          item={item}
          shell={shell}
          selected={selectedItemIds.has(item.id)}
          animatePosition={animatingItemIds.has(item.id)}
          note={note}
          autoEdit={autoEditNoteId === note.id}
          onAutoEditHandled={onAutoEditNoteHandled}
          onDeleteNote={onDeleteNote}
          onUpdateNote={onUpdateNote}
          onCopyMarkdown={onCopyMarkdown}
          onOpenMarkdownCard={onOpenMarkdownCard}
        />
      )
    }
    if (item.kind === 'asset' && item.assetId) {
      const asset = assets.get(item.assetId)
      if (!asset) return null
      return (
        <AssetCardItem
          key={item.id}
          item={item}
          shell={shell}
          selected={selectedItemIds.has(item.id)}
          animatePosition={animatingItemIds.has(item.id)}
          asset={asset}
          onDeleteAsset={onDeleteAsset}
          onOpenAsset={onOpenAsset}
          onRevealAsset={onRevealAsset}
          onCopyAsset={onCopyAsset}
        />
      )
    }
    return null
  })
}
