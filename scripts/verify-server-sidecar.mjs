import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import {
  architectures,
  canonicalSha256
} from './server-sidecar-integrity.mjs'

const [sidecarDirectory, expectedArchitecture] = process.argv.slice(2)
if (!sidecarDirectory || !['arm64', 'x64'].includes(expectedArchitecture)) {
  throw new Error('Usage: verify-server-sidecar.mjs <directory> <arm64|x64>')
}

const resolvedSidecarDirectory = resolve(sidecarDirectory)
const executable = join(resolvedSidecarDirectory, 'refora-server')
const manifestPath = join(resolvedSidecarDirectory, 'sidecar-manifest.json')
await access(executable, constants.X_OK)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (
  manifest.formatVersion !== 1 ||
  manifest.platform !== 'darwin' ||
  manifest.architecture !== expectedArchitecture ||
  !/^3\.12\.[0-9]+$/.test(manifest.pythonVersion) ||
  manifest.executable !== 'refora-server'
) {
  throw new Error(`Invalid sidecar manifest: ${manifestPath}`)
}
const binaryArchitectures = await architectures(executable)
const expectedMachArchitecture = expectedArchitecture === 'x64' ? 'x86_64' : 'arm64'
if (
  binaryArchitectures.length !== 1 ||
  binaryArchitectures[0] !== expectedMachArchitecture
) {
  throw new Error(
    `Sidecar binary architecture ${binaryArchitectures.join(',')} does not match ${expectedMachArchitecture}`
  )
}
const digest = await canonicalSha256(executable)
if (manifest.canonicalSha256 !== digest) {
  throw new Error(`Sidecar checksum mismatch: ${manifestPath}`)
}

const runFile = promisify(execFile)
const artifactCheck = await runFile(executable, ['--verify-artifact'], {
  cwd: resolvedSidecarDirectory,
  env: {
    PATH: '/usr/bin:/bin',
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1'
  },
  timeout: 30000,
  maxBuffer: 1024 * 1024
})
const artifact = JSON.parse(artifactCheck.stdout.trim().split('\n').at(-1))
for (const distribution of [
  'aiosqlite',
  'deepagents',
  'langchain',
  'langchain-core',
  'langchain-openai',
  'langgraph',
  'langgraph-checkpoint-sqlite'
]) {
  if (!artifact.ok || typeof artifact.versions?.[distribution] !== 'string') {
    throw new Error(`Sidecar artifact check failed for ${distribution}`)
  }
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'refora-sidecar-smoke-'))
const stateDirectory = join(temporaryDirectory, 'state')
const databasePath = join(temporaryDirectory, 'refora.sqlite')
const libraryDirectory = join(temporaryDirectory, 'library')
const child = spawn(executable, [
  '--port', '0',
  '--host', '127.0.0.1',
  '--state-dir', stateDirectory,
  '--db-path', databasePath,
  '--library-folder', libraryDirectory
], {
  cwd: temporaryDirectory,
  env: {
    PATH: '/usr/bin:/bin',
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk.toString('utf8')}`.slice(-100000)
})
const exit = new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => resolve({ code, signal }))
})
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })

try {
  const port = await Promise.race([
    (async () => {
      for await (const line of lines) {
        const match = /^LISTENING ([0-9]+)$/.exec(line.trim())
        if (match) return Number(match[1])
      }
      throw new Error(`Sidecar exited before listening: ${stderr}`)
    })(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Sidecar startup timed out: ${stderr}`)),
      30000
    ))
  ])
  const tokenFile = JSON.parse(await readFile(join(stateDirectory, 'server.token'), 'utf8'))
  if (tokenFile.port !== port || typeof tokenFile.token !== 'string' || !tokenFile.token) {
    throw new Error('Sidecar emitted an invalid token file')
  }
  const readyDeadline = Date.now() + 30000
  let ready
  while (Date.now() < readyDeadline) {
    ready = await fetch(`http://127.0.0.1:${port}/ready`, {
      headers: { 'X-Refora-Token': tokenFile.token }
    }).catch(() => undefined)
    if (ready?.ok) break
    const stopped = await Promise.race([
      exit.then((result) => ({ stopped: true, result })),
      new Promise((resolve) => setTimeout(() => resolve({ stopped: false }), 100))
    ])
    if (stopped.stopped) {
      throw new Error(`Sidecar stopped before readiness: ${JSON.stringify(stopped.result)} ${stderr}`)
    }
  }
  if (!ready?.ok) {
    throw new Error(`Sidecar did not become ready: ${ready?.status ?? 'connection refused'} ${stderr}`)
  }
  const shutdown = await fetch(`http://127.0.0.1:${port}/shutdown`, {
    method: 'POST',
    headers: { 'X-Refora-Token': tokenFile.token }
  })
  if (!shutdown.ok) throw new Error(`Sidecar shutdown returned HTTP ${shutdown.status}`)
  const result = await Promise.race([
    exit,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Sidecar did not stop')), 10000))
  ])
  if (result.code !== 0) {
    throw new Error(`Sidecar exited with ${result.code ?? result.signal}: ${stderr}`)
  }
} finally {
  lines.close()
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await rm(temporaryDirectory, { recursive: true, force: true })
}
