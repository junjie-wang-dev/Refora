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
import ResizableCard from './ResizableCard'
import StickyNoteCard from './StickyNoteCard'

type CardShellProps = Omit<ComponentProps<typeof ResizableCard>, 'children'>

type OpenMarkdownCard = (
  card:
    | { kind: 'note' | 'report'; id: string }
    | { kind: 'summary'; doc: Document; summary: AiSummary },
  mode?: 'read' | 'edit'
) => void

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
  cardProps: (item: WorkspaceItem) => CardShellProps
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
  cardProps,
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
      const doc = documents.get(docId) ?? null
      const summary = summaries.get(docId) ?? null
      const summaryForReader = summary?.content ? summary : null
      return (
        <ResizableCard
          key={item.id}
          {...cardProps(item)}
          className="workspace-connection-accent--document"
        >
          <PaperCard
            doc={doc}
            summary={summary}
            summaryLoading={!loadedSummaryDocIds.has(docId)}
            summarizing={summarizing.has(docId)}
            summaryError={summaryErrors.get(docId) ?? null}
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
    }
    if (item.kind === 'report' && item.reportId) {
      const report = reports.get(item.reportId)
      if (!report) return null
      return (
        <ResizableCard
          key={item.id}
          {...cardProps(item)}
          className="workspace-connection-accent--report"
        >
          <ReportCard
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
    }
    if (item.kind === 'note' && item.noteId) {
      const note = notes.get(item.noteId)
      if (!note) return null
      if (note.noteType === 'plain') {
        return (
          <ResizableCard
            key={item.id}
            {...cardProps(item)}
            className="workspace-connection-accent--sticky"
          >
            <StickyNoteCard
              note={note}
              autoFocus={autoEditStickyNoteId === note.id}
              onAutoFocusHandled={onAutoEditStickyNoteHandled}
              onDelete={() => onDeleteNote(note.id)}
              onUpdate={onUpdateNote}
              onCopy={onCopyText}
            />
          </ResizableCard>
        )
      }
      return (
        <ResizableCard
          key={item.id}
          {...cardProps(item)}
          className="workspace-connection-accent--note"
        >
          <NoteCard
            note={note}
            autoEdit={autoEditNoteId === note.id}
            onAutoEditHandled={onAutoEditNoteHandled}
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
    }
    if (item.kind === 'asset' && item.assetId) {
      const asset = assets.get(item.assetId)
      if (!asset) return null
      return (
        <ResizableCard
          key={item.id}
          {...cardProps(item)}
          className="workspace-connection-accent--asset"
        >
          <AssetCard
            asset={asset}
            onOpen={() => onOpenAsset(asset.id)}
            onReveal={() => onRevealAsset(asset.id)}
            onDelete={() => onDeleteAsset(asset.id)}
            onCopy={() => onCopyAsset(asset.id)}
          />
        </ResizableCard>
      )
    }
    return null
  })
}
