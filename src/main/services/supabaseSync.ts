import { MainProcessError } from './errors'

export type SyncEntityType =
  | 'document_user_data'
  | 'category'
  | 'document_category'
  | 'workspace'
  | 'workspace_note'
  | 'workspace_layout'
  | 'workspace_connection'
  | 'pdf_annotation'
  | 'agent_memory'

export interface RemoteSyncEntity {
  entityType: SyncEntityType
  entityId: string
  version: number
  sequence: number
  deleted: boolean
  payload: Record<string, unknown>
  updatedAt: string
}

export interface SyncPushRequest {
  libraryId: string
  deviceId: string
  operationId: string
  entityType: SyncEntityType
  entityId: string
  baseVersion: number
  deleted: boolean
  payload: Record<string, unknown>
}

export type SyncPushResult =
  | { status: 'applied'; version: number; sequence: number }
  | { status: 'conflict'; version: number; sequence: number; deleted: boolean }

export interface SupabaseSyncClient {
  registerLibrary(accessToken: string, libraryId: string, name: string): Promise<void>
  registerDevice(accessToken: string, deviceId: string, name: string): Promise<void>
  push(accessToken: string, request: SyncPushRequest): Promise<SyncPushResult>
  pull(accessToken: string, libraryId: string, after: number, limit?: number): Promise<RemoteSyncEntity[]>
  saveCursor(accessToken: string, libraryId: string, deviceId: string, cursor: number): Promise<void>
}

interface SupabaseSyncClientDeps {
  url: string
  publishableKey: string
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  requestTimeoutMs?: number
}

function errorText(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const record = body as Record<string, unknown>
  for (const key of ['message', 'details', 'hint', 'code']) {
    if (typeof record[key] === 'string' && record[key]) return record[key].slice(0, 500)
  }
  return fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MainProcessError('sync_remote_invalid_response', `Supabase returned an invalid ${name}`)
  }
  return value
}

function entityType(value: unknown): SyncEntityType {
  const allowed = new Set<SyncEntityType>([
    'document_user_data',
    'category',
    'document_category',
    'workspace',
    'workspace_note',
    'workspace_layout',
    'workspace_connection',
    'pdf_annotation',
    'agent_memory'
  ])
  if (typeof value !== 'string' || !allowed.has(value as SyncEntityType)) {
    throw new MainProcessError('sync_remote_invalid_response', 'Supabase returned an invalid entity type')
  }
  return value as SyncEntityType
}

export function createSupabaseSyncClient({
  url,
  publishableKey,
  fetch,
  requestTimeoutMs = 20_000
}: SupabaseSyncClientDeps): SupabaseSyncClient {
  const baseUrl = url.replace(/\/+$/, '')

  async function rpc(accessToken: string, name: string, body: unknown): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            apikey: publishableKey,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })
      } catch (error) {
        if (controller.signal.aborted) {
          throw new MainProcessError('sync_request_timeout', 'Supabase did not respond in time')
        }
        throw new MainProcessError(
          'sync_network_error',
          error instanceof Error ? error.message : 'Unable to reach Supabase'
        )
      }
      const raw = await response.text()
      let parsed: unknown = null
      if (raw) {
        try {
          parsed = JSON.parse(raw) as unknown
        } catch {
          throw new MainProcessError('sync_remote_invalid_response', 'Supabase returned invalid JSON')
        }
      }
      if (!response.ok) {
        throw new MainProcessError(
          response.status === 401 ? 'sync_auth_failed' : 'sync_remote_failed',
          errorText(parsed, `Supabase sync failed with HTTP ${response.status}`)
        )
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async registerLibrary(accessToken, libraryId, name) {
      await rpc(accessToken, 'refora_sync_register_library', {
        p_library_id: libraryId,
        p_name: name
      })
    },
    async registerDevice(accessToken, deviceId, name) {
      await rpc(accessToken, 'refora_sync_register_device', {
        p_device_id: deviceId,
        p_name: name
      })
    },
    async push(accessToken, request) {
      const value = asRecord(await rpc(accessToken, 'refora_sync_push', {
        p_library_id: request.libraryId,
        p_device_id: request.deviceId,
        p_operation_id: request.operationId,
        p_entity_type: request.entityType,
        p_entity_id: request.entityId,
        p_base_version: request.baseVersion,
        p_deleted: request.deleted,
        p_payload: request.deleted ? {} : request.payload
      }))
      if (!value || (value.status !== 'applied' && value.status !== 'conflict')) {
        throw new MainProcessError('sync_remote_invalid_response', 'Supabase returned an invalid push result')
      }
      const version = integer(value.version, 'entity version')
      const sequence = integer(value.sequence, 'entity sequence')
      if (value.status === 'applied') return { status: 'applied', version, sequence }
      if (typeof value.deleted !== 'boolean') {
        throw new MainProcessError('sync_remote_invalid_response', 'Supabase returned an invalid conflict')
      }
      return { status: 'conflict', version, sequence, deleted: value.deleted }
    },
    async pull(accessToken, libraryId, after, limit = 500) {
      const value = await rpc(accessToken, 'refora_sync_pull', {
        p_library_id: libraryId,
        p_after: after,
        p_limit: limit
      })
      if (!Array.isArray(value)) {
        throw new MainProcessError('sync_remote_invalid_response', 'Supabase returned an invalid pull result')
      }
      return value.map((item) => {
        const record = asRecord(item)
        const payload = asRecord(record?.payload)
        if (
          !record
          || typeof record.entity_id !== 'string'
          || !record.entity_id
          || typeof record.deleted !== 'boolean'
          || !payload
          || typeof record.updated_at !== 'string'
        ) {
          throw new MainProcessError('sync_remote_invalid_response', 'Supabase returned an invalid entity')
        }
        return {
          entityType: entityType(record.entity_type),
          entityId: record.entity_id,
          version: integer(record.version, 'entity version'),
          sequence: integer(record.sequence, 'entity sequence'),
          deleted: record.deleted,
          payload,
          updatedAt: record.updated_at
        }
      })
    },
    async saveCursor(accessToken, libraryId, deviceId, cursor) {
      await rpc(accessToken, 'refora_sync_save_cursor', {
        p_library_id: libraryId,
        p_device_id: deviceId,
        p_cursor: cursor
      })
    }
  }
}
