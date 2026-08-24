import { describe, expect, it, vi } from 'vitest'
import { createShutdownHandler } from '../../src/main/services/shutdown'

describe('shutdown handler', () => {
  it('closes the transition gate before flushing and waits for active work before stopping', async () => {
    const order: string[] = []
    let releaseTransition: () => void = () => undefined
    const transition = new Promise<void>((resolve) => { releaseTransition = resolve })
    const quit = vi.fn()
    const handler = createShutdownHandler({
      beginShutdown: () => order.push('begin'),
      cancelShutdown: () => order.push('cancel'),
      waitForTransitions: async () => {
        order.push('wait')
        await transition
      },
      flushWindowState: async () => { order.push('flush') },
      flushRendererState: async () => { order.push('renderer') },
      unregisterHandlers: () => order.push('unregister'),
      stopServices: async () => { order.push('stop') },
      destroyRuntimes: () => order.push('destroy'),
      quit,
      reportError: vi.fn(),
      resolvePersistenceFailure: vi.fn()
    })

    handler({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(order).toEqual(['begin', 'wait']))
    expect(quit).not.toHaveBeenCalled()

    releaseTransition()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(order).toEqual([
      'begin',
      'wait',
      'flush',
      'renderer',
      'unregister',
      'stop',
      'destroy'
    ])
  })

  it('flushes state and waits for services before quitting', async () => {
    const order: string[] = []
    let releaseStop: () => void = () => undefined
    const stopPending = new Promise<void>((resolve) => { releaseStop = resolve })
    const quit = vi.fn(() => order.push('quit'))
    const handler = createShutdownHandler({
      flushWindowState: async () => { order.push('flush') },
      flushRendererState: async () => { order.push('renderer') },
      unregisterHandlers: () => order.push('unregister'),
      stopServices: async () => { order.push('stop'); await stopPending },
      destroyRuntimes: () => order.push('destroy'),
      quit,
      reportError: vi.fn(),
      resolvePersistenceFailure: vi.fn().mockResolvedValue('cancel')
    })
    const event = { preventDefault: vi.fn() }

    handler(event)
    handler(event)
    await vi.waitFor(() => expect(order).toEqual(['flush', 'renderer', 'unregister', 'stop']))
    expect(quit).not.toHaveBeenCalled()

    releaseStop()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(order).toEqual(['flush', 'renderer', 'unregister', 'stop', 'destroy', 'quit'])
    expect(event.preventDefault).toHaveBeenCalledTimes(2)

    handler(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
  })

  it('reports cleanup errors and still completes the quit', async () => {
    const reportError = vi.fn()
    const quit = vi.fn()
    const handler = createShutdownHandler({
      flushWindowState: async () => undefined,
      flushRendererState: async () => undefined,
      unregisterHandlers: () => { throw new Error('unregister') },
      stopServices: async () => { throw new Error('stop') },
      destroyRuntimes: () => { throw new Error('destroy') },
      quit,
      reportError,
      resolvePersistenceFailure: vi.fn().mockResolvedValue('cancel')
    })

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(reportError).toHaveBeenCalledTimes(3)
  })

  it('guards window state persistence failures before shutdown', async () => {
    const quit = vi.fn()
    const resolvePersistenceFailure = vi.fn().mockResolvedValue('cancel')
    const handler = createShutdownHandler({
      flushWindowState: vi.fn().mockRejectedValue(new Error('window state failed')),
      flushRendererState: async () => undefined,
      unregisterHandlers: vi.fn(),
      stopServices: vi.fn(),
      destroyRuntimes: vi.fn(),
      quit,
      reportError: vi.fn(),
      resolvePersistenceFailure
    })

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(resolvePersistenceFailure).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()
  })

  it('retries renderer persistence before continuing shutdown', async () => {
    const quit = vi.fn()
    const stopServices = vi.fn()
    const flushRendererState = vi.fn()
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(undefined)
    const handler = createShutdownHandler({
      flushWindowState: async () => undefined,
      flushRendererState,
      unregisterHandlers: vi.fn(),
      stopServices,
      destroyRuntimes: vi.fn(),
      quit,
      reportError: vi.fn(),
      resolvePersistenceFailure: vi.fn().mockResolvedValue('retry')
    })

    handler({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(flushRendererState).toHaveBeenCalledTimes(2)
  })

  it('cancels shutdown after a renderer persistence failure', async () => {
    const quit = vi.fn()
    const cancelShutdown = vi.fn()
    const resolvePersistenceFailure = vi.fn().mockResolvedValue('cancel')
    const handler = createShutdownHandler({
      flushWindowState: async () => undefined,
      flushRendererState: vi.fn().mockRejectedValue(new Error('save failed')),
      cancelShutdown,
      unregisterHandlers: vi.fn(),
      stopServices: vi.fn(),
      destroyRuntimes: vi.fn(),
      quit,
      reportError: vi.fn(),
      resolvePersistenceFailure
    })

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(resolvePersistenceFailure).toHaveBeenCalledOnce())
    expect(quit).not.toHaveBeenCalled()
    expect(cancelShutdown).toHaveBeenCalledOnce()
  })

  it('continues shutdown only after an explicit discard decision', async () => {
    const quit = vi.fn()
    const handler = createShutdownHandler({
      flushWindowState: async () => undefined,
      flushRendererState: vi.fn().mockRejectedValue(new Error('save failed')),
      unregisterHandlers: vi.fn(),
      stopServices: vi.fn().mockResolvedValue(undefined),
      destroyRuntimes: vi.fn(),
      quit,
      reportError: vi.fn(),
      resolvePersistenceFailure: vi.fn().mockResolvedValue('discard')
    })

    handler({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
  })
})
