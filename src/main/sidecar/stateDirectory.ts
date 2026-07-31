import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface ServerStateDirectory {
  path: string
  cleanup(): void
}

export function createServerStateDirectory(userDataDir: string): ServerStateDirectory {
  const path = mkdtempSync(join(userDataDir, 'server-'))
  let cleaned = false

  return {
    path,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      rmSync(path, { recursive: true, force: true })
    }
  }
}
