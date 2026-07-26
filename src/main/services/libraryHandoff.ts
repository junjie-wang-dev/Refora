import { resolve as resolvePath } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { LibrarySwitchResult } from '../../shared/ipc-types'

export interface LibraryHandoffRuntime {
  repos: { settings: { set(key: string, value: unknown): void } }
  importer: { importFiles(paths: string[], isWatch: boolean): Promise<{ added: string[]; skipped: string[]; errors: Array<{ path: string; message: string }> }> }
  watcher: { startLibraryWatcher(folder: string): void }
}

export interface LibraryHandoffAssembly { start(): Promise<void>; stop(): Promise<void> }

export interface LibraryHandoffDeps<Runtime extends LibraryHandoffRuntime> {
  getRuntime(): Runtime | null
  setRuntime(runtime: Runtime): void
  getAssembly(): LibraryHandoffAssembly | null
  setAssembly(assembly: LibraryHandoffAssembly): void
  createRuntime(dbPath: string): Runtime
  destroyRuntime(runtime: Runtime): void
  createAssembly(runtime: Runtime, dbPath: string, folder: string): Promise<LibraryHandoffAssembly>
  activateRuntime(runtime: Runtime): void
  dbPathForLibraryFolder(folder: string): string
  dbExistsInLibraryFolder(folder: string): boolean
  findPdfsRecursively(folder: string): Promise<string[]>
  writeLibraryFolderPath(folder: string): void
  emitLibraryScanning(win: BrowserWindow, payload: { current: number; total: number }): void
  emitLibrarySwitched(win: BrowserWindow, payload: LibrarySwitchResult): void
  getWin(): BrowserWindow | null
  exists(folder: string): boolean
  isDirectory(folder: string): boolean
}

export function createLibraryHandoff<Runtime extends LibraryHandoffRuntime>(deps: LibraryHandoffDeps<Runtime>): (folder: string) => Promise<LibrarySwitchResult> {
  let switching = false
  return async (folder: string): Promise<LibrarySwitchResult> => {
    if (switching) throw Object.assign(new Error('Library switch already in progress'), { code: 'busy' })
    switching = true
    try {
      const resolvedFolder = folder ? resolvePath(folder) : ''
      if (!resolvedFolder || !deps.exists(resolvedFolder) || !deps.isDirectory(resolvedFolder)) {
        throw Object.assign(new Error(`Invalid library folder: ${resolvedFolder}`), { code: 'invalid_library' })
      }
      const previousRuntime = deps.getRuntime()
      if (!previousRuntime) throw new Error('Runtime not ready')
      const previousAssembly = deps.getAssembly()
      const targetDbPath = deps.dbPathForLibraryFolder(resolvedFolder)
      const dbExisted = deps.dbExistsInLibraryFolder(resolvedFolder)
      const nextRuntime = deps.createRuntime(targetDbPath)
      let nextAssembly: LibraryHandoffAssembly | null = null
      try {
        nextRuntime.repos.settings.set('libraryFolderPath', resolvedFolder)
        await previousAssembly?.stop()
        let scanned = 0
        let imported = 0
        let skipped = 0
        const errors: Array<{ path: string; message: string }> = []
        if (!dbExisted) {
          const pdfs = await deps.findPdfsRecursively(resolvedFolder)
          scanned = pdfs.length
          const win = deps.getWin()
          if (scanned > 0 && win && !win.isDestroyed()) deps.emitLibraryScanning(win, { current: 0, total: scanned })
          if (scanned > 0) {
            const result = await nextRuntime.importer.importFiles(pdfs, false)
            imported = result.added.length
            skipped = result.skipped.length
            errors.push(...result.errors)
          }
        }
        nextAssembly = await deps.createAssembly(nextRuntime, targetDbPath, resolvedFolder)
        await nextAssembly.start()
        try { nextRuntime.watcher.startLibraryWatcher(resolvedFolder) } catch (error) { errors.push({ path: resolvedFolder, message: error instanceof Error ? error.message : String(error) }) }
        deps.setRuntime(nextRuntime)
        deps.setAssembly(nextAssembly)
        deps.writeLibraryFolderPath(resolvedFolder)
        deps.destroyRuntime(previousRuntime)
        deps.activateRuntime(nextRuntime)
        const result: LibrarySwitchResult = { libraryFolderPath: resolvedFolder, dbExisted, scanned, imported, skipped, errors }
        const win = deps.getWin()
        if (win && !win.isDestroyed()) deps.emitLibrarySwitched(win, result)
        return result
      } catch (error) {
        await nextAssembly?.stop().catch(() => undefined)
        deps.destroyRuntime(nextRuntime)
        if (previousAssembly) {
          await previousAssembly.start()
          deps.setAssembly(previousAssembly)
        }
        throw error
      }
    } finally { switching = false }
  }
}
