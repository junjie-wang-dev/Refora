import { describe, it, expect } from 'vitest'
import {
  composeModelId,
  parseModelId,
  supportsModelVariants,
  normalizeModelList,
  detectVariantFormat
} from '../../src/shared/modelVariant'
import type { ProviderModelInfo } from '../../src/shared/ipc-types'

describe('modelVariant', () => {
  it('parses dash and colon variants', () => {
    expect(parseModelId('glm-5-2-260617-high')).toEqual({
      baseModel: 'glm-5-2-260617',
      variant: 'high'
    })
    expect(parseModelId('glm-5-2-260617:xhigh')).toEqual({
      baseModel: 'glm-5-2-260617',
      variant: 'xhigh'
    })
    expect(parseModelId('gpt-4o-mini')).toEqual({
      baseModel: 'gpt-4o-mini',
      variant: ''
    })
  })

  it('composes model ids with configurable format', () => {
    expect(composeModelId('glm-5-2', 'high', 'dash')).toBe('glm-5-2-high')
    expect(composeModelId('glm-5-2', 'xhigh', 'colon')).toBe('glm-5-2:xhigh')
    expect(composeModelId('glm-5-2', 'high', 'none')).toBe('glm-5-2')
    expect(composeModelId('glm-5-2', '', 'dash')).toBe('glm-5-2')
  })

  it('detects variant support heuristics', () => {
    expect(supportsModelVariants('glm-4-flash')).toBe(true)
    expect(supportsModelVariants('claude-3-5-sonnet')).toBe(true)
    expect(supportsModelVariants('llama3.1')).toBe(false)
  })

  it('detects format from existing model strings', () => {
    expect(detectVariantFormat('a:b-high')).toBe('colon')
    expect(detectVariantFormat('a-high')).toBe('dash')
  })

  it('normalizes model lists with variant flags', () => {
    const list = normalizeModelList(['gpt-4o', 'glm-4', 'gpt-4o'], 'OpenAI')
    expect(list).toHaveLength(2)
    expect(list.find((m) => m.id === 'glm-4')?.supportsVariants).toBe(true)
    expect(list.find((m) => m.id === 'gpt-4o')?.providerName).toBe('OpenAI')
  })

  it('produces the converged ProviderModelInfo contract shape', () => {
    const model: ProviderModelInfo = normalizeModelList(['gpt-4o'], 'OpenAI')[0]
    expect(model).toMatchObject({
      id: 'gpt-4o',
      providerName: 'OpenAI',
      supportsVariants: false,
      supportsReasoning: true,
      supportsVision: true,
      supportsTools: true,
      supportedParameters: []
    })
    expect(model.reasoningEfforts).toEqual(expect.arrayContaining(['medium', 'high']))
    expect(model.defaultReasoningEffort).toBeUndefined()
  })
})
