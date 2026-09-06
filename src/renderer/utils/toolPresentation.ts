import type { AgentTraceStep, ChatMediaItem } from '../../shared/ipc-types'
import { mediaSourceFromUrl } from './mediaSources'

export type ToolRecord = Record<string, unknown>
export const toolRecord = (value: unknown): ToolRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ToolRecord : {}
export const toolString = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

export function toolValue(value: unknown): unknown {
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value) as unknown } catch { return value }
    } else {
      const entry = toolRecord(value)
      if (entry.data !== undefined && (entry.ok === true || Object.keys(entry).length === 1)) value = entry.data
      else if (entry.input !== undefined && Object.keys(entry).every((key) => ['input', 'tool_call_id', 'id', 'name'].includes(key))) value = entry.input
      else return value
    }
  }
  return value
}

export function toolResultValue(step: AgentTraceStep): unknown {
  const value = toolValue(step.result ?? step.output)
  const entry = toolRecord(value)
  if (entry.data && ['document', 'report', 'note', 'asset'].includes(toolString(entry.kind))) {
    const nested = toolRecord(entry.data)
    const key = entry.kind === 'document' ? 'docId' : entry.kind === 'asset' ? 'assetId' : `${toolString(entry.kind)}Id`
    return { ...nested, [key]: nested[key] ?? nested.id }
  }
  return value
}

export function toolTarget(step: AgentTraceStep): string {
  const result = toolRecord(toolResultValue(step))
  const input = toolRecord(toolValue(step.input))
  return toolString(result.title) || toolString(result.fileName) || toolString(input.title)
}

function sourceKey(source: ChatMediaItem['source']): string {
  return JSON.stringify(Object.entries(source).sort(([left], [right]) => left.localeCompare(right)))
}

export function assignToolMedia(media: ChatMediaItem[], steps: AgentTraceStep[]): ChatMediaItem[] {
  const owners = new Map<string, string>()
  for (const step of steps) {
    if (step.kind !== 'tool') continue
    const visit = (value: unknown, depth: number): void => {
      if (depth > 5) return
      if (Array.isArray(value)) { value.slice(0, 100).forEach((item) => visit(item, depth + 1)); return }
      const entry = toolRecord(value)
      if (typeof entry.assetId === 'string') owners.set(sourceKey({ type: 'asset', assetId: entry.assetId }), step.id)
      const path = toolString(entry.path) || toolString(entry.url)
      const source = path ? mediaSourceFromUrl(path, { runId: step.runId }) : null
      if (source) owners.set(sourceKey(source), step.id)
      const direct = toolRecord(entry.source)
      if (typeof direct.type === 'string') owners.set(JSON.stringify(Object.entries(direct).sort(([left], [right]) => left.localeCompare(right))), step.id)
      for (const key of ['published', 'artifacts', 'files', 'media', 'content', 'data', 'items']) if (entry[key]) visit(entry[key], depth + 1)
    }
    visit(toolResultValue(step), 0)
  }
  return media.map((item) => {
    const toolStepId = item.toolStepId ?? owners.get(sourceKey(item.source))
    return toolStepId ? { ...item, toolStepId } : item
  })
}
