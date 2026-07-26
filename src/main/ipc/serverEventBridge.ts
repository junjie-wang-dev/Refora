import type { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc-channels'
import type { ServerClient, WsEventName } from '../services/serverClient'

type EventForward = readonly [WsEventName, (typeof IpcChannel)[keyof typeof IpcChannel]]

const eventForwards: readonly EventForward[] = [
  ['ai.chat.token', IpcChannel.EventAiChatToken],
  ['ai.chat.reasoning', IpcChannel.EventAiChatReasoning],
  ['ai.chat.done', IpcChannel.EventAiChatDone],
  ['ai.chat.error', IpcChannel.EventAiChatError],
  ['ai.chat.trace', IpcChannel.EventAiChatTrace],
  ['ai.chat.interrupted', IpcChannel.EventAiChatInterrupted],
  ['ai.chat.run-status', IpcChannel.EventAiChatRunStatus],
  ['ai.chat.title-updated', IpcChannel.EventAiChatTitleUpdated],
  ['ai.summary.updated', IpcChannel.EventAiSummaryUpdated],
  ['ai.summary.error', IpcChannel.EventAiSummaryError],
  ['ai.report.created', IpcChannel.EventAiReportCreated],
  ['document.updated', IpcChannel.EventDocumentUpdated],
  ['library.scanning', IpcChannel.EventLibraryScanning],
  ['library.switched', IpcChannel.EventLibrarySwitched],
  ['window.focus-changed', IpcChannel.EventWindowFocusChanged],
  ['import.progress', IpcChannel.EventImportProgress],
  ['import.toast', IpcChannel.EventImportToast],
  ['workspace.items.changed', IpcChannel.EventWorkspaceItemsChanged],
  ['mineru.install-progress', IpcChannel.EventMineruInstallProgress],
  ['ocr.progress', IpcChannel.EventOcrProgress],
  ['ocr.completed', IpcChannel.EventOcrCompleted],
  ['ocr.error', IpcChannel.EventOcrError]
]

const connectorEvents: readonly WsEventName[] = [
  'connector.trash-item',
  'connector.open-path',
  'connector.show-in-folder',
  'connector.dialog-open-directory',
  'connector.dialog-open-file',
  'connector.dialog-choose',
  'connector.clipboard-write',
  'connector.clipboard-write-file',
  'connector.get-api-key',
  'connector.encrypt-api-key',
  'connector.decrypt-api-key'
]

export interface ServerEventBridgeDeps {
  serverClient: ServerClient
  getWin: () => BrowserWindow | null
  enqueueMetadata?: (documentId: string) => void
}

export interface ServerEventBridge {
  start(): void
  stop(): void
}

export function createServerEventBridge(deps: ServerEventBridgeDeps): ServerEventBridge {
  let unsubscribeListeners: Array<() => void> = []
  let started = false

  function forward(channel: EventForward[1], data: unknown): void {
    const win = deps.getWin()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, data)
  }

  function start(): void {
    if (started) return
    started = true
    unsubscribeListeners = eventForwards.map(([event, channel]) =>
      deps.serverClient.ws.on(event, (data) => forward(channel, data))
    )
    unsubscribeListeners.push(
      deps.serverClient.ws.on('metadata.enqueue', (data) => {
        if (!data || typeof data !== 'object') return
        const documentIds = (data as { documentIds?: unknown }).documentIds
        if (!Array.isArray(documentIds)) return
        for (const documentId of documentIds) {
          if (typeof documentId === 'string' && documentId) {
            deps.enqueueMetadata?.(documentId)
          }
        }
      })
    )
    deps.serverClient.ws.subscribe([
      ...eventForwards.map(([event]) => event),
      ...connectorEvents,
      'metadata.enqueue'
    ])
  }

  function stop(): void {
    if (!started) return
    started = false
    for (const unsubscribe of unsubscribeListeners) unsubscribe()
    unsubscribeListeners = []
    deps.serverClient.ws.unsubscribe([
      ...eventForwards.map(([event]) => event),
      ...connectorEvents,
      'metadata.enqueue'
    ])
  }

  return { start, stop }
}
