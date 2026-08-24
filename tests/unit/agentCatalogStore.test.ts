import { describe, expect, it } from 'vitest'
import type { AgentProfile, AiProvider } from '../../src/shared/ipc-types'
import {
  deriveChatCatalog,
  useAgentCatalogStore
} from '../../src/renderer/store/agentCatalogStore'

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'provider-1',
    presetId: 'openai',
    name: 'Provider',
    baseUrl: 'https://example.com',
    apiProtocol: 'openai-responses',
    reasoningControl: 'openai',
    reasoningEffort: 'medium',
    model: 'model-1',
    models: null,
    baseModel: 'model-1',
    variant: '',
    variantFormat: 'none',
    hasKey: true,
    temperature: null,
    maxTokens: null,
    createdAt: 1,
    ...overrides
  }
}

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'profile-1',
    name: 'Profile',
    kind: 'api',
    apiProviderId: 'provider-1',
    cliRuntimeId: null,
    executablePath: null,
    model: 'profile-model',
    reasoningEffort: 'high',
    nativeWebSearch: false,
    webSearchPolicy: 'auto',
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

describe('agent catalog derivation', () => {
  it('derives fallback profiles without persisting duplicate catalog arrays', () => {
    const provider = makeProvider()
    const catalog = deriveChatCatalog([provider], [])
    expect(catalog.chatProfiles).toHaveLength(1)
    expect(catalog.agents[0]).toMatchObject({ id: provider.id, model: provider.model })
    expect(useAgentCatalogStore.getState()).not.toHaveProperty('chatProfiles')
    expect(useAgentCatalogStore.getState()).not.toHaveProperty('agents')
  })

  it('projects profile overrides and ignores dangling provider references', () => {
    const profile = makeProfile()
    const dangling = makeProfile({ id: 'dangling', apiProviderId: 'missing' })
    const catalog = deriveChatCatalog([makeProvider()], [profile, dangling])
    expect(catalog.chatProfiles).toEqual([profile, dangling])
    expect(catalog.agents).toEqual([
      expect.objectContaining({
        id: profile.id,
        name: profile.name,
        model: profile.model,
        reasoningEffort: profile.reasoningEffort
      })
    ])
  })
})
