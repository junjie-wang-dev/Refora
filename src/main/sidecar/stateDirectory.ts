import {
  type Dirent,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

const DIRECTORY_PREFIX = 'server-'
const OWNER_FILE = 'owner.json'

interface StateDirectoryOwner {
  parentPid: number
  childPid: number | null
}

export interface ServerStateDirectory {
  path: string
  setChildPid(pid: number): void
  cleanup(): void
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function readOwner(path: string): StateDirectoryOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(path, OWNER_FILE), 'utf8')) as unknown
    if (!value || typeof value !== 'object') return null
    const { parentPid, childPid } = value as Record<string, unknown>
    if (!Number.isInteger(parentPid) || (parentPid as number) <= 0) return null
    if (childPid !== null && (!Number.isInteger(childPid) || (childPid as number) <= 0)) return null
    return { parentPid: parentPid as number, childPid: childPid as number | null }
  } catch {
    return null
  }
}

function writeOwner(path: string, owner: StateDirectoryOwner): void {
  writeFileSync(join(path, OWNER_FILE), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 })
}

export function cleanupStaleServerStateDirectories(
  userDataDir: string,
  isProcessAlive: (pid: number) => boolean = processAlive
): number {
  let removed = 0
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(userDataDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(DIRECTORY_PREFIX)) continue
    const path = join(userDataDir, entry.name)
    const owner = readOwner(path)
    if (!owner || owner.childPid === null) continue
    if (isProcessAlive(owner.parentPid) || isProcessAlive(owner.childPid)) continue
    try {
      rmSync(path, { recursive: true, force: true })
      removed += 1
    } catch {
      continue
    }
  }
  return removed
}

export function createServerStateDirectory(
  userDataDir: string,
  parentPid = process.pid
): ServerStateDirectory {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new Error('Server state parent PID must be a positive integer')
  }
  const path = mkdtempSync(join(userDataDir, DIRECTORY_PREFIX))
  const owner: StateDirectoryOwner = { parentPid, childPid: null }
  try {
    writeOwner(path, owner)
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
  let cleaned = false

  return {
    path,
    setChildPid: (pid) => {
      if (cleaned) return
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('Server state child PID must be a positive integer')
      }
      owner.childPid = pid
      writeOwner(path, owner)
    },
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      rmSync(path, { recursive: true, force: true })
    }
  }
}
