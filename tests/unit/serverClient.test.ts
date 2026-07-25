import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServerClient } from '../../src/main/services/serverClient'
import type { ServerLifecycle, ServerConnection } from '../../src/main/services/serverLifecycle'
import type { NativeRpc, NativeRpcInfo } from '../../src/main/services/nativeRpc'
import type { Result } from '../../shared/ipc-types'

vi.mock('../../src/main/services/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  }
}))

const TOKEN = 'server-secret-token'
const NATIVE_TOKEN = 'native-secret-token'
const PORT = 9876
const NATIVE_PORT = 9877

function makeConnection(): ServerConnection {
  return { baseUrl: `http://127.0.0.1:${PORT}`, token: TOKEN, port: PORT }
}

function makeNativeInfo(): NativeRpcInfo {
  return { port: NATIVE_PORT, baseUrl: `http://127.0.0.1:${NATIVE_PORT}`, token: NATIVE_TOKEN }
}

function makeLifecycle(conn: ServerConnection = makeConnection()): ServerLifecycle {
  return {
    start: vi.fn().mockResolvedValue(conn),
    getServerBaseUrl: vi.fn().mockResolvedValue(conn),
    stop: vi.fn().mockResolvedValue(undefined)
  }
}

function makeNativeRpc(info: NativeRpcInfo = makeNativeInfo()): NativeRpc {
  return {
    start: vi.fn().mockResolvedValue(info),
    stop: vi.fn().mockResolvedValue(undefined)
  }
}

function makeResponse<T>(data: T, status = 200): Response {
  const body: Result<T> = { ok: true, data }
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body)
  } as unknown as Response
}

function makeErrorResponse(code: string, message: string, status = 400): Response {
  const body: Result<never> = { ok: false, error: { code, message } }
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue(body)
  } as unknown as Response
}

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function makeFetchSpy(responder: (req: CapturedRequest) => Response): {
  fetch: typeof fetch
  calls: CapturedRequest[]
} {
  const calls: CapturedRequest[] = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers as Record<string, string>
      for (const [k, v] of Object.entries(h)) headers[k] = v
    }
    const req: CapturedRequest = {
      url: urlStr,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? String(init.body) : undefined
    }
    calls.push(req)
    return responder(req)
  }) as unknown as typeof fetch
  return { fetch: fetchFn, calls }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  static CONNECTING = 0
  static CLOSING = 2

  url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  private listeners = new Map<string, Set<(event: { data?: unknown }) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: (event: { data?: unknown }) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(cb)
  }

  removeEventListener(type: string, cb: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(cb)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  emit(type: string, event: { data?: unknown }): void {
    this.listeners.get(type)?.forEach((cb) => cb(event))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }

  error(): void {
    this.emit('error', { type: 'error' })
  }

  message(data: unknown): void {
    this.emit('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
}

describe('serverClient', () => {
  let lifecycle: ServerLifecycle
  let nativeRpc: NativeRpc

  beforeEach(() => {
    vi.clearAllMocks()
    FakeWebSocket.instances = []
    lifecycle = makeLifecycle()
    nativeRpc = makeNativeRpc()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function openWs(client: ReturnType<typeof createServerClient>): Promise<FakeWebSocket> {
    const connectPromise = client.ws.connect()
    const ws = await waitForInstance()
    ws.open()
    await connectPromise
    return ws
  }

  async function waitForInstance(): Promise<FakeWebSocket> {
    for (let i = 0; i < 100; i++) {
      const instance = FakeWebSocket.instances[0]
      if (instance) return instance
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    throw new Error('WebSocket instance was never created')
  }

  describe('http - request mechanics', () => {
    it('sends X-Refora-Token header and parses ok envelope into data', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ count: 3 }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      const result = await client.http.documentsCount()
      expect(result).toEqual({ count: 3 })
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/documents/count`)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].headers['X-Refora-Token']).toBe(TOKEN)
    })

    it('sends JSON body with Content-Type for POST', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ ack: true }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.documentsBulkDelete(['a', 'b'])
      expect(calls[0].method).toBe('POST')
      expect(calls[0].headers['Content-Type']).toBe('application/json')
      expect(calls[0].body).toBe(JSON.stringify({ ids: ['a', 'b'] }))
    })

    it('builds query string for list filters', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse([]))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.documentsList({ q: 'neural', starred: true, limit: 10 })
      expect(calls[0].url).toContain('/documents?')
      expect(calls[0].url).toContain('q=neural')
      expect(calls[0].url).toContain('starred=true')
      expect(calls[0].url).toContain('limit=10')
    })

    it('throws IpcError-shaped error on ok:false envelope', async () => {
      const { fetch } = makeFetchSpy(() => makeErrorResponse('not_found', 'no such doc', 404))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await expect(client.http.documentsGet('missing')).rejects.toMatchObject({
        code: 'not_found',
        message: 'no such doc'
      })
    })

    it('throws network_error when fetch rejects', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetchFn })
      await expect(client.http.documentsList()).rejects.toMatchObject({
        code: 'network_error',
        message: 'ECONNREFUSED'
      })
    })

    it('throws timeout error when fetch aborts', async () => {
      const fetchFn = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }) as unknown as typeof fetch
      const client = createServerClient(lifecycle, nativeRpc, {
        fetchImpl: fetchFn,
        requestTimeoutMs: 50
      })
      await expect(client.http.documentsList()).rejects.toMatchObject({ code: 'timeout' })
    })

    it('throws bad_response when body is not JSON', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new Error('Unexpected token'))
      }) as unknown as typeof fetch
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetchFn })
      await expect(client.http.documentsList()).rejects.toMatchObject({ code: 'bad_response' })
    })
  })

  describe('http - endpoint coverage', () => {
    it('routes documents endpoints to correct paths', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ ack: true }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.documentsSetStarred('d1', true)
      await client.http.documentsDelete('d2')
      await client.http.documentsRefreshMetadata('d3')
      await client.http.documentsOpenPdf('d4')
      expect(calls[0].url).toContain('/documents/d1/starred')
      expect(calls[0].method).toBe('POST')
      expect(calls[1].url).toContain('/documents/d2')
      expect(calls[1].method).toBe('DELETE')
      expect(calls[2].url).toContain('/documents/d3/refresh-metadata')
      expect(calls[3].url).toContain('/documents/d4/open-pdf')
    })

    it('routes import endpoints', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ imported: 1 }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.importIdentifier({ identifier: '10.1000/xyz' })
      await client.http.importZotero({ paths: ['/z'] })
      expect(calls[0].url).toContain('/import/identifier')
      expect(calls[1].url).toContain('/import/zotero')
    })

    it('routes ai chat endpoints', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ runId: 'r1' }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.aiChatSend({
        runId: 'r1',
        threadId: 't1',
        workspaceId: null,
        checkpointPath: '/cp',
        checkpointBefore: null,
        provider: {
          model: 'm',
          baseUrl: 'http://x',
          apiKey: 'k',
          useResponsesApi: false,
          modelKwargs: {},
          temperature: null,
          maxTokens: null
        },
        systemPrompt: 'p',
        enabledToolNames: [],
        sandboxRoot: null,
        memories: {},
        includeResearchMemory: false,
        recursionLimit: 25
      })
      await client.http.aiChatCancel({ runId: 'r1' })
      await client.http.aiChatThreads({ workspaceId: 'w1' })
      expect(calls[0].url).toContain('/ai/chat/send')
      expect(calls[1].url).toContain('/ai/chat/cancel')
      expect(calls[2].url).toContain('/ai/chat/threads')
      expect(calls[2].url).toContain('workspaceId=w1')
    })

    it('routes workspace and ocr endpoints', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ ack: true }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.workspacesOpenSandbox('w1')
      await client.http.ocrStart({ documentId: 'd1', profile: 'balanced' })
      await client.http.exportBibtexString(['a', 'b'])
      expect(calls[0].url).toContain('/workspaces/w1/open-sandbox')
      expect(calls[1].url).toContain('/ocr/start')
      expect(calls[2].url).toContain('/export/bibtex-string')
      expect(calls[2].url).toContain('documentIds=a%2Cb')
    })
  })

  describe('ws - connection and events', () => {
    it('connects to ws url with token query param', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      expect(ws.url).toBe(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`)
      expect(client.ws.isConnected()).toBe(true)
    })

    it('dispatches server events to subscribed listeners', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)

      const tokenCb = vi.fn()
      const doneCb = vi.fn()
      client.ws.on('ai.chat.token', tokenCb)
      client.ws.on('ai.chat.done', doneCb)

      ws.message({ event: 'ai.chat.token', data: { runId: 'r1', threadId: 't1', delta: 'hi' } })
      ws.message({ event: 'ai.chat.done', data: { runId: 'r1', threadId: 't1' } })

      expect(tokenCb).toHaveBeenCalledWith({ runId: 'r1', threadId: 't1', delta: 'hi' })
      expect(doneCb).toHaveBeenCalledWith({ runId: 'r1', threadId: 't1' })
    })

    it('off removes a listener', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)

      const cb = vi.fn()
      client.ws.on('document.updated', cb)
      client.ws.off('document.updated', cb)
      ws.message({ event: 'document.updated', data: { documentId: 'd1' } })
      expect(cb).not.toHaveBeenCalled()
    })

    it('subscribe sends the subscribe command', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      client.ws.subscribe(['ai.chat.token', 'ocr.progress'])
      expect(ws.sent).toHaveLength(1)
      expect(JSON.parse(ws.sent[0])).toEqual({ event: 'subscribe', data: { topics: ['ai.chat.token', 'ocr.progress'] } })
    })

    it('ping sends the ping command', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      client.ws.ping()
      expect(JSON.parse(ws.sent[0])).toEqual({ event: 'ping' })
    })

    it('disconnect closes the socket', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      const closeSpy = vi.spyOn(ws, 'close')
      client.ws.disconnect()
      expect(closeSpy).toHaveBeenCalled()
      expect(client.ws.isConnected()).toBe(false)
    })

    it('ignores malformed message payloads', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      expect(() => ws.message('not-json')).not.toThrow()
    })
  })

  describe('connector callbacks', () => {
    async function connectWithClient(nativeResponder: (url: string) => Response): Promise<{
      client: ReturnType<typeof createServerClient>
      ws: FakeWebSocket
      nativeCalls: CapturedRequest[]
    }> {
      const nativeCalls: CapturedRequest[] = []
      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        const headers: Record<string, string> = {}
        if (init?.headers) {
          const h = init.headers as Record<string, string>
          for (const [k, v] of Object.entries(h)) headers[k] = v
        }
        const req: CapturedRequest = {
          url: urlStr,
          method: init?.method ?? 'GET',
          headers,
          body: init?.body ? String(init.body) : undefined
        }
        nativeCalls.push(req)
        return nativeResponder(urlStr)
      }) as unknown as typeof fetch
      const client = createServerClient(lifecycle, nativeRpc, {
        fetchImpl: fetchFn,
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      return { client, ws, nativeCalls }
    }

    it('forwards connector.trash-item to nativeRpc and replies connector.result', async () => {
      const { ws, nativeCalls } = await connectWithClient(() => makeResponse({ trashed: true }))

      ws.message({
        event: 'connector.trash-item',
        data: { requestId: 'req1', path: '/some/file.pdf' }
      })
      await vi.waitFor(() => {
        expect(ws.sent.some((s) => s.includes('connector.result'))).toBe(true)
      })

      expect(nativeCalls).toHaveLength(1)
      expect(nativeCalls[0].url).toBe(`http://127.0.0.1:${NATIVE_PORT}/native/trash-item`)
      expect(nativeCalls[0].headers['x-refora-token']).toBe(NATIVE_TOKEN)
      expect(JSON.parse(nativeCalls[0].body as string)).toEqual({ path: '/some/file.pdf' })

      const reply = JSON.parse(ws.sent[ws.sent.length - 1])
      expect(reply.event).toBe('connector.result')
      expect(reply.data).toEqual({ requestId: 'req1', ok: true, data: { trashed: true } })
    })

    it('replies connector.error when nativeRpc returns ok:false', async () => {
      const { ws, nativeCalls } = await connectWithClient(() => makeErrorResponse('trash_failed', 'busy', 400))

      ws.message({
        event: 'connector.trash-item',
        data: { requestId: 'req2', path: '/x.pdf' }
      })
      await vi.waitFor(() => {
        expect(ws.sent.some((s) => s.includes('connector.error'))).toBe(true)
      })

      expect(nativeCalls).toHaveLength(1)
      const reply = JSON.parse(ws.sent[ws.sent.length - 1])
      expect(reply.event).toBe('connector.error')
      expect(reply.data).toEqual({
        requestId: 'req2',
        ok: false,
        error: { code: 'trash_failed', message: 'busy' }
      })
    })

    it('forwards connector.get-api-key to native get-api-key route', async () => {
      const { ws, nativeCalls } = await connectWithClient(() => makeResponse({ apiKey: 'sk-123' }))

      ws.message({
        event: 'connector.get-api-key',
        data: { requestId: 'req3', providerId: 'openai' }
      })
      await vi.waitFor(() => {
        expect(nativeCalls).toHaveLength(1)
      })

      expect(nativeCalls[0].url).toBe(`http://127.0.0.1:${NATIVE_PORT}/native/get-api-key`)
      expect(JSON.parse(nativeCalls[0].body as string)).toEqual({ providerId: 'openai' })
      await vi.waitFor(() => {
        const reply = JSON.parse(ws.sent[ws.sent.length - 1])
        expect(reply.event).toBe('connector.result')
        expect(reply.data.data).toEqual({ apiKey: 'sk-123' })
      })
    })

    it('replies connector.error when nativeRpc start fails', async () => {
      const failingNative: NativeRpc = {
        start: vi.fn().mockRejectedValue(new Error('not started')),
        stop: vi.fn().mockResolvedValue(undefined)
      }
      const fetchFn = vi.fn() as unknown as typeof fetch
      const client = createServerClient(lifecycle, failingNative, {
        fetchImpl: fetchFn,
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)

      ws.message({
        event: 'connector.clipboard-write',
        data: { requestId: 'req4', text: 'hello' }
      })
      await vi.waitFor(() => {
        expect(ws.sent.some((s) => s.includes('connector.error'))).toBe(true)
      })
      const reply = JSON.parse(ws.sent[ws.sent.length - 1])
      expect(reply.event).toBe('connector.error')
      expect(reply.data.error.code).toBe('native_unavailable')
    })

    it('replies connector.error on native fetch network failure', async () => {
      const failingFetch = vi.fn().mockRejectedValue(new Error('connection refused')) as unknown as typeof fetch
      const client = createServerClient(lifecycle, nativeRpc, {
        fetchImpl: failingFetch,
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)

      ws.message({
        event: 'connector.open-path',
        data: { requestId: 'req5', path: '/p' }
      })
      await vi.waitFor(() => {
        expect(ws.sent.some((s) => s.includes('connector.error'))).toBe(true)
      })
      const reply = JSON.parse(ws.sent[ws.sent.length - 1])
      expect(reply.data.error.code).toBe('native_error')
    })
  })

  describe('ws reconnect', () => {
    it('attempts to reconnect after close', async () => {
      vi.useFakeTimers()
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        wsReconnectMaxAttempts: 3
      })
      const connectPromise = client.ws.connect()
      await vi.advanceTimersByTimeAsync(0)
      const ws1 = FakeWebSocket.instances[0]
      ws1.open()
      await connectPromise

      ws1.close()
      expect(FakeWebSocket.instances).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(600)
      expect(FakeWebSocket.instances).toHaveLength(2)
      FakeWebSocket.instances[1].open()
      expect(client.ws.isConnected()).toBe(true)
    })

    it('does not reconnect after manual disconnect', async () => {
      vi.useFakeTimers()
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        wsReconnectMaxAttempts: 3
      })
      const connectPromise = client.ws.connect()
      await vi.advanceTimersByTimeAsync(0)
      const ws1 = FakeWebSocket.instances[0]
      ws1.open()
      await connectPromise

      client.ws.disconnect()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(FakeWebSocket.instances).toHaveLength(1)
    })
  })
})
