import type { LibrarySwitchResult } from '../../shared/ipc-types'
import type { ServerAssembly } from '../sidecar/assembly'

interface LibraryState {
  assembly: ServerAssembly | null
  dbPath: string
  libraryFolder: string
}

interface LibrarySwitcherDeps {
  resolveFolder: (folder: string) => string
  isDirectory: (folder: string) => boolean
  dbPathForFolder: (folder: string) => string
  dbExistsInFolder: (folder: string) => boolean
  createAssembly: (
    dbPath: string,
    libraryFolder: string,
    switchLibraryFolder: (folder: string) => Promise<LibrarySwitchResult>
  ) => Promise<ServerAssembly>
  beforeSwitch?: () => Promise<void>
  activateAssembly?: (assembly: ServerAssembly) => Promise<void>
  getState: () => LibraryState
  setState: (state: LibraryState) => void
  persistLibraryFolder: (folder: string) => void
  emitSwitched: (result: LibrarySwitchResult) => void
  onRecoveryFailed: (error: unknown) => void
}

export function createLibrarySwitcher(deps: LibrarySwitcherDeps) {
  let switching = false

  const switchLibraryFolder = async (folder: string): Promise<LibrarySwitchResult> => {
    if (switching) {
      throw Object.assign(new Error('Library switch already in progress'), { code: 'busy' })
    }
    const resolvedFolder = folder ? deps.resolveFolder(folder) : ''
    if (!resolvedFolder || !deps.isDirectory(resolvedFolder)) {
      throw Object.assign(new Error(`Invalid library folder: ${resolvedFolder}`), {
        code: 'invalid_library'
      })
    }

    switching = true
    const previous = deps.getState()
    const targetDbPath = deps.dbPathForFolder(resolvedFolder)
    const dbExisted = deps.dbExistsInFolder(resolvedFolder)
    let nextAssembly: ServerAssembly | null = null
    let switchStarted = false
    let preferenceCommitted = false
    try {
      await deps.beforeSwitch?.()
      switchStarted = true
      await previous.assembly?.stop()
      deps.setState({
        assembly: null,
        dbPath: previous.dbPath,
        libraryFolder: previous.libraryFolder
      })
      nextAssembly = await deps.createAssembly(
        targetDbPath,
        resolvedFolder,
        switchLibraryFolder
      )
      await nextAssembly.start()
      await deps.activateAssembly?.(nextAssembly)
      let scanned = 0
      let imported = 0
      let skipped = 0
      const errors: Array<{ path: string; message: string }> = []
      if (!dbExisted) {
        const importResult = await nextAssembly.getClient().http.importFolder({
          path: resolvedFolder,
          recursive: true
        })
        imported = importResult.added.length
        skipped = importResult.skipped.length
        scanned = imported + skipped + importResult.errors.length
        errors.push(...importResult.errors)
      }
      deps.persistLibraryFolder(resolvedFolder)
      preferenceCommitted = true
      deps.setState({
        assembly: nextAssembly,
        dbPath: targetDbPath,
        libraryFolder: resolvedFolder
      })
      const result: LibrarySwitchResult = {
        libraryFolderPath: resolvedFolder,
        dbExisted,
        scanned,
        imported,
        skipped,
        errors
      }
      deps.emitSwitched(result)
      return result
    } catch (error) {
      await nextAssembly?.stop().catch(() => undefined)
      if (previous.assembly && switchStarted) {
        let restored: ServerAssembly | null = null
        try {
          restored = await deps.createAssembly(
            previous.dbPath,
            previous.libraryFolder,
            switchLibraryFolder
          )
          await restored.start()
          await deps.activateAssembly?.(restored)
          if (preferenceCommitted) deps.persistLibraryFolder(previous.libraryFolder)
          deps.setState({ ...previous, assembly: restored })
        } catch (recoveryError) {
          await restored?.stop().catch(() => undefined)
          deps.setState({ ...previous, assembly: null })
          const failure = Object.assign(
            new AggregateError([error, recoveryError], 'Failed to switch library and restore the previous library'),
            { code: 'library_recovery_failed' }
          )
          deps.onRecoveryFailed(failure)
          throw failure
        }
      }
      throw error
    } finally {
      switching = false
    }
  }

  return switchLibraryFolder
}
