import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CaretDown,
  Wrench,
  Robot,
  CheckCircle,
  XCircle,
  CircleNotch,
  MagnifyingGlass,
  FileText,
  FileMagnifyingGlass,
  FilePlus,
  ClipboardText,
  FolderOpen,
  TerminalWindow,
  Package,
  UploadSimple,
  GlobeHemisphereWest
} from '@phosphor-icons/react'
import type { AgentTraceStep } from '../../../shared/ipc-types'

type TFunc = ReturnType<typeof useTranslation>['t']

interface ToolLabelResult {
  icon: string
  text: string
  detail?: string
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`
}

function formatTraceValue(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === 'string') return parsed
    return JSON.stringify(parsed, null, 2)
  } catch {
    return value
  }
}

function parseToolInput(value: string | null): unknown {
  let current: unknown = value
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current) as unknown
        continue
      } catch {
        return current
      }
    }
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      const record = current as Record<string, unknown>
      const keys = Object.keys(record)
      if (
        'input' in record &&
        keys.every((key) => ['input', 'tool_call_id', 'id', 'name'].includes(key))
      ) {
        current = record.input
        continue
      }
    }
    return current
  }
  return current
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function stringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : []
}

function compactDetail(value: string, maxLength = 260): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 1)}…`
    : compact
}

function quotedDetail(value: string): string | undefined {
  const compact = compactDetail(value)
  return compact ? `“${compact}”` : undefined
}

function websiteDetail(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return compactDetail(value) || undefined
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    return `${url.hostname}${path}`
  } catch {
    return compactDetail(value) || undefined
  }
}

function inferredToolDetail(parsed: unknown): string | undefined {
  if (typeof parsed === 'string') return compactDetail(parsed) || undefined
  const record = asRecord(parsed)
  const command = firstString(record, ['command', 'script', 'cmd'])
  if (command) return compactDetail(command)
  const url = firstString(record, ['url', 'uri', 'href'])
  if (url) return websiteDetail(url)
  const query = firstString(record, ['query', 'q', 'search_query'])
  if (query) return quotedDetail(query)
  const path = firstString(record, ['file_path', 'path'])
  if (path) return compactDetail(path)
  const pattern = firstString(record, ['pattern', 'glob'])
  if (pattern) return quotedDetail(pattern)
  const identifier = firstString(record, ['title', 'docId', 'arxivId', 'paperId'])
  return compactDetail(identifier) || undefined
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatDuration(step: AgentTraceStep): string | null {
  if (step.endedAt == null) return null
  const ms = Math.max(0, step.endedAt - step.startedAt)
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatToolLabel(
  step: AgentTraceStep,
  t: TFunc
): ToolLabelResult | null {
  if (step.kind !== 'tool' || !step.name) return null
  const name = step.name.startsWith('refora.')
    ? step.name.slice('refora.'.length)
    : step.name
  const parsed = parseToolInput(step.input)
  const objParam = asRecord(parsed)
  const stringParam = typeof parsed === 'string' ? parsed.trim() : ''
  const running = step.status === 'running'
  const query = stringParam || firstString(objParam, ['query', 'q', 'search_query'])
  const docId = firstString(objParam, ['docId', 'documentId'])

  switch (name) {
    case 'search_documents': {
      const workspaceScope = objParam.scope === 'workspace'
      return {
        icon: 'search',
        text: workspaceScope
          ? running
            ? t('workspace.chat.toolSearchWorkspace', 'Searching workspace…')
            : t('workspace.chat.toolSearchWorkspaceDone', 'Searched workspace')
          : running
            ? t('workspace.chat.toolSearchLibrary', 'Searching library…')
            : t('workspace.chat.toolSearchLibraryDone', 'Searched library'),
        detail: quotedDetail(query)
      }
    }
    case 'search_workspace_docs':
      return {
        icon: 'search',
        text: running
          ? t('workspace.chat.toolSearchWorkspace', 'Searching workspace…')
          : t('workspace.chat.toolSearchWorkspaceDone', 'Searched workspace'),
        detail: quotedDetail(query)
      }
    case 'list_workspace_context':
      return {
        icon: 'search',
        text: running
          ? t('workspace.chat.toolListWorkspaceContext', 'Inspecting workspace…')
          : t('workspace.chat.toolListWorkspaceContextDone', 'Inspected workspace')
      }
    case 'read_workspace_item':
      return {
        icon: 'read',
        text: running
          ? t('workspace.chat.toolReadWorkspaceItem', 'Reading workspace item…')
          : t('workspace.chat.toolReadWorkspaceItemDone', 'Read workspace item'),
        detail: firstString(objParam, ['itemId']) || undefined
      }
    case 'search_library':
      return {
        icon: 'search',
        text: running
          ? t('workspace.chat.toolSearchLibrary', 'Searching library…')
          : t('workspace.chat.toolSearchLibraryDone', 'Searched library'),
        detail: quotedDetail(query)
      }
    case 'find_related_papers':
      return {
        icon: 'search',
        text: running
          ? t('workspace.chat.toolFindRelatedPapers', 'Finding related papers…')
          : t('workspace.chat.toolFindRelatedPapersDone', 'Found related papers'),
        detail: docId || undefined
      }
    case 'read_paper':
    case 'read_paper_fulltext': {
      const offset = typeof objParam.offset === 'number' ? objParam.offset : 0
      const limit = typeof objParam.limit === 'number' ? objParam.limit : 8000
      const chunkIdx = Math.floor(offset / limit) + 1
      if (name === 'read_paper' && objParam.source === 'ocr') {
        return {
          icon: 'read',
          text: running
            ? t('workspace.chat.toolReadingOcrChunk', {
                chunk: chunkIdx,
                defaultValue: 'Reading OCR cache… (chunk {{chunk}})'
              })
            : t('workspace.chat.toolReadingOcrChunkDone', {
                chunk: chunkIdx,
                defaultValue: 'Read OCR cache (chunk {{chunk}})'
              }),
          detail: docId || undefined
        }
      }
      if (docId) {
        return {
          icon: 'read',
          text: running
            ? t('workspace.chat.toolReadingChunk', {
                chunk: chunkIdx,
                defaultValue: 'Reading document… (chunk {{chunk}})'
              })
            : t('workspace.chat.toolReadingChunkDone', {
                chunk: chunkIdx,
                defaultValue: 'Read document (chunk {{chunk}})'
              }),
          detail: docId
        }
      }
      return {
        icon: 'read',
        text: running
          ? t('workspace.chat.toolReading', 'Reading document…')
          : t('workspace.chat.toolReadingDone', 'Read document')
      }
    }
    case 'read_paper_ocr_fulltext': {
      const offset = typeof objParam.offset === 'number' ? objParam.offset : 0
      const limit = typeof objParam.limit === 'number' ? objParam.limit : 8000
      const chunkIdx = Math.floor(offset / limit) + 1
      return {
        icon: 'read',
        text: running
          ? t('workspace.chat.toolReadingOcrChunk', {
              chunk: chunkIdx,
              defaultValue: 'Reading OCR cache… (chunk {{chunk}})'
            })
          : t('workspace.chat.toolReadingOcrChunkDone', {
              chunk: chunkIdx,
              defaultValue: 'Read OCR cache (chunk {{chunk}})'
            }),
        detail: docId || undefined
      }
    }
    case 'prepare_paper_ocr': {
      if (step.status === 'interrupted') {
        return {
          icon: 'read',
          text: t('workspace.chat.toolPreparingOcrApproval', 'OCR approval requested'),
          detail: docId || undefined
        }
      }
      if (step.status === 'cancelled') {
        return {
          icon: 'read',
          text: t('workspace.chat.toolPreparingOcrRejected', 'OCR was not run'),
          detail: docId || undefined
        }
      }
      if (step.status === 'error') {
        return {
          icon: 'read',
          text: t('workspace.chat.toolPreparingOcrFailed', 'OCR preparation failed'),
          detail: docId || undefined
        }
      }
      return {
        icon: 'read',
        text: running
          ? t('workspace.chat.toolPreparingOcr', 'Running balanced OCR…')
          : t('workspace.chat.toolPreparingOcrDone', 'Prepared balanced OCR cache'),
        detail: docId || undefined
      }
    }
    case 'get_paper_summary':
      return {
        icon: 'summary',
        text: running
          ? t('workspace.chat.toolGetSummary', 'Getting summary…')
          : t('workspace.chat.toolGetSummaryDone', 'Retrieved summary'),
        detail: (stringParam || docId) || undefined
      }
    case 'get_paper_metadata':
    case 'get_paper_context':
      return {
        icon: 'metadata',
        text: running
          ? t('workspace.chat.toolGetMetadata', 'Fetching metadata…')
          : t('workspace.chat.toolGetMetadataDone', 'Retrieved metadata'),
        detail: (stringParam || docId) || undefined
      }
    case 'open_paper':
      return {
        icon: 'open',
        text: running
          ? t('workspace.chat.toolOpenPaper', 'Opening paper…')
          : t('workspace.chat.toolOpenPaperDone', 'Opened paper'),
        detail: (stringParam || docId) || undefined
      }
    case 'generate_report':
      return {
        icon: 'report',
        text: running
          ? t('workspace.chat.toolGenerateReport', 'Generating report…')
          : t('workspace.chat.toolGenerateReportDone', 'Generated report'),
        detail: compactDetail(firstString(objParam, ['title'])) || undefined
      }
    case 'add_docs_to_workspace':
      return {
        icon: 'add',
        text: running
          ? t('workspace.chat.toolAddDocs', 'Adding to workspace…')
          : t('workspace.chat.toolAddDocsDone', 'Added to workspace'),
        detail: compactDetail(firstString(objParam, ['docIds'])) || undefined
      }
    case 'create_workspace_connections': {
      const connections = Array.isArray(objParam.connections)
        ? objParam.connections.flatMap((value) => {
            const connection = asRecord(value)
            const source = firstString(connection, ['sourceItemId'])
            const target = firstString(connection, ['targetItemId'])
            return source && target ? [`${source} → ${target}`] : []
          })
        : []
      return {
        icon: 'add',
        text: running
          ? t('workspace.chat.toolCreateConnections', 'Connecting workspace cards…')
          : t('workspace.chat.toolCreateConnectionsDone', 'Connected workspace cards'),
        detail: compactDetail(connections.join(', ')) || undefined
      }
    }
    case 'request_summary':
      return {
        icon: 'summary',
        text: running
          ? t('workspace.chat.toolRequestSummary', 'Requesting summary…')
          : t('workspace.chat.toolRequestSummaryDone', 'Requested summary'),
        detail: docId || undefined
      }
    case '__execute':
    case 'execute':
    case 'run_bash':
    case 'codex_shell':
      return {
        icon: 'terminal',
        text: running
          ? t('workspace.chat.toolRunBash', 'Running command…')
          : t('workspace.chat.toolRunBashDone', 'Ran command'),
        detail: inferredToolDetail(parsed)
      }
    case 'ls':
      return {
        icon: 'files',
        text: running
          ? t('workspace.chat.toolListFiles', 'Listing files…')
          : t('workspace.chat.toolListFilesDone', 'Listed files'),
        detail: compactDetail(firstString(objParam, ['path']) || '/') || undefined
      }
    case 'read_file':
      return {
        icon: 'read',
        text: running
          ? t('workspace.chat.toolReadFile', 'Reading file…')
          : t('workspace.chat.toolReadFileDone', 'Read file'),
        detail: compactDetail(firstString(objParam, ['file_path', 'path'])) || undefined
      }
    case 'write_file':
      return {
        icon: 'files',
        text: running
          ? t('workspace.chat.toolWriteFile', 'Writing file…')
          : t('workspace.chat.toolWriteFileDone', 'Wrote file'),
        detail: compactDetail(firstString(objParam, ['file_path', 'path'])) || undefined
      }
    case 'edit_file':
      return {
        icon: 'files',
        text: running
          ? t('workspace.chat.toolEditFile', 'Editing file…')
          : t('workspace.chat.toolEditFileDone', 'Edited file'),
        detail: compactDetail(firstString(objParam, ['file_path', 'path'])) || undefined
      }
    case 'glob': {
      const pattern = firstString(objParam, ['pattern'])
      const path = firstString(objParam, ['path'])
      return {
        icon: 'search',
        text: running
          ? t('workspace.chat.toolFindFiles', 'Finding files…')
          : t('workspace.chat.toolFindFilesDone', 'Found files'),
        detail: [quotedDetail(pattern), compactDetail(path)].filter(Boolean).join(' · ') || undefined
      }
    }
    case 'grep': {
      const pattern = firstString(objParam, ['pattern'])
      const path = firstString(objParam, ['path'])
      return {
        icon: 'search',
        text: running
          ? t('workspace.chat.toolSearchFiles', 'Searching files…')
          : t('workspace.chat.toolSearchFilesDone', 'Searched files'),
        detail: [quotedDetail(pattern), compactDetail(path)].filter(Boolean).join(' · ') || undefined
      }
    }
    case 'web_search':
    case 'search_web':
    case 'native_web_search':
      return {
        icon: 'web',
        text: running
          ? t('workspace.chat.toolSearchWeb', 'Searching the web…')
          : t('workspace.chat.toolSearchWebDone', 'Searched the web'),
        detail: quotedDetail(query)
      }
    case 'fetch_url':
    case 'web_fetch':
    case 'visit_url':
    case 'open_url':
      return {
        icon: 'web',
        text: running
          ? t('workspace.chat.toolAccessWebsite', 'Accessing website…')
          : t('workspace.chat.toolAccessWebsiteDone', 'Accessed website'),
        detail: websiteDetail(firstString(objParam, ['url', 'uri', 'href']) || stringParam)
      }
    case 'search_arxiv':
      return {
        icon: 'web',
        text: running
          ? t('workspace.chat.toolSearchWeb', 'Searching the web…')
          : t('workspace.chat.toolSearchWebDone', 'Searched the web'),
        detail: 'arxiv.org'
      }
    case 'get_arxiv_paper':
      return {
        icon: 'web',
        text: running
          ? t('workspace.chat.toolAccessWebsite', 'Accessing website…')
          : t('workspace.chat.toolAccessWebsiteDone', 'Accessed website'),
        detail: 'arxiv.org'
      }
    case 'get_related_academic_papers':
    case 'get_citing_papers':
    case 'get_referenced_papers':
    case 'get_semantic_recommendations':
      return {
        icon: 'web',
        text: running
          ? t('workspace.chat.toolAccessWebsite', 'Accessing website…')
          : t('workspace.chat.toolAccessWebsiteDone', 'Accessed website'),
        detail: 'semanticscholar.org'
      }
    case 'resolve_academic_identity':
      return {
        icon: 'metadata',
        text: running
          ? t('workspace.chat.toolResolvePaper', 'Resolving paper identity…')
          : t('workspace.chat.toolResolvePaperDone', 'Resolved paper identity')
      }
    case 'explore_research_frontier':
      return {
        icon: 'web',
        text: running
          ? t('workspace.chat.toolSearchWeb', 'Searching the web…')
          : t('workspace.chat.toolSearchWebDone', 'Searched the web'),
        detail: 'arxiv.org · semanticscholar.org'
      }
    case 'propose_workspace_memory_update':
      return {
        icon: 'files',
        text: running
          ? t('workspace.chat.toolUpdateMemory', 'Updating workspace memory…')
          : t('workspace.chat.toolUpdateMemoryDone', 'Updated workspace memory'),
        detail: compactDetail(firstString(objParam, ['path'])) || undefined
      }
    case 'install_runtime_packages':
      return {
        icon: 'package',
        text: running
          ? t('workspace.chat.toolInstallPackages', 'Installing packages…')
          : t('workspace.chat.toolInstallPackagesDone', 'Installed packages'),
        detail: [
          ...stringList(objParam, 'runtimes'),
          ...['python', 'node'].flatMap((key) => {
            const values = objParam[key]
            if (!Array.isArray(values)) return []
            return values.flatMap((value) => {
              const item = asRecord(value)
              const packageName = firstString(item, ['name'])
              const version = firstString(item, ['version'])
              return packageName ? [`${packageName}${version ? `@${version}` : ''}`] : []
            })
          })
        ].join(', ') || undefined
      }
    case 'publish_workspace_artifacts':
      return {
        icon: 'publish',
        text: running
          ? t('workspace.chat.toolPublishArtifacts', 'Publishing artifacts…')
          : t('workspace.chat.toolPublishArtifactsDone', 'Published artifacts'),
        detail: stringList(objParam, 'paths').join(', ') || undefined
      }
    default: {
      const detail = inferredToolDetail(parsed)
      const url = firstString(objParam, ['url', 'uri', 'href'])
      return {
        icon: url ? 'web' : 'tool',
        text: humanizeIdentifier(name),
        detail
      }
    }
  }
}

const TOOL_ICONS: Record<string, typeof MagnifyingGlass> = {
  search: MagnifyingGlass,
  read: FileText,
  summary: FileMagnifyingGlass,
  metadata: FileMagnifyingGlass,
  open: FolderOpen,
  report: ClipboardText,
  add: FilePlus,
  terminal: TerminalWindow,
  package: Package,
  publish: UploadSimple,
  files: FileText,
  web: GlobeHemisphereWest
}

function TraceStepRow({
  step,
  isLast,
  forceOpen,
  compact = false
}: {
  step: AgentTraceStep
  isLast: boolean
  forceOpen?: boolean
  compact?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (forceOpen !== undefined) setOpen(forceOpen)
  }, [forceOpen])
  const hasBody = !!(step.input || step.output)
  const duration = formatDuration(step)
  const toolLabel = formatToolLabel(step, t)

  const failed = step.status === 'error' || step.status === 'cancelled'
  const StatusIcon = step.status === 'running' ? CircleNotch : failed ? XCircle : CheckCircle
  const statusColor = failed ? 'text-error' : step.status === 'interrupted' ? 'text-accent' : 'text-muted'
  const statusTitle =
    step.status === 'running'
      ? t('workspace.chat.traceRunning', 'Running')
      : failed
        ? t('workspace.chat.traceError', 'Error')
        : step.status === 'interrupted'
          ? t('workspace.chat.traceApproval', 'Approval required')
        : t('workspace.chat.traceDone', 'Done')

  const KindIcon = step.kind === 'tool'
    ? (toolLabel ? (TOOL_ICONS[toolLabel.icon] ?? Wrench) : Wrench)
    : step.kind === 'todo' || step.kind === 'approval'
      ? ClipboardText
    : Robot

  const displayText = toolLabel
    ? toolLabel.detail
      ? toolLabel.text.replace(/(?:…|\.{3})$/, '')
      : toolLabel.text
    : step.kind === 'llm'
      ? step.status === 'running'
        ? t('workspace.chat.traceLlmCall', 'Model thinking…')
        : t('workspace.chat.traceLlmDone', 'Completed')
      : step.name
        ? humanizeIdentifier(step.name)
        : t('workspace.chat.traceTool', 'Tool')
  const displayDetail = toolLabel?.detail

  const kindLabel = step.kind === 'llm'
    ? t('workspace.chat.traceLlm', 'Model')
    : step.kind === 'subagent'
      ? t('workspace.chat.traceSubagent', 'Subagent')
      : step.kind === 'todo'
        ? t('workspace.chat.traceTodo', 'Plan')
        : step.kind === 'approval'
          ? t('workspace.chat.traceApproval', 'Approval required')
          : t('workspace.chat.traceTool', 'Tool')

  return (
    <div className={`agent-trace-step trace-fade-in ${compact ? 'agent-trace-step-compact' : ''}`}>
      {!compact && (
        <div className="agent-trace-rail">
          <span className={`agent-trace-status-dot agent-trace-status-${step.status}`}>
            <StatusIcon
              className={`h-3.5 w-3.5 shrink-0 ${statusColor} ${step.status === 'running' ? 'animate-spin' : ''}`}
            />
          </span>
          {!isLast && <div className="agent-trace-connector" />}
        </div>
      )}
      <div className={`min-w-0 flex-1 ${isLast ? '' : 'pb-2'}`}>
        <button
          type="button"
          className={`agent-trace-step-trigger ${hasBody ? 'agent-trace-step-trigger-interactive' : ''}`}
          onClick={() => hasBody && setOpen((v) => !v)}
          disabled={!hasBody}
          aria-expanded={open}
          title={statusTitle}
        >
          {(!compact || step.kind === 'tool') && (
            <span className="agent-trace-kind-icon">
              <KindIcon className="h-3.5 w-3.5 text-muted" />
            </span>
          )}
          <span className="agent-trace-step-copy min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="agent-trace-step-title shrink-0 text-xs font-medium text-foreground">
                {displayText}
              </span>
              {displayDetail && (
                <>
                  <span className="agent-trace-step-separator shrink-0 text-muted" aria-hidden="true">
                    —
                  </span>
                  <span
                    className="agent-trace-step-detail min-w-0 truncate text-xs text-foreground"
                    title={displayDetail}
                  >
                    {displayDetail}
                  </span>
                </>
              )}
              {(!compact || step.status !== 'done') && (
                <span className={`agent-trace-status-label agent-trace-status-label-${step.status}`}>
                  {statusTitle}
                </span>
              )}
            </span>
            {!compact && (
              <span className="agent-trace-kind-label mt-0.5 block text-caption text-muted">{kindLabel}</span>
            )}
          </span>
          {!compact && step.kind === 'llm' && step.totalTokens != null && (
            <span
              className="agent-trace-metric"
              title={t('workspace.chat.tokenUsage', 'Tokens')}
            >
              {formatTokenCount(step.inputTokens ?? 0)}
              <span aria-hidden="true">/</span>
              {formatTokenCount(step.outputTokens ?? 0)}
            </span>
          )}
          {duration && (!compact || step.kind === 'llm') && (
            <span className="agent-trace-metric">{duration}</span>
          )}
          {hasBody && (
            <CaretDown
              className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${compact ? (open ? 'rotate-180' : '') : (open ? '' : '-rotate-90')}`}
            />
          )}
        </button>
        {open && hasBody && (
          <div className="agent-trace-details">
            {step.input && (
              <div className="agent-trace-detail-card">
                <p className="agent-trace-detail-label">
                  {t('workspace.chat.traceInput', 'Input')}
                </p>
                <pre className="agent-trace-detail-value">
                  {formatTraceValue(step.input)}
                </pre>
              </div>
            )}
            {step.output && (
              <div className="agent-trace-detail-card">
                <p className="agent-trace-detail-label">
                  {t('workspace.chat.traceOutput', 'Output')}
                </p>
                <pre className="agent-trace-detail-value">
                  {formatTraceValue(step.output)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function AgentTraceStepItem({ step }: { step: AgentTraceStep }) {
  if (!['llm', 'tool', 'todo', 'subagent', 'approval'].includes(step.kind)) return null
  return (
    <div className="agent-trace-inline-step" data-timeline-kind={step.kind}>
      <TraceStepRow step={step} isLast compact />
    </div>
  )
}

export function AgentTracePanel({
  steps,
  streaming
}: {
  steps: AgentTraceStep[]
  streaming: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expandAll, setExpandAll] = useState<boolean | null>(null)
  const visible = steps.filter((s) =>
    ['llm', 'tool', 'todo', 'subagent', 'approval'].includes(s.kind)
  )
  const totalTokensSum = visible.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)
  const hasTokenData = visible.some((s) => s.totalTokens != null)
  const isRunning = streaming || visible.some((s) => s.status === 'running')
  const hasError = visible.some((s) => s.status === 'error')

  const contentRef = useRef<HTMLDivElement | null>(null)
  const lastStepRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (streaming && visible.length > 0) {
      setOpen(true)
    }
  }, [streaming, visible.length])

  useEffect(() => {
    if (open && lastStepRef.current) {
      lastStepRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [open, visible.length, isRunning])

  const totalDuration = useMemo(() => {
    const runStep = steps.find((s) => s.kind === 'run')
    if (runStep?.endedAt != null) return runStep.endedAt - runStep.startedAt
    const ended = visible.filter((s) => s.endedAt != null)
    if (ended.length === 0) return null
    const minStart = Math.min(...visible.map((s) => s.startedAt))
    const maxEnd = Math.max(...ended.map((s) => s.endedAt!))
    return maxEnd - minStart
  }, [steps, visible])

  if (visible.length === 0 && !streaming) return null

  const SummaryIcon = isRunning ? CircleNotch : hasError ? XCircle : CheckCircle
  const summaryColor = isRunning ? 'text-accent' : hasError ? 'text-error' : 'text-muted'
  const summaryLabel = isRunning
    ? t('workspace.chat.traceRunningLabel', 'running…')
    : totalDuration != null
      ? `${(totalDuration / 1000).toFixed(1)}s`
      : null

  return (
    <section className={`agent-trace-panel agent-trace-panel-${isRunning ? 'running' : hasError ? 'error' : 'done'}`}>
      <div className="agent-trace-panel-header">
        <button
          type="button"
          className="agent-trace-panel-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className={`agent-trace-summary-icon ${isRunning ? 'agent-trace-summary-icon-running' : ''}`}>
            <SummaryIcon
              className={`h-3.5 w-3.5 shrink-0 ${summaryColor} ${isRunning ? 'animate-spin' : ''}`}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-foreground">
                {t('workspace.chat.trace', 'Agent activity')}
              </span>
              <span className="agent-trace-count">
                {visible.length > 0 ? visible.length : streaming ? '…' : 0}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-caption text-muted">
              {isRunning
                ? t('workspace.chat.traceFollowing', 'Following the current run')
                : hasError
                  ? t('workspace.chat.traceCompletedError', 'Completed with an error')
                  : t('workspace.chat.traceCompleted', 'Run details')}
            </span>
          </span>
          {summaryLabel && (
            <span className={`agent-trace-summary-badge ${isRunning ? 'agent-trace-summary-badge-running' : ''}`}>
              {summaryLabel}
            </span>
          )}
          {hasTokenData && !isRunning && (
            <span className="agent-trace-summary-badge">
              {t('workspace.chat.tokenTotal', { count: totalTokensSum })}
            </span>
          )}
          <CaretDown
            className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? '' : '-rotate-90'}`}
          />
        </button>
        {visible.length > 0 && open && (
          <button
            type="button"
            className="agent-trace-expand-all"
            onClick={() => setExpandAll(expandAll === null ? true : !expandAll)}
          >
            {expandAll ? t('workspace.chat.collapseAll', 'Collapse all') : t('workspace.chat.expandAll', 'Expand all')}
          </button>
        )}
      </div>
      {open && (
        <div ref={contentRef} className="agent-trace-steps">
          {visible.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted">
              {t('workspace.chat.traceEmpty', 'No tool or model steps yet.')}
            </p>
          ) : (
            visible.map((step, i) => (
              <div key={step.id} ref={i === visible.length - 1 ? lastStepRef : undefined}>
                <TraceStepRow
                  step={step}
                  isLast={i === visible.length - 1}
                  forceOpen={expandAll ?? undefined}
                />
              </div>
            ))
          )}
        </div>
      )}
    </section>
  )
}
