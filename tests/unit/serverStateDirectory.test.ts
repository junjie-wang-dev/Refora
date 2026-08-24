import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupStaleServerStateDirectories,
  createServerStateDirectory
} from '../../src/main/sidecar/stateDirectory'

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

  it('removes only directories whose recorded parent and child are both gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-server-state-'))
    roots.push(root)
    const stale = createServerStateDirectory(root, 101)
    stale.setChildPid(201)
    const activeParent = createServerStateDirectory(root, 102)
    activeParent.setChildPid(202)
    const activeChild = createServerStateDirectory(root, 103)
    activeChild.setChildPid(203)

    expect(cleanupStaleServerStateDirectories(
      root,
      (pid) => pid === 102 || pid === 203
    )).toBe(1)

    expect(existsSync(stale.path)).toBe(false)
    expect(existsSync(activeParent.path)).toBe(true)
    expect(existsSync(activeChild.path)).toBe(true)
  })

  it('preserves legacy and not-yet-spawned directories without enough ownership evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-server-state-'))
    roots.push(root)
    const legacy = join(root, 'server-legacy')
    mkdirSync(legacy)
    const pending = createServerStateDirectory(root, 301)

    expect(cleanupStaleServerStateDirectories(root, () => false)).toBe(0)
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(pending.path)).toBe(true)
  })
})
