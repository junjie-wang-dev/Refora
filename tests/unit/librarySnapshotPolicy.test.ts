import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createLibrarySnapshotPolicy } from '../../src/main/services/librarySnapshotPolicy'

describe('library snapshot policy', () => {
  it('captures the first observation, skips unchanged databases, and captures WAL writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-snapshot-policy-'))
    const dbPath = join(root, 'local', 'working.db')
    const libraryFolder = join(root, 'cloud-library')
    mkdirSync(join(dbPath, '..'), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE marker(value TEXT)')
    const createSnapshot = vi.fn(async () => undefined)
    const policy = createLibrarySnapshotPolicy({ createSnapshot })
    const context = { dbPath, libraryFolder }

    await expect(policy.snapshotIfChanged(context)).resolves.toBe(true)
    await expect(policy.snapshotIfChanged(context)).resolves.toBe(false)
    expect(createSnapshot).toHaveBeenCalledTimes(1)

    db.prepare('INSERT INTO marker VALUES (?)').run('changed')
    await expect(policy.snapshotIfChanged(context)).resolves.toBe(true)
    await expect(policy.snapshotIfChanged(context)).resolves.toBe(false)
    expect(createSnapshot).toHaveBeenCalledTimes(2)

    await expect(policy.snapshotNow(context)).resolves.toBe(true)
    expect(createSnapshot).toHaveBeenCalledTimes(3)
    db.close()
  })
})
