import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { net } from 'electron'
import { logger } from '../services/logger'

const DEFAULT_MAX_RESTARTS = 5
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_HEALTH_INTERVAL_MS = 15_000
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000
const DEFAULT_RESTART_STABILITY_MS = 60_000
const BASE_BACKOFF_MS = 500
const TERMINATION_GRACE_MS = 5_000
const TERMINATION_SETTLE_MS = 1_000
const LISTENING_PREFIX = 'LISTENING '
const TOKEN_FILE = 'server.token'

export interface ServerConnection {
  baseUrl: string
  token: string
  port: number
}

export interface ServerLifecycleDeps {
  pythonPath?: string
  serverModule?: string
  executablePath?: string
  stateDir: string
  userDataDir: string
  dbPath: string
  libraryFolder: string
  language?: 'zh' | 'en'
  environment?: NodeJS.ProcessEnv
  maxRestarts?: number
  startupTimeoutMs?: number
  healthIntervalMs?: number
  healthTimeoutMs?: number
  restartStabilityMs?: number
  spawnChild?: typeof spawn
  readFile?: (path: string) => Promise<string>
  fetchHealth?: (url: string, timeoutMs: number) => Promise<boolean>
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => boolean
}

export interface ServerLifecycle {
  start(): Promise<ServerConnection>
  getServerBaseUrl(): Promise<ServerConnection>
  stop(): Promise<void>
}

interface SpawnResult {
  child: ChildProcess
  portPromise: Promise<number>
}

interface TokenFile {
  port: number
  token: string
}

function defaultFetchHealth(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return net
    .fetch(url, { signal: controller.signal })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer))
}

function parseTokenFile(contents: string, tokenPath: string): TokenFile {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new Error(`Server token file is not valid JSON: ${tokenPath}`)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Server token file has an invalid shape: ${tokenPath}`)
  }

  const { port, token } = value as Record<string, unknown>
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Server token file has an invalid port: ${tokenPath}`)
  }
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error(`Server token file has an empty token: ${tokenPath}`)
  }

  return { port, token }
}

export function createServerLifecycle(deps: ServerLifecycleDeps): ServerLifecycle {
  const maxRestarts = deps.maxRestarts ?? DEFAULT_MAX_RESTARTS
  const startupTimeoutMs = deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const healthIntervalMs = deps.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
  const healthTimeoutMs = deps.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const restartStabilityMs = deps.restartStabilityMs ?? DEFAULT_RESTART_STABILITY_MS
  const spawnChild = deps.spawnChild ?? spawn
  const readFile = deps.readFile ?? defaultReadFile
  const fetchHealth = deps.fetchHealth ?? defaultFetchHealth
  const useProcessGroup = process.platform === 'darwin' && (
    deps.spawnChild === undefined || deps.signalProcessGroup !== undefined
  )
  const signalProcessGroup = deps.signalProcessGroup ?? ((pid, signal) => {
    try {
      process.kill(-pid, signal)
      return true
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ESRCH') {
        return true
      }
      throw error
    }
  })

  let child: ChildProcess | null = null
  let connection: ServerConnection | null = null
  let startPromise: Promise<ServerConnection> | null = null
  let healthTimer: ReturnType<typeof setTimeout> | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let restartResetTimer: ReturnType<typeof setTimeout> | null = null
  let stopping = false
  let recovering = false
  let restartCount = 0
  let restartExhaustedError: Error | null = null
  const terminationPromises = new WeakMap<ChildProcess, Promise<void>>()

  function defaultReadFile(path: string): Promise<string> {
    return import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'))
  }

  function clearHealthTimer(): void {
    if (healthTimer) {
      clearTimeout(healthTimer)
      healthTimer = null
    }
  }

  function clearRestartResetTimer(): void {
    if (restartResetTimer) {
      clearTimeout(restartResetTimer)
      restartResetTimer = null
    }
  }

  function clearRestartTimer(): void {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  function scheduleRestartReset(spawned: ChildProcess): void {
    clearRestartResetTimer()
    restartResetTimer = setTimeout(() => {
      restartResetTimer = null
      if (!stopping && child === spawned && connection) restartCount = 0
    }, restartStabilityMs)
  }

  function spawnServer(): SpawnResult {
    const command = deps.executablePath ?? deps.pythonPath
    if (!command) throw new Error('Server executable is not configured')
    if (!deps.executablePath && !deps.serverModule) {
      throw new Error('Server Python module is not configured')
    }
    const args = [
      ...(deps.executablePath ? [] : ['-u', '-m', deps.serverModule as string]),
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--state-dir',
      deps.stateDir,
      '--user-data-dir',
      deps.userDataDir,
      '--db-path',
      deps.dbPath,
      '--library-folder',
      deps.libraryFolder,
      '--language',
      deps.language ?? 'en'
    ]
    const spawned = spawnChild(command, args, {
      cwd: deps.stateDir,
      env: deps.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup
    })

    let resolved = false
    const portPromise = new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: spawned.stdout, crlfDelay: Infinity })
      const cleanup = (): void => {
        clearTimeout(startupTimer)
        lines.close()
      }
      lines.on('line', (line) => {
        const trimmed = line.trim()
        if (trimmed.startsWith(LISTENING_PREFIX)) {
          const rawPort = trimmed.slice(LISTENING_PREFIX.length).trim()
          const port = Number(rawPort)
          if (Number.isInteger(port) && port > 0 && !resolved) {
            resolved = true
            cleanup()
            resolve(port)
          }
        }
      })
      const startupTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          cleanup()
          reject(new Error(`Server did not report a listening port within ${startupTimeoutMs}ms`))
        }
      }, startupTimeoutMs)
      spawned.once('error', (error) => {
        if (!resolved) {
          resolved = true
          cleanup()
          reject(error)
        }
      })
      spawned.once('close', (code, signal) => {
        if (!resolved) {
          resolved = true
          cleanup()
          reject(new Error(`Server exited before listening (code=${code ?? signal})`))
        }
      })
    })

    spawned.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message) logger.info(`serverLifecycle:stderr ${message.slice(-2000)}`)
    })

    return { child: spawned, portPromise }
  }

  async function buildConnection(listeningPort: number): Promise<ServerConnection> {
    const tokenPath = join(deps.stateDir, TOKEN_FILE)
    const tokenFile = parseTokenFile(await readFile(tokenPath), tokenPath)
    if (tokenFile.port !== listeningPort) {
      throw new Error(`Server token file port does not match listening port: ${tokenPath}`)
    }
    return {
      baseUrl: `http://127.0.0.1:${tokenFile.port}`,
      token: tokenFile.token,
      port: tokenFile.port
    }
  }

  async function waitUntilHealthy(candidate: ServerConnection): Promise<void> {
    const deadline = Date.now() + startupTimeoutMs
    while (!stopping) {
      if (await fetchHealth(`${candidate.baseUrl}/health`, healthTimeoutMs)) return
      if (Date.now() >= deadline) {
        throw new Error(`Server did not become healthy within ${startupTimeoutMs}ms`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Server startup was cancelled')
  }

  function exhaustRestarts(): void {
    restartExhaustedError = Object.assign(
      new Error(`Server crashed and exhausted ${maxRestarts} restart attempts`),
      { code: 'server_restart_exhausted' }
    )
    logger.error(`serverLifecycle:${restartExhaustedError.message}`)
    connection = null
    startPromise = null
  }

  function scheduleRestart(reason: string | number | null): void {
    if (stopping || restartTimer || connection) return
    if (restartCount >= maxRestarts) {
      exhaustRestarts()
      return
    }
    restartCount += 1
    const backoff = BASE_BACKOFF_MS * 2 ** (restartCount - 1)
    logger.warn(
      `serverLifecycle:unavailable (reason=${reason}), restarting in ${backoff}ms (attempt ${restartCount}/${maxRestarts})`
    )
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (stopping) return
      void start().catch((error) => {
        logger.error(`serverLifecycle:restart failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, backoff)
  }

  function handleUnexpectedExit(spawned: ChildProcess, reason: string | number | null): void {
    if (stopping || child !== spawned) return
    child = null
    connection = null
    recovering = true
    clearHealthTimer()
    clearRestartResetTimer()
    scheduleRestart(reason)
  }

  function attachCrashHandler(spawned: ChildProcess): void {
    spawned.once('close', (code, signal) => {
      if (!stopping && useProcessGroup) terminate(spawned, 'SIGKILL')
      handleUnexpectedExit(spawned, code ?? signal)
    })
  }

  function terminateAndWait(spawned: ChildProcess): Promise<void> {
    if (!spawned.pid) return Promise.resolve()
    const existing = terminationPromises.get(spawned)
    if (existing) return existing
    const operation = new Promise<void>((resolve) => {
      let settled = false
      let escalationTimer: ReturnType<typeof setTimeout> | null = null
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (settled) return
        settled = true
        if (escalationTimer) clearTimeout(escalationTimer)
        if (settleTimer) clearTimeout(settleTimer)
        spawned.removeListener('close', finish)
        if (useProcessGroup) terminate(spawned, 'SIGKILL')
        resolve()
      }
      const force = (): void => {
        escalationTimer = null
        if (!terminate(spawned, 'SIGKILL')) {
          finish()
          return
        }
        settleTimer = setTimeout(finish, TERMINATION_SETTLE_MS)
      }
      spawned.once('close', finish)
      if (terminate(spawned, 'SIGTERM')) {
        escalationTimer = setTimeout(force, TERMINATION_GRACE_MS)
      } else {
        force()
      }
    }).finally(() => {
      if (terminationPromises.get(spawned) === operation) terminationPromises.delete(spawned)
    })
    terminationPromises.set(spawned, operation)
    return operation
  }

  function scheduleHealthCheck(): void {
    clearHealthTimer()
    healthTimer = setInterval(() => {
      const checkedConnection = connection
      const checkedChild = child
      if (!checkedConnection || !checkedChild || stopping) return
      void fetchHealth(`${checkedConnection.baseUrl}/health`, healthTimeoutMs).then((ok) => {
        if (
          ok ||
          stopping ||
          connection !== checkedConnection ||
          child !== checkedChild
        ) return
        logger.warn('serverLifecycle:health check failed, restarting server')
        void terminateAndWait(checkedChild).then(() => {
          handleUnexpectedExit(checkedChild, 'unhealthy')
        })
      })
    }, healthIntervalMs)
  }

  async function doStart(): Promise<ServerConnection> {
    const { child: spawned, portPromise } = spawnServer()
    child = spawned
    let port: number
    try {
      port = await portPromise
      const candidate = await buildConnection(port)
      await waitUntilHealthy(candidate)
      if (stopping || child !== spawned) throw new Error('Server startup was cancelled')
      connection = candidate
    } catch (error) {
      await terminateAndWait(spawned)
      connection = null
      if (child === spawned) child = null
      throw error
    }
    attachCrashHandler(spawned)
    scheduleHealthCheck()
    scheduleRestartReset(spawned)
    clearRestartTimer()
    recovering = false
    return connection
  }

  function stoppedError(): Error {
    return Object.assign(
      new Error('Server lifecycle was stopped and cannot be started again'),
      { code: 'server_stopped' }
    )
  }

  function start(): Promise<ServerConnection> {
    if (stopping) return Promise.reject(stoppedError())
    if (connection) return Promise.resolve(connection)
    if (restartExhaustedError) return Promise.reject(restartExhaustedError)
    if (startPromise) return startPromise
    let recoveryFailure: string | null = null
    startPromise = doStart()
      .catch((error) => {
        if (recovering && !stopping) {
          recoveryFailure = error instanceof Error ? error.message : String(error)
        }
        throw error
      })
      .finally(() => {
        startPromise = null
        if (recoveryFailure !== null) scheduleRestart(recoveryFailure)
      })
    return startPromise
  }

  async function getServerBaseUrl(): Promise<ServerConnection> {
    if (stopping) throw stoppedError()
    if (connection) return connection
    return start()
  }

  function terminate(spawned: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!spawned.pid) return true
    if (useProcessGroup) {
      try {
        if (signalProcessGroup(spawned.pid, signal)) return true
      } catch (error) {
        logger.warn(
          `serverLifecycle:failed to send ${signal} to process group: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    try {
      return spawned.kill(signal)
    } catch (error) {
      logger.warn(
        `serverLifecycle:failed to send ${signal}: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  async function stop(): Promise<void> {
    stopping = true
    clearHealthTimer()
    clearRestartTimer()
    clearRestartResetTimer()
    const current = child
    child = null
    if (!current) {
      connection = null
      startPromise = null
      return
    }
    await terminateAndWait(current)
    connection = null
    startPromise = null
  }

  return { start, getServerBaseUrl, stop }
}

export type { ServerLifecycle as ServerLifecycleInstance }
