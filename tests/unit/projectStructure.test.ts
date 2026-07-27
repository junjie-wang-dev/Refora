import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('project structure', () => {
  it('keeps the Python backend behind one top-level boundary', () => {
    expect(existsSync('backend/pyproject.toml')).toBe(true)
    expect(existsSync('backend/refora_server/server/app.py')).toBe(true)
    expect(existsSync('backend/workers/mineru_worker.py')).toBe(true)
    expect(existsSync('python/server')).toBe(false)
    expect(existsSync('resources/mineru_worker.py')).toBe(false)
    expect(existsSync('resources/ddgs_worker.py')).toBe(false)
  })

  it('keeps Electron sidecar integration out of general services', () => {
    expect(existsSync('src/main/sidecar/assembly.ts')).toBe(true)
    expect(existsSync('src/main/sidecar/ipc/app.ts')).toBe(true)

    const services = readdirSync('src/main/services')
    expect(services).not.toContain('serverClient.ts')
    expect(services).not.toContain('serverLifecycle.ts')
    expect(services).not.toContain('agentPythonRuntime.ts')
  })
})
