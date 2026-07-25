import { safeStorage, net } from 'electron'
import type { Repositories } from '../db/repositories'
import type {
  AiApiProtocol,
  AiProvider,
  AiProviderInput,
  AiProviderPatch,
  AiReasoningControl,
  AiReasoningEffort,
  ListModelsRequest,
  ListModelsResult,
  ModelVariantFormat,
  ProviderModelInfo
} from '../../shared/ipc-types'
import {
  composeModelId,
  parseModelId,
  toProviderModelInfo
} from '../../shared/modelVariant'
import { getProviderPreset, providerRequiresApiKey } from '../../shared/providerCatalog'
import { RepoError } from '../db/repositories/errors'
import { logger } from './logger'

const TEST_TIMEOUT_MS = 8_000

export function encryptKey(apiKey: string | undefined): Buffer | null {
  if (!apiKey) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new RepoError(
      'encryption_unavailable',
      'OS keychain (safeStorage) is not available. API keys cannot be securely stored.'
    )
  }
  return safeStorage.encryptString(apiKey)
}

export function decryptKey(enc: Buffer | null, allowEmpty = false): string {
  if (!enc) {
    if (allowEmpty) return ''
    throw new RepoError('no_api_key', 'Provider has no API key')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new RepoError(
      'encryption_unavailable',
      'OS keychain (safeStorage) is not available. Cannot decrypt API key.'
    )
  }
  return safeStorage.decryptString(enc)
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RepoError('invalid_input', 'Base URL must be a valid HTTP or HTTPS URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RepoError('invalid_input', 'Base URL must use HTTP or HTTPS')
  }
  return raw
}

function asApiProtocol(value: unknown, fallback: AiApiProtocol): AiApiProtocol {
  return value === 'openai-responses' || value === 'openai-compatible' ? value : fallback
}

function asReasoningControl(
  value: unknown,
  fallback: AiReasoningControl
): AiReasoningControl {
  return value === 'openai' ||
    value === 'thinking' ||
    value === 'enable-thinking' ||
    value === 'none'
    ? value
    : fallback
}

function asReasoningEffort(
  value: unknown,
  fallback: AiReasoningEffort
): AiReasoningEffort {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : fallback
}

function asFormat(v: unknown): ModelVariantFormat {
  if (v === 'colon' || v === 'none' || v === 'dash') return v
  return 'dash'
}

function resolveModelFields(input: {
  model?: string
  baseModel?: string
  variant?: string
  variantFormat?: ModelVariantFormat
}): {
  model: string
  baseModel: string
  variant: string
  variantFormat: ModelVariantFormat
} {
  const variantFormat = asFormat(input.variantFormat)
  if (input.baseModel != null && input.baseModel.trim()) {
    const baseModel = input.baseModel.trim()
    const variant = (input.variant ?? '').trim()
    const model =
      input.model?.trim() || composeModelId(baseModel, variant, variantFormat)
    return { model, baseModel, variant, variantFormat }
  }
  const model = (input.model ?? '').trim()
  const parsed = parseModelId(model)
  const baseModel = parsed.baseModel || model
  const variant = input.variant != null ? input.variant.trim() : parsed.variant
  const composed = composeModelId(baseModel, variant, variantFormat)
  return {
    model: composed || model,
    baseModel,
    variant,
    variantFormat
  }
}

function normalizeModels(models: string[] | null | undefined): string[] | null {
  if (!models) return null
  const normalized = models
    .map((model) => model.trim())
    .filter((model, index, all) => model.length > 0 && all.indexOf(model) === index)
  return normalized.length > 0 ? normalized : null
}

function mapRaw(row: {
  id: string
  presetId: string
  name: string
  baseUrl: string
  apiProtocol: AiApiProtocol
  reasoningControl: AiReasoningControl
  reasoningEffort: AiReasoningEffort
  model: string
  models: string[] | null
  baseModel: string
  variant: string
  variantFormat: ModelVariantFormat
  apiKeyEnc: Buffer | null
  temperature: number | null
  maxTokens: number | null
  createdAt: number
}): AiProvider {
  return {
    id: row.id,
    presetId: row.presetId,
    name: row.name,
    baseUrl: row.baseUrl,
    apiProtocol: row.apiProtocol,
    reasoningControl: row.reasoningControl,
    reasoningEffort: row.reasoningEffort,
    model: row.model,
    models: row.models,
    baseModel: row.baseModel,
    variant: row.variant,
    variantFormat: row.variantFormat,
    hasKey: row.apiKeyEnc != null,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    createdAt: row.createdAt
  }
}

interface EndpointModel {
  id?: string
  supported_parameters?: string[]
  supports_reasoning?: boolean
  supports_image_in?: boolean
  capabilities?: {
    vision?: boolean
    function_calling?: boolean
  }
  architecture?: {
    input_modalities?: string[]
  }
}

async function fetchModelsFromEndpoint(
  baseUrl: string,
  apiKey: string
): Promise<{ ok: true; models: EndpointModel[] } | { ok: false; error: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const base = baseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const response = await net.fetch(`${base}/models`, {
      signal: controller.signal,
      headers
    })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` }
    }
    const body = (await response.json()) as { data?: EndpointModel[] }
    const models = (body.data ?? []).filter((model) => typeof model.id === 'string')
    return { ok: true, models }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

export function createAiProvidersService(repos: Repositories) {
  function list(): AiProvider[] {
    return repos.aiProviders.list()
  }

  function create(input: AiProviderInput): AiProvider {
    const preset = getProviderPreset(input.presetId ?? 'custom')
    const fields = resolveModelFields(input)
    if (!input.name.trim() || !fields.model) {
      throw new RepoError('invalid_input', 'Provider name and model are required')
    }
    const apiKeyEnc = encryptKey(input.apiKey)
    return repos.aiProviders.create({
      presetId: preset.id,
      name: input.name.trim(),
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiProtocol: asApiProtocol(input.apiProtocol, preset.apiProtocol),
      reasoningControl: asReasoningControl(input.reasoningControl, preset.reasoningControl),
      reasoningEffort: asReasoningEffort(
        input.reasoningEffort,
        preset.defaultReasoningEffort
      ),
      model: fields.model,
      models: normalizeModels(input.models),
      baseModel: fields.baseModel,
      variant: fields.variant,
      variantFormat: fields.variantFormat,
      apiKeyEnc,
      temperature: input.temperature ?? null,
      maxTokens: input.maxTokens ?? null
    })
  }

  function update(id: string, patch: AiProviderPatch): AiProvider {
    const existing = repos.aiProviders.getRaw(id)
    if (!existing) throw new RepoError('not_found', `provider not found: ${id}`)
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new RepoError('invalid_input', 'Provider name is required')
    }

    const fields =
      patch.model !== undefined ||
      patch.baseModel !== undefined ||
      patch.variant !== undefined ||
      patch.variantFormat !== undefined
        ? resolveModelFields({
            model: patch.model ?? existing.model,
            baseModel: patch.baseModel ?? existing.baseModel,
            variant: patch.variant ?? existing.variant,
            variantFormat: patch.variantFormat ?? existing.variantFormat
          })
        : null
    if (fields && !fields.model) {
      throw new RepoError('invalid_input', 'Provider model is required')
    }

    const updateInput: {
      presetId?: string
      name?: string
      baseUrl?: string
      apiProtocol?: AiApiProtocol
      reasoningControl?: AiReasoningControl
      reasoningEffort?: AiReasoningEffort
      model?: string
      models?: string[] | null
      baseModel?: string
      variant?: string
      variantFormat?: ModelVariantFormat
      apiKeyEnc?: Buffer | null
      temperature?: number | null
      maxTokens?: number | null
    } = {
      presetId:
        patch.presetId !== undefined ? getProviderPreset(patch.presetId).id : undefined,
      name: patch.name?.trim(),
      baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : undefined,
      apiProtocol:
        patch.apiProtocol !== undefined
          ? asApiProtocol(patch.apiProtocol, existing.apiProtocol)
          : undefined,
      reasoningControl:
        patch.reasoningControl !== undefined
          ? asReasoningControl(patch.reasoningControl, existing.reasoningControl)
          : undefined,
      reasoningEffort:
        patch.reasoningEffort !== undefined
          ? asReasoningEffort(patch.reasoningEffort, existing.reasoningEffort)
          : undefined
    }
    if (fields) {
      updateInput.model = fields.model
      updateInput.baseModel = fields.baseModel
      updateInput.variant = fields.variant
      updateInput.variantFormat = fields.variantFormat
    }
    if (patch.models !== undefined) {
      updateInput.models = normalizeModels(patch.models)
    }
    if (patch.apiKey !== undefined) {
      updateInput.apiKeyEnc = encryptKey(patch.apiKey)
    }
    if (patch.temperature !== undefined) {
      updateInput.temperature = patch.temperature
    }
    if (patch.maxTokens !== undefined) {
      updateInput.maxTokens = patch.maxTokens
    }
    return repos.aiProviders.update(id, updateInput)
  }

  function remove(id: string): void {
    repos.aiProviders.delete(id)
  }

  function getProvider(id: string): AiProvider {
    const raw = repos.aiProviders.getRaw(id)
    if (!raw) throw new RepoError('not_found', `provider not found: ${id}`)
    return mapRaw(raw)
  }

  function getDecryptedKey(id: string): string {
    const raw = repos.aiProviders.getRaw(id)
    if (!raw) throw new RepoError('not_found', `provider not found: ${id}`)
    return decryptKey(raw.apiKeyEnc, !providerRequiresApiKey(raw.presetId))
  }

  async function test(id: string): Promise<{ ok: boolean; models?: string[] }> {
    try {
      const raw = repos.aiProviders.getRaw(id)
      if (!raw) return { ok: false }
      const key = decryptKey(raw.apiKeyEnc, !providerRequiresApiKey(raw.presetId))
      const result = await fetchModelsFromEndpoint(raw.baseUrl, key)
      if (!result.ok) return { ok: false }
      return {
        ok: true,
        models: result.models
          .map((model) => model.id)
          .filter((id): id is string => typeof id === 'string')
      }
    } catch (e) {
      logger.warn(`aiProviders:test failed: ${e instanceof Error ? e.message : String(e)}`)
      return { ok: false }
    }
  }

  async function listModels(req: ListModelsRequest): Promise<ListModelsResult> {
    try {
      let baseUrl = (req.baseUrl ?? '').trim()
      let apiKey = (req.apiKey ?? '').trim()
      let providerName: string | undefined
      let presetId = req.presetId ?? 'custom'

      if (req.providerId) {
        const raw = repos.aiProviders.getRaw(req.providerId)
        if (!raw) {
          return { ok: false, models: [], error: 'Provider not found' }
        }
        providerName = raw.name
        presetId = raw.presetId
        if (!baseUrl) baseUrl = raw.baseUrl
        if (!apiKey) {
          try {
            apiKey = decryptKey(raw.apiKeyEnc, !providerRequiresApiKey(raw.presetId))
          } catch {
            return { ok: false, models: [], error: 'Provider has no API key' }
          }
        }
      }

      if (!baseUrl) {
        return { ok: false, models: [], error: 'Base URL is required' }
      }
      if (!apiKey && providerRequiresApiKey(presetId)) {
        return { ok: false, models: [], error: 'API key is required' }
      }

      const result = await fetchModelsFromEndpoint(normalizeBaseUrl(baseUrl), apiKey)
      if (!result.ok) {
        return { ok: false, models: [], error: result.error }
      }
      return {
        ok: true,
        models: result.models
          .map((model) => {
            const id = model.id?.trim()
            if (!id) return null
            const supportedParameters = Array.isArray(model.supported_parameters)
              ? model.supported_parameters.filter(
                  (parameter): parameter is string => typeof parameter === 'string'
                )
              : []
            return toProviderModelInfo(id, providerName, presetId, {
              supportedParameters,
              supportsReasoning: model.supports_reasoning,
              supportsVision:
                model.supports_image_in === true ||
                model.capabilities?.vision === true ||
                model.architecture?.input_modalities?.includes('image') === true,
              supportsTools: model.capabilities?.function_calling
            })
          })
          .filter((model): model is ProviderModelInfo => model != null)
          .filter(
            (model, index, models) => models.findIndex((item) => item.id === model.id) === index
          )
          .sort((a, b) => a.id.localeCompare(b.id))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.warn(`aiProviders:listModels failed: ${msg}`)
      return { ok: false, models: [], error: msg }
    }
  }

  return { list, create, update, remove, test, listModels, getProvider, getDecryptedKey }
}

export type AiProvidersService = ReturnType<typeof createAiProvidersService>
