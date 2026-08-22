interface BeforeQuitEvent {
  preventDefault(): void
}

interface ShutdownDeps {
  flushWindowState: () => Promise<void>
  unregisterHandlers: () => void
  stopServices: () => Promise<void>
  destroyRuntimes: () => void
  quit: () => void
  reportError: (error: unknown) => void
}

export function createShutdownHandler(deps: ShutdownDeps) {
  let state: 'idle' | 'running' | 'complete' = 'idle'

  return (event: BeforeQuitEvent): void => {
    if (state === 'complete') return
    event.preventDefault()
    if (state === 'running') return
    state = 'running'
    void (async () => {
      try {
        await deps.flushWindowState()
      } catch (error) {
        deps.reportError(error)
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
