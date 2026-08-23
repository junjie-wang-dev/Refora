import { create } from 'zustand'
import type { AgentProfile, AiProvider, ProviderModelInfo } from '../../shared/ipc-types'
import { api } from '../ipc'

function fallbackProfile(provider: AiProvider): AgentProfile {
  return {
    id: provider.id,
    name: provider.name,
    kind: 'api',
    apiProviderId: provider.id,
    cliRuntimeId: null,
    executablePath: null,
    model: provider.model,
    reasoningEffort: provider.reasoningEffort,
    nativeWebSearch: false,
    webSearchPolicy: 'auto',
    createdAt: provider.createdAt,
    updatedAt: provider.createdAt
  }
}

function agentOption(profile: AgentProfile, provider?: AiProvider): AiProvider {
  if (provider) {
    return {
      ...provider,
      id: profile.id,
      name: profile.name,
      model: profile.model || provider.model,
      baseModel: profile.model || provider.baseModel,
      reasoningEffort: profile.reasoningEffort
    }
  }
  const model = profile.model || 'default'
  return {
    id: profile.id,
    presetId: `${profile.cliRuntimeId ?? 'cli'}-cli`,
    name: profile.name,
    baseUrl: '',
    apiProtocol: 'openai-responses',
    reasoningControl: profile.reasoningEffort === 'none' ? 'none' : 'openai',
    reasoningEffort: profile.reasoningEffort,
    model,
    models: null,
    baseModel: model,
    variant: '',
    variantFormat: 'none',
    hasKey: true,
    temperature: null,
    maxTokens: null,
    createdAt: profile.createdAt
  }
}

function chatCatalog(apiProviders: AiProvider[], profiles: AgentProfile[]) {
  const chatProfiles = profiles.length > 0 ? profiles : apiProviders.map(fallbackProfile)
  const providersById = new Map(apiProviders.map((provider) => [provider.id, provider]))
  const agents = chatProfiles.flatMap((profile) => {
    if (profile.kind === 'cli') return [agentOption(profile)]
    const provider = profile.apiProviderId
      ? providersById.get(profile.apiProviderId)
      : undefined
    return provider ? [agentOption(profile, provider)] : []
  })
  return { chatProfiles, agents }
}

interface AgentCatalogState {
  apiProviders: AiProvider[]
  profiles: AgentProfile[]
  chatProfiles: AgentProfile[]
  agents: AiProvider[]
  modelsByAgentId: Record<string, ProviderModelInfo[]>
  revision: number
  loading: boolean
  loadingModels: boolean
  refresh: () => Promise<void>
  refreshModels: () => Promise<void>
  removeProvider: (providerId: string) => void
  removeProfile: (profileId: string) => void
  reset: () => void
}

let catalogGeneration = 0
let modelsGeneration = 0

export const useAgentCatalogStore = create<AgentCatalogState>((set, get) => ({
  apiProviders: [],
  profiles: [],
  chatProfiles: [],
  agents: [],
  modelsByAgentId: {},
  revision: 0,
  loading: false,
  loadingModels: false,

  refresh: async () => {
    const generation = ++catalogGeneration
    set({ loading: true })
    try {
      const [profiles, apiProviders] = await Promise.all([
        api.agentProfiles.list(),
        api.aiProviders.list()
      ])
      if (generation !== catalogGeneration) return
      const { chatProfiles, agents } = chatCatalog(apiProviders, profiles)
      set({
        apiProviders,
        profiles,
        chatProfiles,
        agents,
        modelsByAgentId: {},
        loading: false,
        loadingModels: false,
        revision: get().revision + 1
      })
      void get().refreshModels()
    } catch (error) {
      if (generation === catalogGeneration) set({ loading: false })
      throw error
    }
  },

  refreshModels: async () => {
    const generation = ++modelsGeneration
    const catalogVersion = catalogGeneration
    const { chatProfiles, apiProviders } = get()
    if (chatProfiles.length === 0) {
      set({ modelsByAgentId: {}, loadingModels: false })
      return
    }
    set({ loadingModels: true })
    const providersById = new Map(apiProviders.map((provider) => [provider.id, provider]))
    const entries = await Promise.all(chatProfiles.map(async (profile) => {
      try {
        if (profile.kind === 'cli') {
          const result = await api.agentProfiles.listModels(profile.id)
          return [profile.id, result.ok ? result.models : []] as const
        }
        const providerId = profile.apiProviderId
        if (!providerId || !providersById.has(providerId)) return [profile.id, []] as const
        const result = await api.aiProviders.listModels({ providerId })
        return [profile.id, result.ok ? result.models : []] as const
      } catch {
        return [profile.id, []] as const
      }
    }))
    if (generation !== modelsGeneration || catalogVersion !== catalogGeneration) return
    set({ modelsByAgentId: Object.fromEntries(entries), loadingModels: false })
  },

  removeProvider: (providerId) => {
    const apiProviders = get().apiProviders.filter((provider) => provider.id !== providerId)
    const profiles = get().profiles.filter((profile) => profile.apiProviderId !== providerId)
    const { chatProfiles, agents } = chatCatalog(apiProviders, profiles)
    set({
      apiProviders,
      profiles,
      chatProfiles,
      agents,
      modelsByAgentId: {},
      revision: get().revision + 1
    })
  },

  removeProfile: (profileId) => {
    const apiProviders = get().apiProviders
    const profiles = get().profiles.filter((profile) => profile.id !== profileId)
    const { chatProfiles, agents } = chatCatalog(apiProviders, profiles)
    set({
      profiles,
      chatProfiles,
      agents,
      modelsByAgentId: {},
      revision: get().revision + 1
    })
  },

  reset: () => {
    catalogGeneration += 1
    modelsGeneration += 1
    set({
      apiProviders: [],
      profiles: [],
      chatProfiles: [],
      agents: [],
      modelsByAgentId: {},
      loading: false,
      loadingModels: false,
      revision: get().revision + 1
    })
  }
}))
