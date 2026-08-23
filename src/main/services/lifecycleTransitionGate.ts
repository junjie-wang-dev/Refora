import { MainProcessError } from './errors'

export interface LifecycleTransitionGate {
  run<T>(transition: () => Promise<T>): Promise<T>
  beginShutdown(): void
  cancelShutdown(): void
  waitForIdle(): Promise<void>
}

export function createLifecycleTransitionGate(): LifecycleTransitionGate {
  let shuttingDown = false
  const active = new Set<Promise<unknown>>()

  return {
    run<T>(transition: () => Promise<T>): Promise<T> {
      if (shuttingDown) {
        return Promise.reject(new MainProcessError('app_shutting_down', 'The app is shutting down'))
      }
      const operation = transition()
      active.add(operation)
      void operation.finally(() => {
        active.delete(operation)
      }).catch(() => undefined)
      return operation
    },
    beginShutdown(): void {
      shuttingDown = true
    },
    cancelShutdown(): void {
      shuttingDown = false
    },
    async waitForIdle(): Promise<void> {
      await Promise.allSettled([...active])
    }
  }
}
