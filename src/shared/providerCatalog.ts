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

const OPENAI_EFFORTS: AiReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    mark: 'OA',
    description: 'GPT models through the native Responses API',
    baseUrl: 'https://api.openai.com/v1',
    apiProtocol: 'openai-responses',
    reasoningControl: 'openai',
    reasoningEfforts: OPENAI_EFFORTS,
    defaultReasoningEffort: 'medium',
    defaultModel: 'gpt-5.6-terra',
    apiKeyRequired: true,
    popular: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    mark: 'DS',
    description: 'DeepSeek chat and hybrid thinking models',
    baseUrl: 'https://api.deepseek.com',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'thinking',
    reasoningEfforts: ['none', 'high', 'max'],
    defaultReasoningEffort: 'high',
    defaultModel: 'deepseek-v4-flash',
    apiKeyRequired: true,
    popular: true
  },
  {
    id: 'kimi',
    name: 'Kimi',
    mark: 'KM',
    description: 'Moonshot long-context and thinking models',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'thinking',
    reasoningEfforts: ['none', 'high'],
    defaultReasoningEffort: 'high',
    defaultModel: 'kimi-k2.6',
    apiKeyRequired: true,
    popular: true
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    mark: 'OC',
    description: 'Cloud models through a signed-in local Ollama service',
    baseUrl: 'http://localhost:11434/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'openai',
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    defaultModel: 'gpt-oss:120b-cloud',
    apiKeyRequired: false,
    popular: true
  },
  {
    id: 'ollama-local',
    name: 'Ollama Local',
    mark: 'OL',
    description: 'Models running privately on this Mac',
    baseUrl: 'http://localhost:11434/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'openai',
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    defaultModel: 'gpt-oss:20b',
    apiKeyRequired: false,
    popular: true
  },
  {
    id: 'glm',
    name: 'GLM',
    mark: 'GL',
    description: 'Zhipu GLM reasoning and agent models',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'thinking',
    reasoningEfforts: OPENAI_EFFORTS,
    defaultReasoningEffort: 'high',
    defaultModel: 'glm-5.2',
    apiKeyRequired: true,
    popular: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    mark: 'OR',
    description: 'Hundreds of models behind one API key',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'openai',
    reasoningEfforts: OPENAI_EFFORTS,
    defaultReasoningEffort: 'medium',
    defaultModel: 'openai/gpt-5.4-mini',
    apiKeyRequired: true,
    popular: true
  },
  {
    id: 'qwen',
    name: 'Qwen',
    mark: 'QW',
    description: 'Alibaba Model Studio Qwen models',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'enable-thinking',
    reasoningEfforts: ['none', 'high'],
    defaultReasoningEffort: 'high',
    defaultModel: 'qwen3.7-plus',
    apiKeyRequired: true,
    popular: false
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    mark: 'SF',
    description: 'Fast access to leading open models',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'openai',
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
    defaultModel: 'deepseek-ai/DeepSeek-R1',
    apiKeyRequired: true,
    popular: false
  },
  {
    id: 'together',
    name: 'Together AI',
    mark: 'TG',
    description: 'Open models with serverless inference',
    baseUrl: 'https://api.together.ai/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'openai',
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'max'],
    defaultReasoningEffort: 'medium',
    defaultModel: 'openai/gpt-oss-20b',
    apiKeyRequired: true,
    popular: false
  },
  {
    id: 'groq',
    name: 'Groq',
    mark: 'GQ',
    description: 'Low-latency OpenAI-compatible inference',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'openai',
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    defaultModel: 'openai/gpt-oss-20b',
    apiKeyRequired: true,
    popular: false
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    mark: 'MI',
    description: 'Mistral chat, code, and reasoning models',
    baseUrl: 'https://api.mistral.ai/v1',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'none',
    reasoningEfforts: [],
    defaultReasoningEffort: 'none',
    defaultModel: 'mistral-large-latest',
    apiKeyRequired: true,
    popular: false
  },
  {
    id: 'custom',
    name: 'Custom provider',
    mark: '+',
    description: 'Any Responses or OpenAI-compatible endpoint',
    baseUrl: '',
    apiProtocol: 'openai-compatible',
    reasoningControl: 'openai',
    reasoningEfforts: OPENAI_EFFORTS,
    defaultReasoningEffort: 'medium',
    defaultModel: '',
    apiKeyRequired: false,
    popular: false
  }
] as const

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
  const id = modelId.toLowerCase()
  if (presetId === 'kimi') {
    if (/k2\.7-code|thinking/.test(id)) return ['high']
    if (/k2\.6|k2\.5/.test(id)) return ['none', 'high']
  }
  if (presetId === 'deepseek') {
    if (/v4-(?:flash|pro)|reasoner/.test(id)) return ['none', 'high', 'max']
  }
  if (presetId === 'glm') {
    if (/glm-5\.2/.test(id)) return OPENAI_EFFORTS
    if (/glm-(?:5\.1|5|4\.[5-7])/.test(id)) return ['none', 'high']
  }
  if (/gpt-oss/.test(id)) return ['low', 'medium', 'high']
  if (presetId === 'groq' && /qwen3/.test(id)) return ['none', 'high']
  if (presetId === 'ollama-local' || presetId === 'ollama-cloud') {
    if (/qwen3|deepseek|reason|thinking/.test(id)) return ['none', 'high']
  }
  if (presetId === 'qwen' && /qwen3/.test(id)) return ['none', 'high']
  return getProviderPreset(presetId).reasoningEfforts
}

export function inferModelCapabilities(
  presetId: string,
  modelId: string,
  hints: ModelCapabilityHints = {}
): ModelCapabilities {
  const supportedParameters = Array.from(new Set(hints.supportedParameters ?? [])).sort()
  const reasoningEfforts = reasoningEffortsForModel(presetId, modelId)
  const id = modelId.toLowerCase()
  return {
    supportsReasoning: true,
    reasoningEfforts,
    supportsVision:
      hints.supportsVision === true ||
      /vision|vl|gpt-4o|gpt-5|gemini|pixtral|llava|qwen.*vl|kimi-k2\.[5-7]/i.test(id),
    supportsTools:
      hints.supportsTools === true ||
      supportedParameters.includes('tools') ||
      !/embed|moderation|rerank|whisper|tts|image|audio|guard/i.test(id),
    supportedParameters
  }
}

export function isLikelyChatModel(modelId: string): boolean {
  return !/embed|moderation|rerank|whisper|transcri|tts|image|dall-e|realtime|audio|guard/i.test(
    modelId
  )
}

export function pickDefaultModel(
  preset: ProviderPreset,
  modelIds: readonly string[]
): string {
  if (modelIds.includes(preset.defaultModel)) return preset.defaultModel
  return modelIds.find(isLikelyChatModel) ?? preset.defaultModel
}
