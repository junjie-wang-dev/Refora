import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage, type ChatMediaResource, type WorkspaceAssetTextPreview } from '../../../shared/ipc-types'
import { api } from '../../ipc'

function separatedRows(content: string, separator: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < content.length && rows.length < 51; index++) {
    const character = content[index]
    if (character === '"') {
      if (quoted && content[index + 1] === '"') { field += '"'; index++ }
      else quoted = !quoted
    } else if (!quoted && character === separator) {
      row.push(field)
      field = ''
    } else if (!quoted && (character === '\n' || character === '\r')) {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (character === '\r' && content[index + 1] === '\n') index++
    } else field += character
  }
  if (field || row.length) rows.push([...row, field])
  return rows
}

export function canPreviewMediaFile(resource: ChatMediaResource): boolean {
  return resource.kind === 'file' && (resource.mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/x-yaml'].includes(resource.mimeType) || /\.(txt|csv|tsv|json|md|log|ya?ml)$/i.test(resource.fileName))
}

export function ChatFilePreview({ resource }: { resource: ChatMediaResource }) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<WorkspaceAssetTextPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setError(null)
    setPreview(null)
    void api.ai.mediaTextPreview(resource.id).then((value) => { if (!cancelled) setPreview(value) }).catch((value) => { if (!cancelled) setError(errorMessage(value)) })
    return () => { cancelled = true }
  }, [resource.id, attempt])
  const content = useMemo(() => {
    if (!preview) return ''
    if (resource.mimeType === 'application/json' || /\.json$/i.test(resource.fileName)) {
      try { return JSON.stringify(JSON.parse(preview.content), null, 2) } catch { return preview.content }
    }
    return preview.content
  }, [preview, resource.fileName, resource.mimeType])
  const rows = useMemo(() => /\.csv$/i.test(resource.fileName) || resource.mimeType === 'text/csv' ? separatedRows(content, ',') : /\.tsv$/i.test(resource.fileName) ? separatedRows(content, '\t') : null, [resource.fileName, resource.mimeType, content])
  if (error) return <span className="chat-media-placeholder" role="status"><span>{error}</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>{t('workspace.chat.media.retry')}</button></span>
  if (!preview) return <span className="chat-media-placeholder" role="status">{t('workspace.chat.media.loading')}</span>
  return <span className="chat-file-preview" role="region" aria-label={t('workspace.chat.media.dataPreview')} tabIndex={0}>
    {rows?.length ? <span role="table" className="chat-file-table">
      {rows.map((row, index) => <span role="row" className="chat-file-row" key={index}>{row.slice(0, 12).map((cell, cellIndex) => <span role={index === 0 ? 'columnheader' : 'cell'} key={cellIndex}>{cell}</span>)}</span>)}
    </span> : <span className="chat-file-text">{content || t('workspace.chat.media.emptyFile')}</span>}
    {(preview.truncated || rows && (rows.length >= 51 || rows.some((row) => row.length > 12))) && <span className="chat-file-preview-notice">{t('workspace.chat.media.previewLimited')}</span>}
  </span>
}
