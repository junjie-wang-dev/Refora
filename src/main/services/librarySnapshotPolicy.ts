import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export interface SnapshotLibraryContext {
  dbPath: string
  libraryFolder: string
}

interface LibrarySnapshotPolicyDeps {
  createSnapshot: (context: SnapshotLibraryContext, baseSequence?: number) => Promise<unknown>
}

function fileActivityToken(path: string): string {
  if (!existsSync(path)) return 'missing'
  const stat = statSync(path)
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

export function databaseActivityToken(dbPath: string): string {
  return `${fileActivityToken(dbPath)}|${fileActivityToken(`${dbPath}-wal`)}`
}

export function createLibrarySnapshotPolicy(deps: LibrarySnapshotPolicyDeps) {
  const capturedActivity = new Map<string, string>()

  async function capture(
    context: SnapshotLibraryContext,
    baseSequence: number | undefined,
    onlyIfChanged: boolean
  ): Promise<boolean> {
    if (!context.dbPath || !context.libraryFolder || !existsSync(context.dbPath)) return false
    const key = resolve(context.dbPath)
    const activity = databaseActivityToken(context.dbPath)
    if (onlyIfChanged && capturedActivity.get(key) === activity) return false
    await deps.createSnapshot(context, baseSequence)
    capturedActivity.set(key, activity)
    return true
  }

  return {
    snapshotIfChanged(context: SnapshotLibraryContext, baseSequence?: number): Promise<boolean> {
      return capture(context, baseSequence, true)
    },
    snapshotNow(context: SnapshotLibraryContext, baseSequence?: number): Promise<boolean> {
      return capture(context, baseSequence, false)
    }
  }
}

export type LibrarySnapshotPolicy = ReturnType<typeof createLibrarySnapshotPolicy>
