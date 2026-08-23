import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServerLifecycle } from '../../src/main/sidecar/lifecycle'
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
    return true
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
  const port = 8321
  const token = 'secret-token-123'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockReadFile.mockResolvedValue(JSON.stringify({ port, token }))
    mockFetchHealth.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeDeps(overrides: Partial<Parameters<typeof createServerLifecycle>[0]> = {}) {
    const spawn = makeSpawn((child) => announce(child, port))
    return {
      pythonPath: '/usr/bin/python3',
      serverModule: 'refora_server.server.run',
      stateDir: '/tmp/refora-server',
      userDataDir: '/tmp/refora-user-data',
      dbPath: '/tmp/refora-server.sqlite',
      libraryFolder: '/tmp/refora-library',
      spawnChild: spawn,
      readFile: mockReadFile,
      fetchHealth: mockFetchHealth,
      ...overrides
    }
  }

  it('parses the JSON token state emitted by the server', async () => {
    const lifecycle = createServerLifecycle(makeDeps())
    const connection = await lifecycle.start()

    expect(connection.port).toBe(port)
    expect(connection.baseUrl).toBe(`http://127.0.0.1:${port}`)
    expect(connection.token).toBe(token)
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining('server.token')
    )
  })

  it('launches a packaged executable without Python module arguments', async () => {
    const spawn = makeSpawn((child) => announce(child, port))
    const lifecycle = createServerLifecycle(
      makeDeps({
        pythonPath: undefined,
        serverModule: undefined,
        executablePath: '/Applications/Refora.app/Contents/Resources/python-server/refora-server',
        spawnChild: spawn
      })
    )

    await lifecycle.start()

    expect(spawn).toHaveBeenCalledWith(
      '/Applications/Refora.app/Contents/Resources/python-server/refora-server',
      expect.not.arrayContaining(['-m', 'refora_server.server.run']),
      expect.objectContaining({ cwd: '/tmp/refora-server' })
    )
  })

  it('passes the stable user data directory separately from server state', async () => {
    const deps = makeDeps()
    const lifecycle = createServerLifecycle(deps)

    await lifecycle.start()

    expect(deps.spawnChild).toHaveBeenCalledWith(
      '/usr/bin/python3',
      expect.arrayContaining([
        '--state-dir',
        '/tmp/refora-server',
        '--user-data-dir',
        '/tmp/refora-user-data'
      ]),
      expect.any(Object)
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

  it('waits for the server health endpoint before resolving start', async () => {
    mockFetchHealth.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const lifecycle = createServerLifecycle(makeDeps())
    const started = lifecycle.start()
    let resolved = false
    void started.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    await expect(started).resolves.toMatchObject({ port })
    expect(mockFetchHealth).toHaveBeenCalledTimes(2)
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

  it.each([
    ['malformed JSON', '{'],
    ['a non-object value', 'null'],
    ['a missing port', JSON.stringify({ token })],
    ['an invalid port', JSON.stringify({ port: 0, token })],
    ['a missing token', JSON.stringify({ port })],
    ['an empty token', JSON.stringify({ port, token: '  ' })]
  ])('rejects %s in the token state file', async (_description, contents) => {
    mockReadFile.mockResolvedValue(contents)
    await expect(createServerLifecycle(makeDeps()).start()).rejects.toThrow(/token file/)
  })

  it('rejects when the token state port differs from stdout', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ port: port + 1, token }))
    await expect(createServerLifecycle(makeDeps()).start()).rejects.toThrow(/does not match/)
  })

  it('preserves the startup error when both cleanup signals throw', async () => {
    const spawn = makeSpawn((child) => {
      announce(child, port)
      child.kill = vi.fn(() => {
        throw new Error('kill failed')
      })
    })
    mockReadFile.mockResolvedValue('{')
    const lifecycle = createServerLifecycle(makeDeps({ spawnChild: spawn }))

    await expect(lifecycle.start()).rejects.toThrow(/token file/)

    const child = spawn.mock.results[0].value as FakeChildProcess
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('waits for startup cleanup and escalates when SIGTERM is ignored', async () => {
    const spawn = makeSpawn((child) => {
      announce(child, port)
      child.kill = vi.fn((signal?: string) => {
        if (signal === 'SIGKILL') child.emit('close', null, 'SIGKILL')
        return true
      })
    })
    mockReadFile.mockResolvedValue('{')
    const lifecycle = createServerLifecycle(makeDeps({ spawnChild: spawn }))
    const started = lifecycle.start()
    const rejection = expect(started).rejects.toThrow(/token file/)
    await vi.advanceTimersByTimeAsync(0)
    const child = spawn.mock.results[0].value as FakeChildProcess

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
    await vi.advanceTimersByTimeAsync(5_000)

    await rejection
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('sends SIGTERM on stop', async () => {
    const spawn = makeSpawn((child) => announce(child, 9000))
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 9000, token }))
    const lifecycle = createServerLifecycle(makeDeps({ spawnChild: spawn }))
    await lifecycle.start()
    const child = spawn.mock.results[0].value as FakeChildProcess
    await lifecycle.stop()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('spawns a detached process group and terminates the whole group on macOS', async () => {
    if (process.platform !== 'darwin') return
    let child: FakeChildProcess
    const spawn = vi.fn(() => {
      child = createFakeChild()
      queueMicrotask(() => announce(child, 9010))
      return child as unknown as ChildProcess
    })
    const signalProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      child.emit('close', 0, signal)
      return true
    })
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 9010, token }))
    const lifecycle = createServerLifecycle(makeDeps({
      spawnChild: spawn,
      signalProcessGroup
    }))

    await lifecycle.start()
    await lifecycle.stop()

    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/python3',
      expect.any(Array),
      expect.objectContaining({ detached: true })
    )
    expect(signalProcessGroup).toHaveBeenCalledWith(child.pid, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('cleans the detached process group after an unexpected sidecar exit', async () => {
    if (process.platform !== 'darwin') return
    let child: FakeChildProcess
    const spawn = vi.fn(() => {
      child = createFakeChild()
      queueMicrotask(() => announce(child, 9011))
      return child as unknown as ChildProcess
    })
    const signalProcessGroup = vi.fn(() => true)
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 9011, token }))
    const lifecycle = createServerLifecycle(makeDeps({
      spawnChild: spawn,
      signalProcessGroup
    }))
    await lifecycle.start()

    child.emit('close', 1, null)

    expect(signalProcessGroup).toHaveBeenCalledWith(child.pid, 'SIGKILL')
  })

  it('terminates the detached process group after a failed health check', async () => {
    if (process.platform !== 'darwin') return
    let child: FakeChildProcess
    const spawn = vi.fn(() => {
      child = createFakeChild()
      queueMicrotask(() => announce(child, 9012))
      return child as unknown as ChildProcess
    })
    const signalProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') child.emit('close', null, signal)
      return true
    })
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 9012, token }))
    mockFetchHealth.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const lifecycle = createServerLifecycle(makeDeps({
      spawnChild: spawn,
      signalProcessGroup,
      healthIntervalMs: 100,
      healthTimeoutMs: 50
    }))
    await lifecycle.start()

    await vi.advanceTimersByTimeAsync(100)

    expect(signalProcessGroup).toHaveBeenCalledWith(child.pid, 'SIGTERM')
    expect(signalProcessGroup).toHaveBeenCalledWith(child.pid, 'SIGKILL')
    await lifecycle.stop()
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
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 9001, token }))
    const lifecycle = createServerLifecycle(makeDeps({ spawnChild: spawn }))
    await lifecycle.start()
    const child = spawn.mock.results[0].value as FakeChildProcess
    const stopPromise = lifecycle.stop()
    await vi.advanceTimersByTimeAsync(5500)
    await stopPromise

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('falls back immediately when SIGTERM throws during stop', async () => {
    const spawn = makeSpawn((child) => {
      announce(child, 9002)
      child.kill = vi.fn((signal?: string) => {
        if (signal === 'SIGTERM') throw new Error('SIGTERM failed')
        child.emit('close', null, signal ?? 'SIGKILL')
        return true
      })
    })
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 9002, token }))
    const lifecycle = createServerLifecycle(makeDeps({ spawnChild: spawn }))
    await lifecycle.start()
    const child = spawn.mock.results[0].value as FakeChildProcess

    await expect(lifecycle.stop()).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('does not reject stop when both termination signals throw', async () => {
    const spawn = makeSpawn((child) => {
      announce(child, 9003)
      child.kill = vi.fn(() => {
        throw new Error('kill failed')
      })
    })
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 9003, token }))
    const lifecycle = createServerLifecycle(makeDeps({ spawnChild: spawn }))
    await lifecycle.start()
    const child = spawn.mock.results[0].value as FakeChildProcess

    await expect(lifecycle.stop()).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
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
    mockReadFile.mockImplementation(async () => JSON.stringify({ port: 7000 + spawnCount, token }))
    const first = await lifecycle.start()
    expect(first.port).toBe(7001)

    const firstChild = spawn.mock.results[0].value as FakeChildProcess
    firstChild.emit('close', 1, null)

    await vi.advanceTimersByTimeAsync(600)
    expect(spawnCount).toBe(2)

    const connection = await lifecycle.getServerBaseUrl()
    expect(connection.port).toBe(7002)
  })

  it('invalidates a crashed connection and coalesces reconnect-triggered startup', async () => {
    let spawnCount = 0
    const spawn = vi.fn((_cmd: string, _args: string[]) => {
      spawnCount += 1
      const child = createFakeChild()
      queueMicrotask(() => announce(child, 7100 + spawnCount))
      return child as unknown as ChildProcess
    })
    const lifecycle = createServerLifecycle(
      makeDeps({ spawnChild: spawn, maxRestarts: 3 })
    )
    mockReadFile.mockImplementation(async () =>
      JSON.stringify({ port: 7100 + spawnCount, token })
    )
    const first = await lifecycle.start()
    expect(first.port).toBe(7101)

    const firstChild = spawn.mock.results[0].value as FakeChildProcess
    firstChild.emit('close', 1, null)
    const replacement = await lifecycle.getServerBaseUrl()

    expect(replacement.port).toBe(7102)
    expect(spawnCount).toBe(2)
    await vi.advanceTimersByTimeAsync(600)
    expect(spawnCount).toBe(2)
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
    mockReadFile.mockImplementation(async () => JSON.stringify({ port: 6000 + spawnCount, token }))
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
    await expect(lifecycle.getServerBaseUrl()).rejects.toMatchObject({
      code: 'server_restart_exhausted'
    })
    expect(spawnCount).toBe(3)
  })

  it('restores the restart budget after a stable running window', async () => {
    let spawnCount = 0
    const spawn = vi.fn((_cmd: string, _args: string[]) => {
      spawnCount += 1
      const child = createFakeChild()
      queueMicrotask(() => announce(child, 6500 + spawnCount))
      return child as unknown as ChildProcess
    })
    const lifecycle = createServerLifecycle(
      makeDeps({ spawnChild: spawn, maxRestarts: 1, restartStabilityMs: 1_000 })
    )
    mockReadFile.mockImplementation(async () =>
      JSON.stringify({ port: 6500 + spawnCount, token })
    )
    await lifecycle.start()

    const firstChild = spawn.mock.results[0].value as FakeChildProcess
    firstChild.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(600)
    expect(spawnCount).toBe(2)

    await vi.advanceTimersByTimeAsync(1_000)
    const secondChild = spawn.mock.results[1].value as FakeChildProcess
    secondChild.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(600)

    expect(spawnCount).toBe(3)
  })

  it('runs periodic health checks', async () => {
    const spawn = makeSpawn((child) => announce(child, 5555))
    mockReadFile.mockResolvedValue(JSON.stringify({ port: 5555, token }))
    const lifecycle = createServerLifecycle(
      makeDeps({
        spawnChild: spawn,
        healthIntervalMs: 1000,
        healthTimeoutMs: 100
      })
    )
    await lifecycle.start()
    expect(mockFetchHealth).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(mockFetchHealth).toHaveBeenCalledTimes(2)
    expect(mockFetchHealth).toHaveBeenLastCalledWith('http://127.0.0.1:5555/health', 100)
  })

  it('escalates an unhealthy child and restarts after it exits', async () => {
    let spawnCount = 0
    const spawn = vi.fn((_cmd: string, _args: string[]) => {
      spawnCount += 1
      const child = createFakeChild()
      child.kill = vi.fn((signal?: string) => {
        if (signal === 'SIGKILL') child.emit('close', null, 'SIGKILL')
        return true
      })
      queueMicrotask(() => announce(child, 5600 + spawnCount))
      return child as unknown as ChildProcess
    })
    mockReadFile.mockImplementation(async () => JSON.stringify({ port: 5600 + spawnCount, token }))
    mockFetchHealth.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true)
    const lifecycle = createServerLifecycle(makeDeps({
      spawnChild: spawn,
      healthIntervalMs: 100,
      healthTimeoutMs: 50
    }))
    await lifecycle.start()
    const firstChild = spawn.mock.results[0].value as FakeChildProcess

    await vi.advanceTimersByTimeAsync(100)
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(firstChild.kill).not.toHaveBeenCalledWith('SIGKILL')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
    await vi.advanceTimersByTimeAsync(600)
    expect(spawnCount).toBe(2)
  })
})
