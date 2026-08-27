import { describe, expect, it, vi } from 'vitest'
import { createSupabaseSyncClient } from '../../src/main/services/supabaseSync'

function response(value: unknown, status = 200): Response {
  return new Response(value === null ? '' : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('Supabase sync client', () => {
  it('calls authenticated RPCs and validates push and pull payloads', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response({ status: 'applied', version: 1, sequence: 4 }))
      .mockResolvedValueOnce(response([{
        entity_type: 'category',
        entity_id: 'category-1',
        version: 1,
        sequence: 4,
        deleted: false,
        payload: { name: 'Reading', sortOrder: 0 },
        updated_at: '2026-08-26T00:00:00Z'
      }]))
      .mockResolvedValueOnce(response(null))
    const client = createSupabaseSyncClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      fetch
    })

    await client.registerLibrary('access', 'library-1', 'Library')
    await client.registerDevice('access', 'device-1', 'Mac')
    await expect(client.push('access', {
      libraryId: 'library-1',
      deviceId: 'device-1',
      operationId: 'operation-1',
      entityType: 'category',
      entityId: 'category-1',
      baseVersion: 0,
      deleted: false,
      payload: { name: 'Reading', sortOrder: 0 }
    })).resolves.toEqual({ status: 'applied', version: 1, sequence: 4 })
    await expect(client.pull('access', 'library-1', 0)).resolves.toEqual([{
      entityType: 'category',
      entityId: 'category-1',
      version: 1,
      sequence: 4,
      deleted: false,
      payload: { name: 'Reading', sortOrder: 0 },
      updatedAt: '2026-08-26T00:00:00Z'
    }])
    await client.saveCursor('access', 'library-1', 'device-1', 4)

    expect(fetch).toHaveBeenCalledTimes(5)
    const [url, init] = fetch.mock.calls[2] as [string, RequestInit]
    expect(url).toBe('https://project.supabase.co/rest/v1/rpc/refora_sync_push')
    expect(init.headers).toMatchObject({
      apikey: 'sb_publishable_test',
      Authorization: 'Bearer access'
    })
    expect(JSON.parse(init.body as string)).toMatchObject({
      p_library_id: 'library-1',
      p_entity_type: 'category',
      p_base_version: 0
    })
  })

  it('maps remote errors to a serializable main-process error', async () => {
    const client = createSupabaseSyncClient({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      fetch: vi.fn().mockResolvedValue(response({ message: 'quota exceeded' }, 400))
    })

    await expect(client.pull('access', 'library-1', 0)).rejects.toMatchObject({
      code: 'sync_remote_failed',
      message: 'quota exceeded'
    })
  })
})
