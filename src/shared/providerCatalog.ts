import catalog from '../../backend/refora_server/providers/catalog.json'
import type {
  AiApiProtocol,
  AiReasoningControl,
  AiReasoningEffort
} from './ipc-types'

export interface ProviderPreset {
  id: string
  name: string
  mark: string
  description: string
  baseUrl: string
  apiProtocol: AiApiProtocol
  reasoningControl: AiReasoningControl
  reasoningEfforts: AiReasoningEffort[]
  defaultReasoningEffort: AiReasoningEffort
  defaultModel: string
  apiKeyRequired: boolean
  popular: boolean
}

export interface ModelCapabilityHints {
  supportedParameters?: string[]
  supportsReasoning?: boolean
  supportsVision?: boolean
  supportsTools?: boolean
}

export interface ModelCapabilities {
  supportsReasoning: boolean
  reasoningEfforts: AiReasoningEffort[]
  supportsVision: boolean
  supportsTools: boolean
  supportedParameters: string[]
}

interface ReasoningRuleData {
  providers?: string[]
  pattern: string
  efforts: AiReasoningEffort[]
}

const REASONING_RULES = (catalog.reasoningRules as ReasoningRuleData[]).map((rule) => ({
  ...rule,
  pattern: new RegExp(rule.pattern, 'i')
}))
const VISION_RE = new RegExp(catalog.visionPattern, 'i')
const NON_TOOL_RE = new RegExp(catalog.nonToolPattern, 'i')
const NON_CHAT_RE = new RegExp(catalog.nonChatPattern, 'i')

export const PROVIDER_PRESETS = catalog.presets as readonly ProviderPreset[]

export function getProviderPreset(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
}

export function providerRequiresApiKey(id: string): boolean {
  return getProviderPreset(id).apiKeyRequired
}

export function reasoningEffortsForModel(
  presetId: string,
  modelId: string
): AiReasoningEffort[] {
  for (const rule of REASONING_RULES) {
    if (rule.providers && !rule.providers.includes(presetId)) continue
    if (rule.pattern.test(modelId)) return [...rule.efforts]
  }
  return [...getProviderPreset(presetId).reasoningEfforts]
}

export function inferModelCapabilities(
  presetId: string,
  modelId: string,
  hints: ModelCapabilityHints = {}
): ModelCapabilities {
  const supportedParameters = Array.from(new Set(hints.supportedParameters ?? [])).sort()
  const reasoningEfforts = reasoningEffortsForModel(presetId, modelId)
  return {
    supportsReasoning: hints.supportsReasoning ?? reasoningEfforts.length > 0,
    reasoningEfforts,
    supportsVision: hints.supportsVision === true || VISION_RE.test(modelId),
    supportsTools:
      hints.supportsTools === true ||
      supportedParameters.includes('tools') ||
      !NON_TOOL_RE.test(modelId),
    supportedParameters
  }
}

export function isLikelyChatModel(modelId: string): boolean {
  return !NON_CHAT_RE.test(modelId)
}

export function pickDefaultModel(
  preset: ProviderPreset,
  modelIds: readonly string[]
): string {
  if (modelIds.includes(preset.defaultModel)) return preset.defaultModel
  return modelIds.find(isLikelyChatModel) ?? preset.defaultModel
}
