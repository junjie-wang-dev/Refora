import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServerLifecycle } from '../../src/main/services/serverLifecycle'
import type { ChildProcess } from 'node:child_process'

const { mockFetchHealth, mockReadFile } = vi.hoisted(() => ({
  mockFetchHealth: vi.fn(),
  mockReadFile: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: vi.fn() }
}))

vi.mock('../../src/main/services/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  }
}))

interface FakeChildProcess extends EventEmitter {
  pid: number
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  killed: boolean
}

function createFakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess
  child.pid = Math.floor(Math.random() * 100000) + 1
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = vi.fn((signal?: string) => {
    child.killed = true
    child.emit('close', 0, signal ?? 'SIGTERM')
  })
  return child
}

function announce(child: FakeChildProcess, port: number): void {
  child.stdout.write(`LISTENING ${port}\n`)
}

function makeSpawn(emitListening: (child: FakeChildProcess) => void) {
  return vi.fn((_cmd: string, _args: string[]) => {
    const child = createFakeChild()
    queueMicrotask(() => emitListening(child))
    return child as unknown as ChildProcess
  })
}

describe('serverLifecycle', () => {
  const token = 'secret-token-123'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockReadFile.mockResolvedValue(token)
    mockFetchHealth.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeDeps(overrides: Partial<Parameters<typeof createServerLifecycle>[0]> = {}) {
    const spawn = makeSpawn((child) => announce(child, 8321))
    return {
      pythonPath: '/usr/bin/python3',
      serverModule: 'refora_server.server.run',
      stateDir: '/tmp/refora-server',
      spawnChild: spawn,
      readFile: mockReadFile,
      fetchHealth: mockFetchHealth,
      ...overrides
    }
  }

  it('parses the listening port from stdout and reads the token', async () => {
    const lifecycle = createServerLifecycle(makeDeps())
    const connection = await lifecycle.start()

    expect(connection.port).toBe(8321)
    expect(connection.baseUrl).toBe('http://127.0.0.1:8321')
    expect(connection.token).toBe(token)
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining('server.token')
    )
  })

  it('returns cached connection without re-spawning on subsequent start calls', async () => {
    const deps = makeDeps()
    const lifecycle = createServerLifecycle(deps)
    await lifecycle.start()
    const second = await lifecycle.start()

    expect(second.baseUrl).toBe('http://127.0.0.1:8321')
    expect(deps.spawnChild).toHaveBeenCalledTimes(1)
  })

  it('getServerBaseUrl starts the server when not yet running', async () => {
    const lifecycle = createServerLifecycle(makeDeps())
    const connection = await lifecycle.getServerBaseUrl()

    expect(connection.port).toBe(8321)
    expect(connection.token).toBe(token)
  })

  it('rejects when stdout does not report a listening port in time', async () => {
    const spawn = makeSpawn(() => {
    })
    const lifecycle = createServerLifecycle(
      makeDeps({ spawnChild: spawn, startupTimeoutMs: 100 })
    )
    const promise = lifecycle.start()
    promise.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(150)
    await expect(promise).rejects.toThrow(/listening port/)
  })

  it('rejects when the token file is empty', async () => {
    mockReadFile.mockResolvedValue('   ')
    const lifecycle = createServerLifecycle(makeDeps())
    await expect(lifecycle.start()).rejects.toThrow(/empty/)
  })

  it('sends SIGTERM on stop', async () => {
    const spawn = makeSpawn((child) => announce(child, 9000))
    const lifecycle = createServerLifecycle(makeDeps({ spawnChild: spawn }))
    await lifecycle.start()
    const child = spawn.mock.results[0].value as FakeChildProcess
    await lifecycle.stop()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('falls back to SIGKILL after the grace period on stop', async () => {
    const spawn = makeSpawn((child) => {
      announce(child, 9001)
      child.kill = vi.fn((signal?: string) => {
        if (signal === 'SIGKILL') {
          child.emit('close', null, 'SIGKILL')
        }
      })
    })
    const lifecycle = createServerLifecycle(makeDeps({ spawnChild: spawn }))
    await lifecycle.start()
    const child = spawn.mock.results[0].value as FakeChildProcess
    const stopPromise = lifecycle.stop()
    await vi.advanceTimersByTimeAsync(5500)
    await stopPromise

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('restarts the server with exponential backoff after an unexpected crash', async () => {
    let spawnCount = 0
    const spawn = vi.fn((_cmd: string, _args: string[]) => {
      spawnCount += 1
      const child = createFakeChild()
      queueMicrotask(() => announce(child, 7000 + spawnCount))
      return child as unknown as ChildProcess
    })
    const lifecycle = createServerLifecycle(
      makeDeps({ spawnChild: spawn, maxRestarts: 3 })
    )
    const first = await lifecycle.start()
    expect(first.port).toBe(7001)

    const firstChild = spawn.mock.results[0].value as FakeChildProcess
    firstChild.emit('close', 1, null)

    await vi.advanceTimersByTimeAsync(600)
    expect(spawnCount).toBe(2)

    const connection = await lifecycle.getServerBaseUrl()
    expect(connection.port).toBe(7002)
  })

  it('stops restarting after reaching the max restart count', async () => {
    let spawnCount = 0
    const spawn = vi.fn((_cmd: string, _args: string[]) => {
      spawnCount += 1
      const child = createFakeChild()
      queueMicrotask(() => announce(child, 6000 + spawnCount))
      return child as unknown as ChildProcess
    })
    const lifecycle = createServerLifecycle(
      makeDeps({ spawnChild: spawn, maxRestarts: 2 })
    )
    await lifecycle.start()

    const firstChild = spawn.mock.results[0].value as FakeChildProcess
    firstChild.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(spawnCount).toBe(2)

    const secondChild = spawn.mock.results[1].value as FakeChildProcess
    secondChild.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(spawnCount).toBe(3)

    const thirdChild = spawn.mock.results[2].value as FakeChildProcess
    thirdChild.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(spawnCount).toBe(3)
  })

  it('runs periodic health checks', async () => {
    const spawn = makeSpawn((child) => announce(child, 5555))
    const lifecycle = createServerLifecycle(
      makeDeps({
        spawnChild: spawn,
        healthIntervalMs: 1000,
        healthTimeoutMs: 100
      })
    )
    await lifecycle.start()
    expect(mockFetchHealth).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(mockFetchHealth).toHaveBeenCalledWith('http://127.0.0.1:5555/health', 100)
  })
})
