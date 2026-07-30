import { describe, expect, it } from 'vitest'
import {
  PROVIDER_PRESETS,
  inferModelCapabilities,
  pickDefaultModel,
  reasoningEffortsForModel
} from '../../src/shared/providerCatalog'

describe('provider catalog', () => {
  it('contains the built-in and custom providers', () => {
    expect(PROVIDER_PRESETS.map((provider) => provider.id)).toEqual(
      expect.arrayContaining([
        'openai',
        'deepseek',
        'kimi',
        'ollama-cloud',
        'ollama-local',
        'glm',
        'openrouter',
        'qwen',
        'siliconflow',
        'together',
        'groq',
        'mistral',
        'custom'
      ])
    )
  })

  it('maps provider-specific reasoning levels', () => {
    expect(reasoningEffortsForModel('openai', 'gpt-5.6-terra')).toEqual(
      expect.arrayContaining(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    )
    expect(reasoningEffortsForModel('deepseek', 'deepseek-v4-pro')).toEqual([
      'none',
      'high',
      'max'
    ])
    expect(reasoningEffortsForModel('kimi', 'kimi-k2.7-code')).toEqual(['high'])
    expect(reasoningEffortsForModel('kimi', 'kimi-k2.6')).toEqual(['none', 'high'])
    expect(reasoningEffortsForModel('glm', 'glm-5.2')).toContain('max')
    expect(reasoningEffortsForModel('groq', 'openai/gpt-oss-20b')).toEqual([
      'low',
      'medium',
      'high'
    ])
  })

  it('combines endpoint metadata with model inference', () => {
    expect(
      inferModelCapabilities('kimi', 'kimi-k2.6', {
        supportsReasoning: true,
        supportsVision: true,
        supportedParameters: ['tools', 'thinking']
      })
    ).toMatchObject({
      supportsReasoning: true,
      supportsVision: true,
      supportsTools: true,
      supportedParameters: ['thinking', 'tools']
    })
  })

  it('treats provider aliases as reasoning models', () => {
    expect(inferModelCapabilities('custom', 'xopkimik26')).toMatchObject({
      supportsReasoning: true,
      reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    })
  })

  it('selects a recommended or usable chat model', () => {
    const openai = PROVIDER_PRESETS.find((provider) => provider.id === 'openai')!
    expect(pickDefaultModel(openai, ['text-embedding-3-small', 'gpt-5.6-terra'])).toBe(
      'gpt-5.6-terra'
    )
    expect(pickDefaultModel(openai, ['text-embedding-3-small', 'gpt-5.4-mini'])).toBe(
      'gpt-5.4-mini'
    )
  })
})
