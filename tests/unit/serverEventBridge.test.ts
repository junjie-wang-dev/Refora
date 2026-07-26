import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../../src/shared/ipc-channels'
import { createServerEventBridge } from '../../src/main/ipc/serverEventBridge'
import type { ServerClient } from '../../src/main/services/serverClient'

describe('server event bridge', () => {
  let listeners: Map<string, (data: unknown) => void>
  let on: ReturnType<typeof vi.fn>
  let subscribe: ReturnType<typeof vi.fn>
  let unsubscribe: ReturnType<typeof vi.fn>
  let send: ReturnType<typeof vi.fn>
  let isDestroyed: ReturnType<typeof vi.fn>
  let enqueueMetadata: ReturnType<typeof vi.fn>
  let bridge: ReturnType<typeof createServerEventBridge>

  beforeEach(() => {
    listeners = new Map()
    on = vi.fn((event: string, listener: (data: unknown) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    })
    subscribe = vi.fn()
    unsubscribe = vi.fn()
    send = vi.fn()
    isDestroyed = vi.fn(() => false)
    enqueueMetadata = vi.fn()
    bridge = createServerEventBridge({
      serverClient: {
        ws: { on, subscribe, unsubscribe }
      } as unknown as ServerClient,
      getWin: () => ({
        isDestroyed,
        webContents: { isDestroyed, send }
      }) as never,
      enqueueMetadata
    })
  })

  it('subscribes once and forwards server events to their renderer channels', () => {
    bridge.start()
    bridge.start()

    expect(on).toHaveBeenCalledTimes(23)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledWith(expect.arrayContaining([
      'ai.chat.token',
      'ai.summary.updated',
      'ai.report.created',
      'document.updated',
      'library.scanning',
      'import.progress',
      'metadata.enqueue',
      'workspace.items.changed',
      'mineru.install-progress',
      'ocr.error',
      'connector.get-api-key',
      'connector.encrypt-api-key',
      'connector.decrypt-api-key'
    ]))

    const payload = { threadId: 'thread-1', token: 'Hello' }
    listeners.get('ai.chat.token')?.(payload)
    listeners.get('workspace.items.changed')?.({ workspaceId: 'workspace-1' })
    listeners.get('ocr.completed')?.({ jobId: 'job-1' })
    listeners.get('metadata.enqueue')?.({
      documentIds: ['document-1', null, 'document-2']
    })

    expect(send).toHaveBeenNthCalledWith(1, IpcChannel.EventAiChatToken, payload)
    expect(send).toHaveBeenNthCalledWith(2, IpcChannel.EventWorkspaceItemsChanged, {
      workspaceId: 'workspace-1'
    })
    expect(send).toHaveBeenNthCalledWith(3, IpcChannel.EventOcrCompleted, { jobId: 'job-1' })
    expect(enqueueMetadata).toHaveBeenCalledTimes(2)
    expect(enqueueMetadata).toHaveBeenNthCalledWith(1, 'document-1')
    expect(enqueueMetadata).toHaveBeenNthCalledWith(2, 'document-2')
  })

  it('stops forwarding and unsubscribes every event topic', () => {
    bridge.start()
    bridge.stop()
    listeners.get('ai.chat.done')?.({ threadId: 'thread-1' })

    expect(send).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledWith(
      expect.arrayContaining([
        'ai.chat.done',
        'ocr.progress',
        'metadata.enqueue',
        'connector.decrypt-api-key'
      ])
    )
  })

  it('does not send after the window or web contents are destroyed', () => {
    bridge.start()
    isDestroyed.mockReturnValue(true)
    listeners.get('document.updated')?.({ documentId: 'document-1' })

    expect(send).not.toHaveBeenCalled()
  })
})
