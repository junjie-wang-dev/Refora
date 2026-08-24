import { inferModelCapabilities, type ModelCapabilityHints } from './providerCatalog'
import type { ModelVariantFormat, ProviderModelInfo } from './ipc-types'

export type { ModelVariantFormat, ProviderModelInfo }

export const COMMON_VARIANTS = ['high', 'xhigh', 'max', 'fast', 'thinking'] as const

export type CommonVariant = (typeof COMMON_VARIANTS)[number]

const VARIANT_PATTERN = /(?:[-:])(high|xhigh|max|fast|thinking)$/i

export const REASONING_MODEL_TOKENS = [
  'deepseek-r1', 'reasoner', 'qwq', 'o1', 'o3', 'o4', 'gpt-5', 'thinking'
] as const

const VARIANT_HINT_RE = new RegExp(
  [...REASONING_MODEL_TOKENS, 'glm', 'claude', 'gemini'].join('|'),
  'i'
)

export function supportsModelVariants(modelId: string): boolean {
  const id = modelId.trim()
  if (!id) return false
  if (VARIANT_PATTERN.test(id)) return true
  return VARIANT_HINT_RE.test(id)
}

export function parseModelId(fullModel: string): {
  baseModel: string
  variant: string
} {
  const trimmed = fullModel.trim()
  if (!trimmed) return { baseModel: '', variant: '' }
  const match = trimmed.match(VARIANT_PATTERN)
  if (!match || match.index == null) {
    return { baseModel: trimmed, variant: '' }
  }
  return {
    baseModel: trimmed.slice(0, match.index),
    variant: match[1].toLowerCase()
  }
}

export function detectVariantFormat(fullModel: string): ModelVariantFormat {
  const trimmed = fullModel.trim()
  if (/:/.test(trimmed) && VARIANT_PATTERN.test(trimmed)) return 'colon'
  if (/-/.test(trimmed) && VARIANT_PATTERN.test(trimmed)) return 'dash'
  return 'dash'
}

export function composeModelId(
  baseModel: string,
  variant: string,
  format: ModelVariantFormat = 'dash'
): string {
  const base = baseModel.trim()
  const v = variant.trim()
  if (!base) return ''
  if (!v || format === 'none') return base
  if (format === 'colon') return `${base}:${v}`
  return `${base}-${v}`
}

export function toProviderModelInfo(
  modelId: string,
  providerName?: string,
  presetId = 'custom',
  hints: ModelCapabilityHints = {}
): ProviderModelInfo {
  const capabilities = inferModelCapabilities(presetId, modelId, hints)
  return {
    id: modelId,
    providerName,
    supportsVariants: supportsModelVariants(modelId),
    ...capabilities
  }
}

export function normalizeModelList(
  ids: string[],
  providerName?: string,
  presetId = 'custom'
): ProviderModelInfo[] {
  const seen = new Set<string>()
  const out: ProviderModelInfo[] = []
  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(toProviderModelInfo(id, providerName, presetId))
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
