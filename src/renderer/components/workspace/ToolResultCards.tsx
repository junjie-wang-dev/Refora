import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentTraceStep, ChatMediaItem } from '../../../shared/ipc-types'
import { openDocumentPdf } from '../../utils/openPdf'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useDocumentStore } from '../../store/documentStore'
import { ChatMedia, mediaSourceKey, useMessageMediaSources } from './ChatMedia'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const text = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

function resultValue(step: AgentTraceStep): unknown {
  let value: unknown = step.result ?? step.output
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value) as unknown } catch { return null }
    } else {
      const entry = record(value)
      if (entry?.data !== undefined && (entry.ok === true || Object.keys(entry).length === 1)) value = entry.data
      else if (entry?.data && ['document', 'report', 'note', 'asset'].includes(string(entry.kind))) {
        const nested = record(entry.data)
        if (!nested) return value
        const idKey = entry.kind === 'document' ? 'docId' : entry.kind === 'asset' ? 'assetId' : `${string(entry.kind)}Id`
        return { ...nested, [idKey]: nested[idKey] ?? nested.id }
      }
      else return value
    }
  }
  return value
}

function safeLink(value: unknown): string | null {
  try {
    const url = new URL(string(value))
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

function fileMedia(entry: RecordValue, runId: string): ChatMediaItem | null {
  const assetId = string(entry.assetId)
  const path = string(entry.path)
  if (!assetId && !path) return null
  const mimeType = string(entry.mimeType)
  const title = string(entry.fileName) || string(entry.title) || path.split('/').at(-1) || undefined
  const kind = mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif)$/i.test(title ?? '') ? 'image'
    : mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac)$/i.test(title ?? '') ? 'audio'
      : mimeType.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(title ?? '') ? 'video' : 'file'
  return { id: assetId || path, kind, title, mimeType: mimeType || undefined, source: assetId ? { type: 'asset', assetId } : { type: 'sandbox', runId, path } }
}

function ResultCard({ entry }: { entry: RecordValue }) {
  const { t } = useTranslation()
  const documentId = string(entry.docId) || string(entry.documentId)
  const reportId = string(entry.reportId)
  const title = string(entry.title) || string(entry.fileName) || string(entry.name)
  const url = safeLink(entry.url ?? entry.htmlUrl ?? entry.absUrl ?? entry.abstractUrl ?? entry.sourceUrl ?? entry.pdfUrl)
    ?? (string(entry.doi) ? `https://doi.org/${encodeURIComponent(string(entry.doi))}` : null)
    ?? (string(entry.arxivId) ? `https://arxiv.org/abs/${encodeURIComponent(string(entry.arxivId))}` : null)
  const authors = Array.isArray(entry.authors) ? entry.authors.map((value) => typeof value === 'string' ? value : string(record(value)?.name)).filter(Boolean).join(', ') : string(entry.authors)
  const subtitle = [authors, text(entry.year), string(entry.venue)].filter(Boolean).join(' · ')
  const summary = string(entry.snippet) || string(entry.abstract) || string(entry.description) || string(entry.summary)
  const open = () => {
    if (documentId) void openDocumentPdf(documentId).catch(() => useDocumentStore.getState().showToast(t('workspace.openDocFailed')))
    if (reportId) useWorkspaceStore.getState().openMarkdownCard('report', reportId)
  }
  return <div className="chat-tool-result">
    {documentId || reportId ? <button type="button" className="chat-tool-result-title" onClick={open}>{title || t(reportId ? 'workspace.chat.media.report' : 'workspace.chat.attachedPaper')}</button>
      : url ? <a className="chat-tool-result-title" href={url} target="_blank" rel="noreferrer">{title || url}</a> : <strong>{title}</strong>}
    {subtitle && <p className="text-muted">{subtitle}</p>}
    {summary && <p className="line-clamp-4">{summary}</p>}
    {Array.isArray(entry.sourceDocIds) && <p className="text-muted">{t('workspace.chat.media.sourceCount', { count: entry.sourceDocIds.length })}</p>}
  </div>
}

export function ToolResultCards({ step }: { step: AgentTraceStep }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const existingSources = useMessageMediaSources()
  const parsed = useMemo(() => resultValue(step), [step.result, step.output])
  const top = record(parsed)
  const grouped = record(top?.groups)
  const groupEntries = grouped ? ['citingPapers', 'recommendations', 'recentArxivPapers'].flatMap((key) => Array.isArray(grouped[key]) ? grouped[key] : []) : []
  const collection = Array.isArray(parsed) ? parsed : groupEntries.length ? groupEntries : ['documents', 'papers', 'results', 'publications', 'artifacts', 'published', 'changedFiles', 'files', 'items', 'candidates'].map((key) => top?.[key]).find(Array.isArray)
  const entries = (Array.isArray(collection) ? collection : top ? [top] : []).map(record).filter((value): value is RecordValue => value !== null).map((entry) => record(entry.paper) ? { ...record(entry.paper), citationEvidence: entry.citationEvidence } : entry)
  const fileEntries = entries.map((entry) => fileMedia(entry, step.runId)).filter((value): value is ChatMediaItem => value !== null)
  const media = fileEntries.filter((value) => !existingSources.has(mediaSourceKey(value.source)))
  const cards = entries.filter((entry) => (entry.title || entry.docId || entry.documentId || entry.reportId || entry.url) && !fileMedia(entry, step.runId))
  const rows = Array.isArray(top?.rows) ? top.rows : entries.length && !fileEntries.length && !cards.length && !entries.some((entry) => entry.error) ? entries : []
  const rowRecords = rows.map(record).filter((value): value is RecordValue => value !== null)
  const columns = Array.isArray(top?.columns) ? top.columns.map(text) : [...new Set(rowRecords.flatMap(Object.keys))].slice(0, 12)
  const rowLimit = expanded ? 200 : 8
  if (!cards.length && !media.length && !rows.length) return null
  return <section className="chat-tool-results" aria-label={t('workspace.chat.media.toolResults')}>
    <ChatMedia media={expanded ? media : media.slice(0, 8)} context={{ runId: step.runId }} />
    {(expanded ? cards : cards.slice(0, 8)).map((entry, index) => <ResultCard key={string(entry.docId) || string(entry.id) || `${index}`} entry={entry} />)}
    {rows.length > 0 && columns.length > 0 && <div className="chat-tool-data" tabIndex={0} role="region" aria-label={t('workspace.chat.media.dataPreview')}><table>
      <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
      <tbody>{rows.slice(0, rowLimit).map((row, index) => <tr key={index}>{columns.map((column, columnIndex) => <td key={column}>{text(Array.isArray(row) ? row[columnIndex] : record(row)?.[column])}</td>)}</tr>)}</tbody>
    </table></div>}
    {!expanded && (cards.length > 8 || media.length > 8 || rows.length > 8) && <button type="button" className="text-left text-xs text-accent" onClick={() => setExpanded(true)}>{t('workspace.chat.media.showMore')}</button>}
    {(top?.hasMore === true || top?.nextCursor || top?.nextOffset != null) && <span className="text-xs text-muted">{t('workspace.chat.media.moreResults')}</span>}
  </section>
}
