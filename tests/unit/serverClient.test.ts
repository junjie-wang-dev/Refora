import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServerClient } from '../../src/main/sidecar/client'
import type { ServerLifecycle, ServerConnection } from '../../src/main/sidecar/lifecycle'
import type { NativeRpc } from '../../src/main/sidecar/nativeRpc'
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
const PORT = 9876

function makeConnection(): ServerConnection {
  return { baseUrl: `http://127.0.0.1:${PORT}`, token: TOKEN, port: PORT }
}

function makeLifecycle(conn: ServerConnection = makeConnection()): ServerLifecycle {
  return {
    start: vi.fn().mockResolvedValue(conn),
    getServerBaseUrl: vi.fn().mockResolvedValue(conn),
    stop: vi.fn().mockResolvedValue(undefined)
  }
}

function makeNativeRpc(): NativeRpc {
  return {
    invoke: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    addManagedRoot: vi.fn().mockReturnValue(true)
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
  static deferClose = false
  static OPEN = 1
  static CLOSED = 3
  static CONNECTING = 0
  static CLOSING = 2

  url: string
  protocols?: string[]
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  private listeners = new Map<string, Set<(event: { data?: unknown }) => void>>()

  constructor(url: string, protocols?: string[]) {
    this.url = url
    this.protocols = protocols
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
    const finish = () => {
      this.readyState = FakeWebSocket.CLOSED
      this.emit('close', {})
    }
    if (FakeWebSocket.deferClose) {
      this.readyState = FakeWebSocket.CLOSING
      queueMicrotask(finish)
    } else {
      finish()
    }
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
    FakeWebSocket.deferClose = false
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

    it('builds query string for paged document search', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse([]))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })

      await client.http.documentsSearch('neural systems', { limit: 100, offset: 200 })

      expect(calls[0].url).toContain('/documents/search?')
      expect(calls[0].url).toContain('q=neural+systems')
      expect(calls[0].url).toContain('limit=100')
      expect(calls[0].url).toContain('offset=200')
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

    it('keeps the timeout active while reading the response body', async () => {
      vi.useFakeTimers()
      let signal: AbortSignal | null = null
      const fetchFn = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? null
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise(() => undefined)
        })
      }) as unknown as typeof fetch
      const client = createServerClient(lifecycle, nativeRpc, {
        fetchImpl: fetchFn,
        requestTimeoutMs: 50
      })
      const request = client.http.documentsList()
      const rejection = expect(request).rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(51)

      await rejection
      expect(signal?.aborted).toBe(true)
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

    it('throws bad_response when the server omits the Result envelope', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ documents: [] })
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

    it('encodes every dynamic URL path segment', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ ack: true }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      const documentId = 'existing-id?alias#part/论文'
      const resultKey = 'result?#/一'

      await client.http.documentsDelete(documentId)
      await client.http.ocrMarkdown(documentId, resultKey)

      expect(new URL(calls[0].url).pathname).toBe(
        `/documents/${encodeURIComponent(documentId)}`
      )
      expect(new URL(calls[1].url).pathname).toBe(
        `/ocr/documents/${encodeURIComponent(documentId)}/results/${encodeURIComponent(resultKey)}/markdown`
      )
    })

    it('routes import endpoints', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ imported: 1 }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.importIdentifier({ identifier: '10.1000/xyz' })
      await client.http.importZotero({ paths: ['/z'] })
      expect(calls[0].url).toContain('/import/identifier')
      expect(calls[1].url).toContain('/import/zotero')
    })

    it('disables the native PDF open action for the built-in reader', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ id: 'd4' }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })

      await client.http.documentsOpenPdf('d4', false)

      expect(calls[0].url).toContain('/documents/d4/open-pdf?external=false')
      expect(calls[0].method).toBe('POST')
    })

    it('routes PDF annotation reads and updates', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse([]))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })

      await client.http.documentsPdfAnnotations('d4')
      await client.http.documentsSetPdfAnnotations('d4', [])

      expect(calls[0].url).toContain('/documents/d4/pdf-annotations')
      expect(calls[0].method).toBe('GET')
      expect(calls[1].url).toContain('/documents/d4/pdf-annotations')
      expect(calls[1].method).toBe('PUT')
    })

    it('routes ai chat endpoints', async () => {
      const cancelResult = { ack: true, cancelRequested: true, terminated: false }
      const { fetch, calls } = makeFetchSpy((request) =>
        request.url.includes('/ai/chat/cancel')
          ? makeResponse(cancelResult)
          : makeResponse({ runId: 'r1', threadId: 't1' })
      )
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.aiChatSend({
        runId: 'r1',
        threadId: 't1',
        workspaceId: null,
        text: 'Summarize the evidence',
        providerId: 'p1',
        model: 'm'
      })
      await expect(client.http.aiChatCancel({ runId: 'r1' })).resolves.toEqual(cancelResult)
      await client.http.aiChatThreads({ workspaceId: 'w1' })
      await client.http.aiUsageStats()
      await client.http.aiChatRun('r1')
      await client.http.aiChatPendingInterrupt('r1')
      await client.http.aiChatMemories(null)
      expect(calls[0].url).toContain('/ai/chat/send')
      expect(JSON.parse(calls[0].body as string)).toEqual({
        runId: 'r1',
        threadId: 't1',
        workspaceId: null,
        text: 'Summarize the evidence',
        providerId: 'p1',
        model: 'm'
      })
      expect(calls[1].url).toContain('/ai/chat/cancel')
      expect(calls[2].url).toContain('/ai/chat/threads')
      expect(calls[2].url).toContain('workspaceId=w1')
      expect(calls[3].url).toContain('/ai/usage')
      expect(calls[4].url).toContain('/ai/chat/runs/r1')
      expect(calls[5].url).toContain('/ai/chat/runs/r1/pending-interrupt')
      expect(calls[6].url).toContain('/ai/memories')
    })

    it('unwraps the persistent run snapshot envelope', async () => {
      const snapshot = {
        id: 'r1',
        threadId: 't1',
        providerId: 'p1',
        modelId: 'm1',
        status: 'completed' as const,
        checkpointBefore: null,
        checkpointAfter: 'checkpoint-1',
        replacesRunId: null,
        userMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        startedAt: 1,
        endedAt: 2,
        error: null
      }
      const { fetch, calls } = makeFetchSpy(() => makeResponse(snapshot))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })

      await expect(client.http.aiChatRun('r1')).resolves.toEqual(snapshot)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        url: `http://127.0.0.1:${PORT}/ai/chat/runs/r1`,
        method: 'GET'
      })
    })

    it('routes workspace and ocr endpoints', async () => {
      const { fetch, calls } = makeFetchSpy(() => makeResponse({ ack: true }))
      const client = createServerClient(lifecycle, nativeRpc, { fetchImpl: fetch })
      await client.http.workspacesOpenSandbox('w1')
      await client.http.ocrStart({ documentId: 'd1', profile: 'balanced' })
      await client.http.workspaceItemMove('w1', { itemId: 'i1', x: 10, y: 20, zIndex: 3 })
      await client.http.ocrState('d1')
      await client.http.ocrMarkdown('d1', 'result-1')
      await client.http.exportBibtexString(['a', 'b'])
      expect(calls[0].url).toContain('/workspaces/w1/open-sandbox')
      expect(calls[1].url).toContain('/ocr/start')
      expect(calls[2].url).toContain('/workspaces/w1/items/move')
      expect(JSON.parse(calls[2].body as string)).toEqual({
        itemId: 'i1',
        x: 10,
        y: 20,
        zIndex: 3
      })
      expect(calls[3].url).toContain('/ocr/state?documentId=d1')
      expect(calls[4].url).toContain('/ocr/documents/d1/results/result-1/markdown')
      expect(calls[5].url).toContain('/export/bibtex-string')
      expect(calls[5].url).toContain('documentIds=a%2Cb')
    })
  })

  describe('ws - connection and events', () => {
    it('connects to ws url with token subprotocol', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      expect(ws.url).toBe(`ws://127.0.0.1:${PORT}/ws`)
      expect(ws.protocols).toEqual([`refora-token.${TOKEN}`])
      expect(client.ws.isConnected()).toBe(true)
    })

    it('times out a stalled handshake and allows a fresh connection', async () => {
      vi.useFakeTimers()
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        wsHandshakeTimeoutMs: 100
      })
      const stalled = client.ws.connect()
      const rejection = expect(stalled).rejects.toMatchObject({ code: 'ws_timeout' })

      await vi.advanceTimersByTimeAsync(101)
      await rejection
      expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED)

      const reconnected = client.ws.connect()
      await vi.advanceTimersByTimeAsync(0)
      expect(FakeWebSocket.instances).toHaveLength(2)
      FakeWebSocket.instances[1].open()
      await reconnected
      expect(client.ws.isConnected()).toBe(true)
    })

    it('forwards every AI chat event payload unchanged', async () => {
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)

      const cases = [
        ['ai.chat.token', { runId: 'r1', threadId: 't1', token: 'hi', stepId: 's1' }],
        ['ai.chat.reasoning', { runId: 'r1', threadId: 't1', token: 'think', stepId: 's2' }],
        ['ai.chat.done', { runId: 'r1', threadId: 't1', finalText: 'answer' }],
        ['ai.chat.error', {
          runId: 'r1',
          threadId: 't1',
          message: 'failed',
          partialText: 'partial answer'
        }],
        ['ai.chat.trace', {
          runId: 'r1',
          threadId: 't1',
          step: { id: 's3', kind: 'tool', status: 'done' }
        }],
        ['ai.chat.interrupted', {
          runId: 'r1',
          threadId: 't1',
          interrupt: { id: 'i1', status: 'pending' }
        }],
        ['ai.chat.run-status', { runId: 'r1', threadId: 't1', status: 'failed' }]
      ] as const

      for (const [event, payload] of cases) {
        const listener = vi.fn()
        client.ws.on(event, listener)
        ws.message({ event, data: payload })
        expect(listener).toHaveBeenCalledOnce()
        expect(listener).toHaveBeenCalledWith(payload)
      }
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
    async function connectWithClient(
      nativeResponder: (route: string, body: unknown, signal?: AbortSignal) => Result<unknown> | Promise<Result<unknown>>
    ): Promise<{
      client: ReturnType<typeof createServerClient>
      ws: FakeWebSocket
      nativeCalls: Array<{ route: string; body: unknown; signal?: AbortSignal }>
    }> {
      const nativeCalls: Array<{ route: string; body: unknown; signal?: AbortSignal }> = []
      nativeRpc.invoke = vi.fn((route, body, signal) => {
        nativeCalls.push({ route, body, signal })
        return Promise.resolve(nativeResponder(route, body, signal))
      })
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      return { client, ws, nativeCalls }
    }

    it('forwards connector.trash-item to nativeRpc and replies connector.result', async () => {
      const { ws, nativeCalls } = await connectWithClient(() => ({ ok: true, data: { trashed: true } }))

      ws.message({
        event: 'connector.trash-item',
        data: { requestId: 'req1', path: '/some/file.pdf' }
      })
      await vi.waitFor(() => {
        expect(ws.sent.some((s) => s.includes('connector.result'))).toBe(true)
      })

      expect(nativeCalls).toHaveLength(1)
      expect(nativeCalls[0]).toMatchObject({ route: '/native/trash-item', body: { path: '/some/file.pdf' } })

      const reply = JSON.parse(ws.sent[ws.sent.length - 1])
      expect(reply.event).toBe('connector.result')
      expect(reply.data).toEqual({ requestId: 'req1', ok: true, data: { trashed: true } })
    })

    it('replies connector.error when nativeRpc returns ok:false', async () => {
      const { ws, nativeCalls } = await connectWithClient(() => ({
        ok: false,
        error: { code: 'trash_failed', message: 'busy' }
      }))

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

    it('forwards connector.decrypt-api-key to native decrypt-api-key route', async () => {
      const { ws, nativeCalls } = await connectWithClient(() => ({ ok: true, data: { apiKey: 'search-secret' } }))

      ws.message({
        event: 'connector.decrypt-api-key',
        data: { requestId: 'req-decrypt', apiKeyEnc: 'ZW5jcnlwdGVk' }
      })
      await vi.waitFor(() => {
        expect(nativeCalls).toHaveLength(1)
      })

      expect(nativeCalls[0]).toMatchObject({
        route: '/native/decrypt-api-key',
        body: { apiKeyEnc: 'ZW5jcnlwdGVk' }
      })
      await vi.waitFor(() => {
        const reply = JSON.parse(ws.sent[ws.sent.length - 1])
        expect(reply.event).toBe('connector.result')
        expect(reply.data.data).toEqual({ apiKey: 'search-secret' })
      })
    })

    it('replies connector.error when nativeRpc invoke fails', async () => {
      const failingNative: NativeRpc = {
        invoke: vi.fn().mockRejectedValue(new Error('not available')),
        addManagedRoot: vi.fn()
      }
      const client = createServerClient(lifecycle, failingNative, {
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
      expect(reply.data.error.code).toBe('native_error')
    })

    it('replies connector.error when a native invoke rejects', async () => {
      nativeRpc.invoke = vi.fn().mockRejectedValue(new Error('connection refused'))
      const client = createServerClient(lifecycle, nativeRpc, {
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

    it('aborts active native connector requests when the client disconnects', async () => {
      let requestSignal: AbortSignal | null = null
      nativeRpc.invoke = vi.fn((_route, _body, signal?: AbortSignal) =>
        new Promise<Result<unknown>>((_resolve) => {
          requestSignal = signal ?? null
        }))
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket
      })
      const ws = await openWs(client)
      ws.message({
        event: 'connector.dialog-open-directory',
        data: { requestId: 'req-cancel', title: 'Choose library' }
      })
      await vi.waitFor(() => expect(requestSignal).not.toBeNull())

      client.ws.disconnect()

      expect(requestSignal?.aborted).toBe(true)
      await vi.waitFor(() => expect(nativeRpc.invoke).toHaveBeenCalledOnce())
    })
  })

  describe('ws reconnect', () => {
    it('continues retrying when the first reconnect attempt fails', async () => {
      vi.useFakeTimers()
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        wsReconnectMaxAttempts: 3
      })
      const initialConnect = client.ws.connect()
      await vi.advanceTimersByTimeAsync(0)
      FakeWebSocket.instances[0].open()
      await initialConnect

      FakeWebSocket.instances[0].close()
      await vi.advanceTimersByTimeAsync(600)
      expect(FakeWebSocket.instances).toHaveLength(2)
      FakeWebSocket.instances[1].error()
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(1_100)
      expect(FakeWebSocket.instances).toHaveLength(3)
      FakeWebSocket.instances[2].open()
      expect(client.ws.isConnected()).toBe(true)
    })

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
      const topics = [
        'ai.chat.token',
        'ai.chat.reasoning',
        'ai.chat.done',
        'ai.chat.error',
        'ai.chat.trace',
        'ai.chat.interrupted',
        'ai.chat.run-status'
      ]
      client.ws.subscribe(topics)

      ws1.close()
      expect(FakeWebSocket.instances).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(600)
      expect(FakeWebSocket.instances).toHaveLength(2)
      FakeWebSocket.instances[1].open()
      expect(client.ws.isConnected()).toBe(true)
      expect(JSON.parse(FakeWebSocket.instances[1].sent[0])).toEqual({
        event: 'subscribe',
        data: { topics }
      })
    })

    it('uses the latest sidecar connection after a restart', async () => {
      vi.useFakeTimers()
      const restartedConnection: ServerConnection = {
        baseUrl: 'http://127.0.0.1:9988',
        token: 'restarted-token',
        port: 9988
      }
      const getServerBaseUrl = vi.fn()
        .mockResolvedValueOnce(makeConnection())
        .mockResolvedValue(restartedConnection)
      const restartingLifecycle: ServerLifecycle = {
        start: vi.fn().mockResolvedValue(makeConnection()),
        getServerBaseUrl,
        stop: vi.fn().mockResolvedValue(undefined)
      }
      const client = createServerClient(restartingLifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        wsReconnectMaxAttempts: 3
      })
      const connectPromise = client.ws.connect()
      await vi.advanceTimersByTimeAsync(0)
      FakeWebSocket.instances[0].open()
      await connectPromise

      FakeWebSocket.instances[0].close()
      await vi.advanceTimersByTimeAsync(600)
      expect(FakeWebSocket.instances).toHaveLength(2)
      expect(FakeWebSocket.instances[1].url).toBe('ws://127.0.0.1:9988/ws')
      expect(FakeWebSocket.instances[1].protocols).toEqual(['refora-token.restarted-token'])
      FakeWebSocket.instances[1].open()
      expect(client.ws.isConnected()).toBe(true)
      expect(getServerBaseUrl).toHaveBeenCalledTimes(2)
    })

    it('does not reconnect after manual disconnect', async () => {
      vi.useFakeTimers()
      FakeWebSocket.deferClose = true
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
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(FakeWebSocket.instances).toHaveLength(1)
    })

    it('cancels a pending reconnect after manual disconnect', async () => {
      vi.useFakeTimers()
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        wsReconnectMaxAttempts: 3
      })
      const connectPromise = client.ws.connect()
      await vi.advanceTimersByTimeAsync(0)
      FakeWebSocket.instances[0].open()
      await connectPromise

      FakeWebSocket.instances[0].close()
      client.ws.disconnect()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(FakeWebSocket.instances).toHaveLength(1)
    })

    it('preserves an immediate reconnect when the canceled connection closes later', async () => {
      vi.useFakeTimers()
      FakeWebSocket.deferClose = true
      const client = createServerClient(lifecycle, nativeRpc, {
        WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
        wsReconnectMaxAttempts: 3
      })
      const firstConnect = client.ws.connect()
      const firstRejection = expect(firstConnect).rejects.toMatchObject({ code: 'ws_closed' })
      await vi.advanceTimersByTimeAsync(0)

      client.ws.disconnect()
      const secondConnect = client.ws.connect()
      await vi.advanceTimersByTimeAsync(0)

      expect(FakeWebSocket.instances).toHaveLength(2)
      const duplicateConnect = client.ws.connect()
      await vi.advanceTimersByTimeAsync(0)
      expect(FakeWebSocket.instances).toHaveLength(2)

      FakeWebSocket.instances[1].open()
      await Promise.all([firstRejection, secondConnect, duplicateConnect])
      expect(client.ws.isConnected()).toBe(true)
    })
  })
})
