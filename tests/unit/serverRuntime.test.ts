import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SERVER_PYTHON_RUNTIME_VERSION,
  createServerPythonRuntime,
  runFile
} from '../../src/main/sidecar/runtime'

describe('server Python runtime', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reuses a verified managed Python installation', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'refora-server-python-test-'))
    roots.push(userDataDir)
    const root = join(
      userDataDir,
      'agent-python',
      SERVER_PYTHON_RUNTIME_VERSION,
      'darwin-arm64'
    )
    const python = join(root, 'runtime', 'venv', 'bin', 'python')
    await mkdir(join(root, 'runtime', 'venv', 'bin'), { recursive: true })
    await writeFile(python, '#!/bin/sh\n')
    await chmod(python, 0o755)
    const projectPath = join(userDataDir, 'pyproject.toml')
    const lockPath = join(userDataDir, 'uv.lock')
    await writeFile(projectPath, '')
    await writeFile(lockPath, 'test lock')
    const lockSha256 = createHash('sha256').update('test lock').digest('hex')
    await writeFile(join(root, 'installed-manifest.json'), JSON.stringify({
      runtimeVersion: SERVER_PYTHON_RUNTIME_VERSION,
      architecture: 'arm64',
      pythonVersion: '3.12.13',
      pythonRelativePath: 'runtime/venv/bin/python',
      lockSha256,
      packages: {
        deepagents: '0.6.12',
        langchain: '1.3.14',
        'langchain-core': '1.5.1',
        langgraph: '1.2.9',
        'langchain-openai': '1.4.1',
        'langgraph-checkpoint-sqlite': '3.1.1',
        aiosqlite: '0.22.1'
      },
      installedAt: 1
    }))
    const downloadFile = vi.fn()
    const runtime = createServerPythonRuntime({
      userDataDir,
      projectPath,
      architecture: 'arm64',
      downloadFile
    })

    await expect(runtime.install(new AbortController().signal)).resolves.toBe(python)
    expect(downloadFile).not.toHaveBeenCalled()
  })

  it('rejects installation after the lifecycle is destroyed', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'refora-server-python-test-'))
    roots.push(userDataDir)
    const projectPath = join(userDataDir, 'pyproject.toml')
    await writeFile(projectPath, '')
    await writeFile(join(userDataDir, 'uv.lock'), 'test lock')
    const runtime = createServerPythonRuntime({
      userDataDir,
      projectPath,
      architecture: 'arm64',
      downloadFile: vi.fn()
    })

    runtime.destroy()

    await expect(runtime.install(new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('waits after SIGTERM and escalates a stuck installer to SIGKILL', async () => {
    vi.useFakeTimers()
    try {
      const child = new EventEmitter() as ChildProcess
      Object.assign(child, {
        pid: 42,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true)
      })
      const spawnChild = vi.fn(() => child) as unknown as typeof spawn
      const killProcess = vi.fn(() => true) as unknown as typeof process.kill
      const controller = new AbortController()
      const operation = runFile('/usr/bin/tool', [], {
        cwd: '/tmp',
        env: {},
        signal: controller.signal,
        terminationGraceMs: 500,
        spawnChild,
        killProcess
      })
      operation.catch(() => undefined)

      controller.abort()
      expect(killProcess).toHaveBeenCalledWith(-42, 'SIGTERM')
      expect(killProcess).not.toHaveBeenCalledWith(-42, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(500)
      expect(killProcess).toHaveBeenCalledWith(-42, 'SIGKILL')
      child.emit('close', null, 'SIGKILL')

      await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      vi.useRealTimers()
    }
  })
})
