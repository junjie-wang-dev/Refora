import { runPersistenceGuard, type PersistenceFailureAction } from './persistenceGuard'

interface BeforeQuitEvent {
  preventDefault(): void
}

interface ShutdownDeps {
  flushWindowState: () => Promise<void>
  flushRendererState: () => Promise<void>
  unregisterHandlers: () => void
  stopServices: () => Promise<void>
  destroyRuntimes: () => void
  quit: () => void
  reportError: (error: unknown) => void
  resolvePersistenceFailure: (error: unknown) => Promise<PersistenceFailureAction>
}

export function createShutdownHandler(deps: ShutdownDeps) {
  let state: 'idle' | 'running' | 'complete' = 'idle'

  return (event: BeforeQuitEvent): void => {
    if (state === 'complete') return
    event.preventDefault()
    if (state === 'running') return
    state = 'running'
    void (async () => {
      let persistenceResult: 'saved' | 'cancelled' | 'discarded'
      try {
        persistenceResult = await runPersistenceGuard({
          persist: async () => {
            await Promise.all([deps.flushWindowState(), deps.flushRendererState()])
          },
          resolveFailure: async (error) => {
            deps.reportError(error)
            return deps.resolvePersistenceFailure(error)
          }
        })
      } catch (error) {
        deps.reportError(error)
        state = 'idle'
        return
      }
      if (persistenceResult === 'cancelled') {
        state = 'idle'
        return
      }
      try {
        deps.unregisterHandlers()
      } catch (error) {
        deps.reportError(error)
      }
      try {
        await deps.stopServices()
      } catch (error) {
        deps.reportError(error)
      }
      try {
        deps.destroyRuntimes()
      } catch (error) {
        deps.reportError(error)
      }
      state = 'complete'
      deps.quit()
    })()
  }
}
