import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerLifecycle, type ServerLifecycle } from '../../src/main/sidecar/lifecycle'
import { createServerClient } from '../../src/main/sidecar/client'
import {
  SERVER_PROTOCOL_DIGEST,
  SERVER_PROTOCOL_VERSION
} from '../../src/shared/server-contract'

vi.mock('electron', () => ({ net: { fetch: globalThis.fetch } }))
vi.mock('../../src/main/services/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const serverRoot = join(projectRoot, 'backend')
const execFile = promisify(execFileCallback)

async function pythonPath(): Promise<string> {
  const candidates = [process.env.REFORA_SERVER_PYTHON, join(serverRoot, '.venv/bin/python'), 'python3'].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    try {
      await execFile(candidate, ['-c', 'import fastapi, uvicorn, websockets'])
      return candidate
    } catch {
      continue
    }
  }
  throw new Error('No Python interpreter has the server dependencies installed')
}

async function eventually<T>(operation: () => Promise<T>): Promise<T> {
  let error: unknown
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { return await operation() } catch (caught) { error = caught; await new Promise((resolve) => setTimeout(resolve, 100)) }
  }
  throw error instanceof Error ? error : new Error('Server did not become ready')
}

describe('managed Python server lifecycle', () => {
  let root: string | null = null
  let lifecycle: ServerLifecycle | null = null
  let client: ReturnType<typeof createServerClient> | null = null

  afterEach(async () => {
    client?.ws.disconnect()
    await lifecycle?.stop()
    if (root) await rm(root, { recursive: true, force: true })
    root = null
    lifecycle = null
    client = null
  })

  it('starts a subprocess with authenticated JSON state and WebSocket events', async () => {
    const python = await pythonPath()
    if (python.includes('/')) await access(python)
    root = await mkdtemp(join(tmpdir(), 'refora-server-e2e-'))
    const stateDir = join(root, 'state')
    const libraryFolder = join(root, 'library')
    await Promise.all([mkdir(stateDir), mkdir(libraryFolder)])
    lifecycle = createServerLifecycle({ pythonPath: python, serverModule: 'refora_server.server.run', stateDir, userDataDir: root, dbPath: join(root, 'refora.db'), libraryFolder, environment: { ...process.env, PYTHONPATH: serverRoot, PYTHONNOUSERSITE: '1' }, healthIntervalMs: 60_000 })
    const connection = await lifecycle.start()
    const state = JSON.parse(await readFile(join(stateDir, 'server.token'), 'utf8')) as { port: number; token: string }
    expect(connection).toMatchObject(state)
    expect((await stat(join(stateDir, 'server.token'))).mode & 0o077).toBe(0)
    expect((await eventually(() => fetch(`${connection.baseUrl}/health`))).ok).toBe(true)
    expect((await fetch(`${connection.baseUrl}/ready`)).status).toBe(401)
    client = createServerClient(lifecycle, { invoke: vi.fn(), addManagedRoot: () => false }, { fetchImpl: fetch, WebSocketCtor: WebSocket, requestTimeoutMs: 2_000, wsReconnectMaxAttempts: 0 })
    await expect(eventually(() => client!.http.systemReady())).resolves.toEqual({
      status: 'ready',
      protocolVersion: SERVER_PROTOCOL_VERSION,
      protocolDigest: SERVER_PROTOCOL_DIGEST
    })
    const subscribed = new Promise<unknown>((resolve) => client!.ws.on('subscribed', resolve))
    await client.ws.connect()
    client.ws.subscribe(['ocr.progress'])
    await expect(subscribed).resolves.toEqual({ topics: ['ocr.progress'] })
  })
})
