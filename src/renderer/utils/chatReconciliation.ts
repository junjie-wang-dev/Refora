import { resolveAgentToolCall } from '../../shared/agent-tools'
import type {
  AgentInterrupt,
  AgentInterruptDecision,
  AgentInterruptDecisionEntry,
  AgentRunStatus,
  AgentTraceStep
} from '../../shared/ipc-types'

export interface ResumeRetryContext {
  interrupt: AgentInterrupt
  decision: AgentInterruptDecision | AgentInterruptDecisionEntry[]
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

export function interruptDecisions(context: ResumeRetryContext): AgentInterruptDecisionEntry[] {
  if (Array.isArray(context.decision)) return context.decision
  return context.interrupt.actions.map((action, index) => context.decision === 'edit'
    ? {
        type: 'edit',
        editedAction: context.editedActions?.[index] ?? { name: action.name, args: action.args }
      }
    : { type: context.decision as AgentInterruptDecision })
}

export function reviewedOcrDocumentId(context: ResumeRetryContext): string | null {
  const decisions = interruptDecisions(context)
  for (const [index, action] of context.interrupt.actions.entries()) {
    const decision = decisions[index]
    if (resolveAgentToolCall(action.name, action.args).name !== 'prepare_paper_ocr' || !decision || decision.type === 'reject') continue
    const reviewed = decision.editedAction ?? action
    const docId = resolveAgentToolCall(reviewed.name, reviewed.args).args.docId
    if (typeof docId === 'string' && docId.trim()) return docId.trim()
  }
  return null
}
