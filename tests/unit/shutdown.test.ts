import { describe, expect, it, vi } from 'vitest'
import { createShutdownHandler } from '../../src/main/services/shutdown'

describe('shutdown handler', () => {
  it('flushes state and waits for services before quitting', async () => {
    const order: string[] = []
    let releaseStop: () => void = () => undefined
    const stopPending = new Promise<void>((resolve) => { releaseStop = resolve })
    const quit = vi.fn(() => order.push('quit'))
    const handler = createShutdownHandler({
      flushWindowState: async () => { order.push('flush') },
      unregisterHandlers: () => order.push('unregister'),
      stopServices: async () => { order.push('stop'); await stopPending },
      destroyRuntimes: () => order.push('destroy'),
      quit,
      reportError: vi.fn()
    })
    const event = { preventDefault: vi.fn() }

    handler(event)
    handler(event)
    await vi.waitFor(() => expect(order).toEqual(['flush', 'unregister', 'stop']))
    expect(quit).not.toHaveBeenCalled()

    releaseStop()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(order).toEqual(['flush', 'unregister', 'stop', 'destroy', 'quit'])
    expect(event.preventDefault).toHaveBeenCalledTimes(2)

    handler(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
  })

  it('reports cleanup errors and still completes the quit', async () => {
    const reportError = vi.fn()
    const quit = vi.fn()
    const handler = createShutdownHandler({
      flushWindowState: async () => { throw new Error('flush') },
      unregisterHandlers: () => { throw new Error('unregister') },
      stopServices: async () => { throw new Error('stop') },
      destroyRuntimes: () => { throw new Error('destroy') },
      quit,
      reportError
    })

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(reportError).toHaveBeenCalledTimes(4)
  })
})
