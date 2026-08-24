import type {
  AgentInterrupt,
  AgentInterruptDecision,
  AgentRunStatus,
  AgentTraceStep
} from '../../shared/ipc-types'

export interface ResumeRetryContext {
  interrupt: AgentInterrupt
  decision: AgentInterruptDecision
  editedActions?: Array<{ name: string; args: Record<string, unknown> }>
}

export function latestRunStep(
  steps: AgentTraceStep[],
  runId?: string | null
): AgentTraceStep | null {
  const candidates = steps
    .filter((step) => step.kind === 'run' && (!runId || step.runId === runId))
    .sort((left, right) => right.startedAt - left.startedAt || right.seq - left.seq)
  return candidates[0] ?? null
}

export function traceRunStatus(step: AgentTraceStep | null): AgentRunStatus | null {
  if (!step) return null
  if (step.status === 'running') return 'running'
  if (step.status === 'done') return 'completed'
  if (step.status === 'error') return 'failed'
  if (step.status === 'interrupted') return 'interrupted'
  if (step.status === 'cancelled') return 'cancelled'
  return null
}

export function recoveredStreamContent(
  steps: AgentTraceStep[],
  runId: string,
  kind: 'reasoning' | 'message'
): string {
  return steps
    .filter((step) => step.runId === runId && step.kind === kind)
    .sort((left, right) => left.startedAt - right.startedAt || left.seq - right.seq)
    .map((step) => step.output ?? '')
    .join('')
}

export function reconcileStreamValue(current: string, recovered: string): string {
  if (!recovered || current.startsWith(recovered)) return current
  return recovered
}

export function replaceRunTraceSnapshot(
  current: AgentTraceStep[],
  snapshot: AgentTraceStep[],
  runId: string
): AgentTraceStep[] {
  const completedRun = snapshot.filter((step) => step.runId === runId)
  if (completedRun.length === 0) return current
  return [
    ...current.filter((step) => step.runId !== runId),
    ...completedRun
  ].sort((left, right) => left.startedAt - right.startedAt || left.seq - right.seq)
}

export function reviewedOcrDocumentId(context: ResumeRetryContext): string | null {
  if (context.decision === 'reject') return null
  const action = context.interrupt.actions.find((candidate) => candidate.name === 'prepare_paper_ocr')
  if (!action) return null
  const edited = context.decision === 'edit'
    ? context.editedActions?.find((candidate) => candidate.name === action.name)
    : null
  const docId = (edited?.args ?? action.args).docId
  return typeof docId === 'string' && docId.trim() ? docId.trim() : null
}
