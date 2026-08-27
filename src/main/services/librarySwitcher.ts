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
  prepareDatabase?: (folder: string) => Promise<{
    dbPath: string
    dbExisted: boolean
  }>
  createAssembly: (
    dbPath: string,
    libraryFolder: string,
    switchLibraryFolder: (folder: string) => Promise<LibrarySwitchResult>
  ) => Promise<ServerAssembly>
  beforeSwitch?: () => Promise<void>
  snapshotCurrent?: (state: LibraryState) => Promise<void>
  activateAssembly?: (assembly: ServerAssembly) => Promise<void>
  getState: () => LibraryState
  setState: (state: LibraryState) => void
  persistLibraryFolder: (folder: string) => void
  emitSwitched: (result: LibrarySwitchResult) => void
  onRecoveryFailed: (error: unknown) => void
}

const INITIAL_IMPORT_COMPLETED_SETTING = 'libraryInitialImportCompleted'

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

    const previous = deps.getState()
    if (previous.assembly && previous.libraryFolder === resolvedFolder) {
      return {
        libraryFolderPath: resolvedFolder,
        dbExisted: deps.dbExistsInFolder(resolvedFolder),
        scanned: 0,
        imported: 0,
        skipped: 0,
        errors: []
      }
    }

    switching = true
    let targetDbPath = deps.dbPathForFolder(resolvedFolder)
    let dbExisted = deps.dbExistsInFolder(resolvedFolder)
    let nextAssembly: ServerAssembly | null = null
    let switchStarted = false
    let preferenceCommitted = false
    try {
      await deps.beforeSwitch?.()
      switchStarted = true
      await previous.assembly?.stop()
      await deps.snapshotCurrent?.(previous)
      deps.setState({
        assembly: null,
        dbPath: previous.dbPath,
        libraryFolder: previous.libraryFolder
      })
      if (deps.prepareDatabase) {
        const prepared = await deps.prepareDatabase(resolvedFolder)
        targetDbPath = prepared.dbPath
        dbExisted = prepared.dbExisted
      }
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
      const settings = await nextAssembly.getClient().http.settingsGet()
      if (settings[INITIAL_IMPORT_COMPLETED_SETTING] !== true) {
        const importResult = await nextAssembly.getClient().http.importFolder({
          path: resolvedFolder,
          recursive: true
        })
        imported = importResult.added.length
        skipped = importResult.skipped.length
        scanned = imported + skipped + importResult.errors.length
        errors.push(...importResult.errors)
        await nextAssembly.getClient().http.settingsUpdate({
          [INITIAL_IMPORT_COMPLETED_SETTING]: true
        })
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
