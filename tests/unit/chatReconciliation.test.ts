import { describe, expect, it } from 'vitest'
import type { AgentInterrupt, AgentTraceStep } from '../../src/shared/ipc-types'
import {
  latestRunStep,
  reconcileStreamValue,
  recoveredStreamContent,
  replaceRunTraceSnapshot,
  reviewedOcrDocumentId,
  traceRunStatus
} from '../../src/renderer/utils/chatReconciliation'

function makeStep(overrides: Partial<AgentTraceStep> = {}): AgentTraceStep {
  return {
    id: 'step-1',
    threadId: 'thread-1',
    runId: 'run-1',
    kind: 'run',
    name: null,
    input: null,
    output: null,
    status: 'running',
    startedAt: 1,
    endedAt: null,
    seq: 1,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    parentStepId: null,
    agentName: null,
    namespace: null,
    depth: 0,
    checkpointId: null,
    ...overrides
  }
}

function makeInterrupt(): AgentInterrupt {
  return {
    id: 'interrupt-1',
    runId: 'run-1',
    threadId: 'thread-1',
    checkpointId: null,
    actions: [{
      name: 'prepare_paper_ocr',
      args: { docId: 'doc-original' },
      allowedDecisions: ['approve', 'reject', 'edit']
    }],
    status: 'pending',
    decision: null,
    createdAt: 1,
    resolvedAt: null
  }
}

describe('chat reconciliation', () => {
  it('finds the newest run step and maps its terminal status', () => {
    const newest = makeStep({ id: 'new', startedAt: 2, seq: 2, status: 'error' })
    expect(latestRunStep([makeStep(), newest])).toBe(newest)
    expect(traceRunStatus(newest)).toBe('failed')
  })

  it('recovers ordered stream output without replacing newer live text', () => {
    const steps = [
      makeStep({ id: 'second', kind: 'message', startedAt: 2, seq: 2, output: 'world' }),
      makeStep({ id: 'first', kind: 'message', startedAt: 1, seq: 1, output: 'hello ' })
    ]
    const recovered = recoveredStreamContent(steps, 'run-1', 'message')
    expect(recovered).toBe('hello world')
    expect(reconcileStreamValue('hello world!', recovered)).toBe('hello world!')
    expect(reconcileStreamValue('stale', recovered)).toBe(recovered)
  })

  it('replaces only the reconciled run snapshot and preserves chronological order', () => {
    const otherRun = makeStep({ id: 'other', runId: 'run-2', startedAt: 1 })
    const stale = makeStep({ id: 'stale', startedAt: 2 })
    const complete = makeStep({ id: 'complete', startedAt: 3, status: 'done' })
    expect(replaceRunTraceSnapshot([otherRun, stale], [complete], 'run-1'))
      .toEqual([otherRun, complete])
  })

  it('uses edited OCR arguments and rejects denied interrupts', () => {
    const interrupt = makeInterrupt()
    expect(reviewedOcrDocumentId({ interrupt, decision: 'approve' })).toBe('doc-original')
    expect(reviewedOcrDocumentId({
      interrupt,
      decision: 'edit',
      editedActions: [{ name: 'prepare_paper_ocr', args: { docId: ' doc-edited ' } }]
    })).toBe('doc-edited')
    expect(reviewedOcrDocumentId({ interrupt, decision: 'reject' })).toBeNull()
  })
})
