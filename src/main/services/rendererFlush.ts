interface PendingFlush {
  id: string
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface RendererFlushCoordinator {
  request(send: (requestId: string) => void): Promise<void>
  complete(requestId: string, error?: string): boolean
  cancel(error?: Error): void
}

export function createRendererFlushCoordinator(timeoutMs = 10_000): RendererFlushCoordinator {
  let sequence = 0
  let pending: PendingFlush | null = null

  const clearPending = (request: PendingFlush): void => {
    clearTimeout(request.timeout)
    if (pending === request) pending = null
  }

  return {
    request: (send) => {
      if (pending) return pending.promise
      const id = `renderer-flush-${++sequence}`
      let resolve: () => void = () => undefined
      let reject: (error: Error) => void = () => undefined
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      const request: PendingFlush = {
        id,
        promise,
        resolve,
        reject,
        timeout: setTimeout(() => {
          clearPending(request)
          reject(new Error('Renderer persistence flush timed out'))
        }, timeoutMs)
      }
      pending = request
      try {
        send(id)
      } catch (error) {
        clearPending(request)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      return promise
    },
    complete: (requestId, error) => {
      const request = pending
      if (!request || request.id !== requestId) return false
      clearPending(request)
      if (error) request.reject(new Error(error))
      else request.resolve()
      return true
    },
    cancel: (error = new Error('Renderer persistence flush was cancelled')) => {
      const request = pending
      if (!request) return
      clearPending(request)
      request.reject(error)
    }
  }
}
