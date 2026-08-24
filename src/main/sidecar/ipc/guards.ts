import type {
  AgentInterrupt,
  AgentInterruptAction,
  AgentInterruptDecision,
  AgentInterruptDecisionEntry,
  AgentTraceStep,
  AgentTraceStepKind,
  AgentTraceStepStatus,
  AiApiProtocol,
  AiProviderPatch,
  AiReasoningControl,
  AiReasoningEffort,
  ModelVariantFormat,
  WorkspaceCanvasViewport
} from '../../../shared/ipc-types'
import type { ChatResumePayload } from '../client'
import { logger } from '../../services/logger'

export const INVALID_UPSTREAM_PAYLOAD = 'invalid_upstream_payload'
export const INVALID_REQUEST_PAYLOAD = 'invalid_request_payload'

const AGENT_INTERRUPT_DECISIONS: readonly AgentInterruptDecision[] = ['approve', 'reject', 'edit']
const TRACE_STEP_KINDS: readonly AgentTraceStepKind[] = [
  'llm',
  'tool',
  'reasoning',
  'message',
  'run',
  'todo',
  'subagent',
  'approval',
  'checkpoint'
]
const TRACE_STEP_STATUSES: readonly AgentTraceStepStatus[] = [
  'running',
  'done',
  'error',
  'interrupted',
  'cancelled'
]
const AI_API_PROTOCOLS: readonly AiApiProtocol[] = ['openai-responses', 'openai-compatible']
const AI_REASONING_CONTROLS: readonly AiReasoningControl[] = ['openai', 'thinking', 'enable-thinking', 'none']
const AI_REASONING_EFFORTS: readonly AiReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]
const MODEL_VARIANT_FORMATS: readonly ModelVariantFormat[] = ['dash', 'colon', 'none']

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function oneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value)
}

function payloadError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function expectAgentTraces(value: unknown): AgentTraceStep[] {
  if (!isArray(value)) {
    throw payloadError(INVALID_UPSTREAM_PAYLOAD, 'Upstream chat traces payload must be an array')
  }
  const steps: AgentTraceStep[] = []
  for (const entry of value) {
    const step = parseAgentTraceStep(entry)
    if (step) {
      steps.push(step)
    } else {
      logger.warn('ipc-guards:dropped invalid chat trace step')
    }
  }
  return steps
}

function parseAgentTraceStep(value: unknown): AgentTraceStep | null {
  if (!isRecord(value)) return null
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.threadId) || !isNonEmptyString(value.runId)) return null
  const kind = value.kind
  const status = value.status
  if (!oneOf(TRACE_STEP_KINDS, kind) || !oneOf(TRACE_STEP_STATUSES, status)) return null
  if (!isNullableString(value.name) || !isNullableString(value.input) || !isNullableString(value.output)) return null
  if (!isFiniteNumber(value.startedAt) || !isNullableFiniteNumber(value.endedAt) || !isFiniteNumber(value.seq)) return null
  if (
    !isNullableFiniteNumber(value.inputTokens) ||
    !isNullableFiniteNumber(value.outputTokens) ||
    !isNullableFiniteNumber(value.totalTokens)
  ) {
    return null
  }
  if (
    !isNullableString(value.parentStepId) ||
    !isNullableString(value.agentName) ||
    !isNullableString(value.namespace) ||
    !isNullableString(value.checkpointId)
  ) {
    return null
  }
  if (!isFiniteNumber(value.depth)) return null
  return {
    id: value.id,
    threadId: value.threadId,
    runId: value.runId,
    kind,
    name: value.name,
    input: value.input,
    output: value.output,
    status,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    seq: value.seq,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    parentStepId: value.parentStepId,
    agentName: value.agentName,
    namespace: value.namespace,
    depth: value.depth,
    checkpointId: value.checkpointId
  }
}

export function expectAgentInterrupt(value: unknown): AgentInterrupt | null {
  if (value === null) return null
  const parsed = isRecord(value) ? parseAgentInterruptRecord(value) : null
  if (!parsed) {
    throw payloadError(INVALID_UPSTREAM_PAYLOAD, 'Upstream interrupt payload has an invalid shape')
  }
  return parsed
}

function parseAgentInterruptRecord(value: Record<string, unknown>): AgentInterrupt | null {
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.runId) || !isNonEmptyString(value.threadId)) return null
  if (!isNullableString(value.checkpointId)) return null
  if (value.status !== 'pending' && value.status !== 'resolved') return null
  if (!isFiniteNumber(value.createdAt) || !isNullableFiniteNumber(value.resolvedAt)) return null
  if (!isArray(value.actions)) return null
  const actions: AgentInterruptAction[] = []
  for (const entry of value.actions) {
    const action = parseInterruptAction(entry)
    if (!action) return null
    actions.push(action)
  }
  let decision: AgentInterruptDecisionEntry[] | null = null
  if (value.decision !== null && value.decision !== undefined) {
    if (!isArray(value.decision)) return null
    decision = []
    for (const entry of value.decision) {
      const parsedEntry = parseInterruptDecisionEntry(entry)
      if (!parsedEntry) return null
      decision.push(parsedEntry)
    }
  }
  return {
    id: value.id,
    runId: value.runId,
    threadId: value.threadId,
    checkpointId: value.checkpointId,
    actions,
    status: value.status,
    decision,
    createdAt: value.createdAt,
    resolvedAt: value.resolvedAt
  }
}

function parseInterruptAction(value: unknown): AgentInterruptAction | null {
  if (!isRecord(value)) return null
  if (!isNonEmptyString(value.name) || !isRecord(value.args) || !isArray(value.allowedDecisions)) return null
  const allowedDecisions: AgentInterruptDecision[] = []
  for (const entry of value.allowedDecisions) {
    if (!oneOf(AGENT_INTERRUPT_DECISIONS, entry)) return null
    allowedDecisions.push(entry)
  }
  const action: AgentInterruptAction = {
    name: value.name,
    args: value.args,
    allowedDecisions
  }
  if (value.description !== undefined) {
    if (!isString(value.description)) return null
    action.description = value.description
  }
  return action
}

function parseInterruptDecisionEntry(value: unknown): AgentInterruptDecisionEntry | null {
  if (!isRecord(value)) return null
  if (!oneOf(AGENT_INTERRUPT_DECISIONS, value.type)) return null
  const entry: AgentInterruptDecisionEntry = { type: value.type }
  const edited = value.editedAction
  if (edited !== undefined && edited !== null) {
    if (!isRecord(edited) || !isNonEmptyString(edited.name) || !isRecord(edited.args)) return null
    entry.editedAction = { name: edited.name, args: edited.args }
  }
  return entry
}

export function expectChatResumePayload(value: unknown): ChatResumePayload {
  if (!isRecord(value)) {
    throw payloadError(INVALID_REQUEST_PAYLOAD, 'Chat resume request must be an object')
  }
  if (!isNonEmptyString(value.threadId) || !isNonEmptyString(value.runId) || !isArray(value.decisions)) {
    throw payloadError(INVALID_REQUEST_PAYLOAD, 'Chat resume request requires threadId, runId, and decisions')
  }
  for (const entry of value.decisions) {
    if (!parseInterruptDecisionEntry(entry)) {
      throw payloadError(INVALID_REQUEST_PAYLOAD, 'Chat resume decisions must be objects with a supported type')
    }
  }
  return {
    threadId: value.threadId,
    runId: value.runId,
    decisions: value.decisions
  }
}

export function expectWorkspaceCanvasViewport(value: unknown, errorCode: string): WorkspaceCanvasViewport {
  if (!isRecord(value) || !isFiniteNumber(value.panX) || !isFiniteNumber(value.panY) || !isFiniteNumber(value.zoom)) {
    throw payloadError(errorCode, 'Workspace canvas viewport requires numeric panX, panY, and zoom')
  }
  return { panX: value.panX, panY: value.panY, zoom: value.zoom }
}

export function expectAiProviderPatch(value: unknown): AiProviderPatch {
  if (!isRecord(value)) {
    throw payloadError(INVALID_REQUEST_PAYLOAD, 'AI provider update must be an object')
  }
  const patch: AiProviderPatch = {}
  if (value.presetId !== undefined) {
    if (!isString(value.presetId)) return failProviderPatchField('presetId')
    patch.presetId = value.presetId
  }
  if (value.name !== undefined) {
    if (!isNonEmptyString(value.name)) return failProviderPatchField('name')
    patch.name = value.name
  }
  if (value.baseUrl !== undefined) {
    if (!isNonEmptyString(value.baseUrl)) return failProviderPatchField('baseUrl')
    patch.baseUrl = value.baseUrl
  }
  if (value.apiProtocol !== undefined) {
    if (!oneOf(AI_API_PROTOCOLS, value.apiProtocol)) return failProviderPatchField('apiProtocol')
    patch.apiProtocol = value.apiProtocol
  }
  if (value.reasoningControl !== undefined) {
    if (!oneOf(AI_REASONING_CONTROLS, value.reasoningControl)) return failProviderPatchField('reasoningControl')
    patch.reasoningControl = value.reasoningControl
  }
  if (value.reasoningEffort !== undefined) {
    if (!oneOf(AI_REASONING_EFFORTS, value.reasoningEffort)) return failProviderPatchField('reasoningEffort')
    patch.reasoningEffort = value.reasoningEffort
  }
  if (value.model !== undefined) {
    if (!isNonEmptyString(value.model)) return failProviderPatchField('model')
    patch.model = value.model
  }
  if (value.models !== undefined) {
    if (value.models === null) {
      patch.models = null
    } else if (isArray(value.models) && value.models.every(isString)) {
      patch.models = [...value.models]
    } else {
      return failProviderPatchField('models')
    }
  }
  if (value.baseModel !== undefined) {
    if (!isNonEmptyString(value.baseModel)) return failProviderPatchField('baseModel')
    patch.baseModel = value.baseModel
  }
  if (value.variant !== undefined) {
    if (!isString(value.variant)) return failProviderPatchField('variant')
    patch.variant = value.variant
  }
  if (value.variantFormat !== undefined) {
    if (!oneOf(MODEL_VARIANT_FORMATS, value.variantFormat)) return failProviderPatchField('variantFormat')
    patch.variantFormat = value.variantFormat
  }
  if (value.apiKey !== undefined) {
    if (!isString(value.apiKey)) return failProviderPatchField('apiKey')
    patch.apiKey = value.apiKey
  }
  if (value.temperature !== undefined) {
    if (!isNullableFiniteNumber(value.temperature)) return failProviderPatchField('temperature')
    patch.temperature = value.temperature
  }
  if (value.maxTokens !== undefined) {
    if (!isNullableFiniteNumber(value.maxTokens)) return failProviderPatchField('maxTokens')
    patch.maxTokens = value.maxTokens
  }
  return patch
}

function failProviderPatchField(field: string): never {
  throw payloadError(INVALID_REQUEST_PAYLOAD, `AI provider update field ${field} is invalid`)
}
