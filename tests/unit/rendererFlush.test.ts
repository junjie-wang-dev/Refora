import { describe, expect, it, vi } from 'vitest'
import { createRendererFlushCoordinator } from '../../src/main/services/rendererFlush'
import { createAppLifecycleIpcHandlers } from '../../src/main/services/appLifecycleIpc'
import { IpcChannel } from '../../src/shared/ipc-channels'

describe('renderer persistence flush coordinator', () => {
  it('validates renderer acknowledgements before completing them', async () => {
    const completeRendererFlush = vi.fn().mockReturnValue(true)
    const handler = createAppLifecycleIpcHandlers({ completeRendererFlush })[
      IpcChannel.RendererFlushComplete
    ]

    await expect(handler('flush-1')).resolves.toEqual({ ok: true, data: undefined })
    expect(completeRendererFlush).toHaveBeenCalledWith('flush-1', undefined)
    await expect(handler(null)).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Invalid renderer flush response' }
    })
    completeRendererFlush.mockReturnValueOnce(false)
    await expect(handler('stale')).resolves.toEqual({
      ok: false,
      error: { code: 'unknown_request', message: 'Renderer flush request is no longer active' }
    })
  })

  it('waits for the matching renderer acknowledgement', async () => {
    const coordinator = createRendererFlushCoordinator()
    const send = vi.fn()

    const pending = coordinator.request(send)
    const requestId = send.mock.calls[0][0] as string

    expect(coordinator.complete('stale-request')).toBe(false)
    expect(coordinator.complete(requestId)).toBe(true)
    await expect(pending).resolves.toBeUndefined()
  })

  it('coalesces concurrent flush requests', async () => {
    const coordinator = createRendererFlushCoordinator()
    const send = vi.fn()

    const first = coordinator.request(send)
    const second = coordinator.request(send)
    coordinator.complete(send.mock.calls[0][0] as string)

    expect(first).toBe(second)
    expect(send).toHaveBeenCalledOnce()
    await first
  })

  it('rejects failures reported by the renderer', async () => {
    const coordinator = createRendererFlushCoordinator()
    const send = vi.fn()
    const pending = coordinator.request(send)

    coordinator.complete(send.mock.calls[0][0] as string, 'disk full')

    await expect(pending).rejects.toThrow('disk full')
  })

  it('rejects a renderer that does not acknowledge before the timeout', async () => {
    vi.useFakeTimers()
    const coordinator = createRendererFlushCoordinator(100)
    const pending = coordinator.request(() => undefined)
    const assertion = expect(pending).rejects.toThrow('timed out')

    await vi.advanceTimersByTimeAsync(100)

    await assertion
    vi.useRealTimers()
  })
})
