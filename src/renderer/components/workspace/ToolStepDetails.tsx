import { applicationToolStep } from '../../utils/toolPresentation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Code, CaretDown } from '@phosphor-icons/react'
import type { AgentTraceStep } from '../../../shared/ipc-types'
import { toolRecord, toolResultValue, toolString, toolTarget, toolValue } from '../../utils/toolPresentation'
import { ToolResultCards } from './ToolResultCards'

function diagnostic(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
  }
  return JSON.stringify(value, null, 2) ?? ''
}

function website(value: string): string {
  try { const url = new URL(value); return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}` } catch { return value.slice(0, 200) }
}

export function ToolStepDetails({ step }: { step: AgentTraceStep }) {
  const rawInput = step.input
  step = applicationToolStep(step)
  const { t } = useTranslation()
  const [technical, setTechnical] = useState(false)
  const inputValue = toolValue(step.input)
  const input = toolRecord(inputValue)
  const resultValue = toolResultValue(step)
  const result = toolRecord(resultValue)
  const name = step.name?.replace(/^refora\./, '') ?? ''
  const command = toolString(input.command) || toolString(input.script) || toolString(input.cmd)
  const query = toolString(input.query) || toolString(input.q) || toolString(input.search_query)
  const path = toolString(input.file_path) || toolString(input.path)
  const target = toolTarget(step)
  const parameters: Array<[string, string]> = []
  const add = (key: string, value: string) => { if (value) parameters.push([t(`workspace.chat.toolDetails.${key}`), value]) }
  add('query', query)
  if (input.scope === 'library' || input.scope === 'workspace') add('scope', t(`workspace.chat.toolDetails.${input.scope}`))
  if ((input.docId || input.documentId) && !target) add('paper', t('workspace.chat.toolDetails.selectedPaper'))
  add('file', path)
  add('website', website(toolString(input.url) || toolString(input.uri)))
  const textSource = result.source === 'mineru_ocr' ? 'ocr' : result.source === 'extracted' ? 'extracted' : input.source
  if (textSource === 'ocr' || textSource === 'extracted' || textSource === 'auto') add('source', t(`workspace.chat.toolDetails.${textSource}`))
  if (typeof input.timeoutSeconds === 'number') add('timeout', `${input.timeoutSeconds}s`)
  const records = Array.isArray(resultValue) ? resultValue : ['documents', 'papers', 'results', 'published', 'artifacts', 'items', 'rows', 'media'].map((key) => result[key]).find(Array.isArray)
  const count = Array.isArray(records) ? records.length : null
  const error = toolRecord(result.error)
  const errorText = toolString(error.message) || toolString(result.error) || (step.status === 'error' ? toolString(result.message) || (typeof resultValue === 'string' ? resultValue : '') : '')
  const prose = typeof resultValue === 'string' ? resultValue : toolString(result.stdout) || toolString(result.output) || toolString(result.message)
  const log = [prose, toolString(result.stderr)].filter(Boolean).join('\n')
  const excerpt = toolString(result.text)
  const status = step.status === 'error' ? 'failed' : step.status === 'cancelled' ? 'cancelled' : step.status === 'interrupted' ? 'awaitingApproval' : step.status === 'running' ? 'inProgress' : 'completed'
  const summary = errorText || (
    count !== null ? t('workspace.chat.toolDetails.resultCount', { count })
      : excerpt ? t('workspace.chat.toolDetails.readCharacters', { count: excerpt.length })
        : command && typeof result.exitCode === 'number' ? t('workspace.chat.toolDetails.exitCode', { code: result.exitCode })
          : t(`workspace.chat.toolDetails.${status}`)
  )
  return <div className="tool-step-content">
    <p className={`tool-step-summary${step.status === 'error' || errorText ? ' tool-step-summary-error' : ''}`}>{summary}</p>
    {parameters.length > 0 && <dl className="tool-step-parameters">{parameters.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {command && <div className="tool-step-command"><span>{t('workspace.chat.toolDetails.command')}</span><pre>{command}</pre></div>}
    {(step.status === 'done' || step.status === 'error') && <div className="tool-step-results-region"><ToolResultCards step={step} /></div>}
    {log && !errorText && !records && !excerpt && <pre className={command ? 'tool-step-output tool-step-output-terminal' : 'tool-step-output'}>{log.slice(0, 4000)}</pre>}
    {name === 'task' && typeof input.description === 'string' && <p className="tool-step-output">{input.description}</p>}
    <button type="button" className="tool-step-technical-toggle" aria-expanded={technical} onClick={() => setTechnical((value) => !value)}>
      <Code className="h-3.5 w-3.5" /><span>{t('workspace.chat.toolDetails.technical')}</span><CaretDown className={`h-3 w-3 transition-transform${technical ? ' rotate-180' : ''}`} />
    </button>
    {technical && <div className="tool-step-technical">
      {step.input && <div className="agent-trace-detail-card"><p className="agent-trace-detail-label">{t('workspace.chat.traceInput', 'Input')}</p><pre className="agent-trace-detail-value">{diagnostic(rawInput)}</pre></div>}
      {(step.result != null || step.output) && <div className="agent-trace-detail-card"><p className="agent-trace-detail-label">{t('workspace.chat.traceOutput', 'Output')}</p><pre className="agent-trace-detail-value">{diagnostic(step.result ?? step.output)}</pre></div>}
    </div>}
  </div>
}
