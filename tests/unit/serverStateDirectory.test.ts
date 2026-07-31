import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServerStateDirectory } from '../../src/main/sidecar/stateDirectory'

describe('server state directory', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('isolates concurrent lifecycle token files and cleans them independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-server-state-'))
    roots.push(root)
    const first = createServerStateDirectory(root)
    const second = createServerStateDirectory(root)

    expect(first.path).not.toBe(second.path)
    expect(existsSync(first.path)).toBe(true)
    expect(existsSync(second.path)).toBe(true)

    first.cleanup()
    first.cleanup()

    expect(existsSync(first.path)).toBe(false)
    expect(existsSync(second.path)).toBe(true)

    second.cleanup()
    expect(existsSync(second.path)).toBe(false)
  })
})
