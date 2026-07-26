import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { net } from 'electron'
import { logger } from './logger'

const DEFAULT_MAX_RESTARTS = 5
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_HEALTH_INTERVAL_MS = 15_000
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000
const BASE_BACKOFF_MS = 500
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
  spawnChild?: typeof spawn
  readFile?: (path: string) => Promise<string>
  fetchHealth?: (url: string, timeoutMs: number) => Promise<boolean>
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
  const spawnChild = deps.spawnChild ?? spawn
  const readFile = deps.readFile ?? defaultReadFile
  const fetchHealth = deps.fetchHealth ?? defaultFetchHealth

  let child: ChildProcess | null = null
  let connection: ServerConnection | null = null
  let startPromise: Promise<ServerConnection> | null = null
  let healthTimer: ReturnType<typeof setTimeout> | null = null
  let stopping = false
  let restartCount = 0

  function defaultReadFile(path: string): Promise<string> {
    return import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'))
  }

  function clearHealthTimer(): void {
    if (healthTimer) {
      clearTimeout(healthTimer)
      healthTimer = null
    }
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
      stdio: ['ignore', 'pipe', 'pipe']
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

  function attachCrashHandler(spawned: ChildProcess): void {
    spawned.once('close', (code, signal) => {
      if (stopping) return
      if (child === spawned) child = null
      connection = null
      clearHealthTimer()
      if (restartCount >= maxRestarts) {
        logger.error(
          `serverLifecycle:crashed and reached max restarts (${maxRestarts})`
        )
        connection = null
        startPromise = null
        return
      }
      restartCount += 1
      const backoff = BASE_BACKOFF_MS * 2 ** (restartCount - 1)
      logger.warn(
        `serverLifecycle:crashed (code=${code ?? signal}), restarting in ${backoff}ms (attempt ${restartCount}/${maxRestarts})`
      )
      setTimeout(() => {
        if (stopping) return
        void start().catch((error) => {
          logger.error(`serverLifecycle:restart failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, backoff)
    })
  }

  function scheduleHealthCheck(): void {
    clearHealthTimer()
    healthTimer = setInterval(() => {
      if (!connection || stopping) return
      void fetchHealth(`${connection.baseUrl}/health`, healthTimeoutMs).then((ok) => {
        if (ok || !connection || stopping) return
        logger.warn('serverLifecycle:health check failed, restarting server')
        const current = child
        if (current) {
          stopping = true
          try {
            current.kill('SIGTERM')
          } catch (e) {
            logger.warn(`serverLifecycle:kill-failed ${e instanceof Error ? e.message : String(e)}`)
          }
          stopping = false
        }
      })
    }, healthIntervalMs)
  }

  async function doStart(): Promise<ServerConnection> {
    const { child: spawned, portPromise } = spawnServer()
    child = spawned
    let port: number
    try {
      port = await portPromise
      connection = await buildConnection(port)
      await waitUntilHealthy(connection)
    } catch (error) {
      terminate(spawned, 'SIGTERM')
      connection = null
      child = null
      throw error
    }
    attachCrashHandler(spawned)
    scheduleHealthCheck()
    return connection
  }

  function start(): Promise<ServerConnection> {
    if (connection) return Promise.resolve(connection)
    if (startPromise) return startPromise
    startPromise = doStart().finally(() => {
      startPromise = null
    })
    return startPromise
  }

  async function getServerBaseUrl(): Promise<ServerConnection> {
    if (connection) return connection
    return start()
  }

  function terminate(spawned: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!spawned.pid) return
    try {
      spawned.kill(signal)
    } catch {
      spawned.kill(signal)
    }
  }

  async function stop(): Promise<void> {
    stopping = true
    clearHealthTimer()
    const current = child
    child = null
    if (!current) {
      connection = null
      startPromise = null
      return
    }
    const closed = new Promise<void>((resolve) => {
      current.once('close', () => resolve())
      const killTimer = setTimeout(() => {
        terminate(current, 'SIGKILL')
        resolve()
      }, 5_000)
      current.once('close', () => clearTimeout(killTimer))
    })
    terminate(current, 'SIGTERM')
    await closed
    connection = null
    startPromise = null
  }

  return { start, getServerBaseUrl, stop }
}

export type { ServerLifecycle as ServerLifecycleInstance }
