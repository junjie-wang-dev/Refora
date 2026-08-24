import type { BrowserWindow } from 'electron'
import { IpcChannel } from '../../../shared/ipc-channels'
import type { ServerClient, WsEventName } from '../client'
import {
  CONNECTOR_EVENT_NAMES,
  type ServerEventName
} from '../../../shared/server-contract'

type EventForward = readonly [ServerEventName, (typeof IpcChannel)[keyof typeof IpcChannel]]

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
  ['import.progress', IpcChannel.EventImportProgress],
  ['import.toast', IpcChannel.EventImportToast],
  ['workspace.items.changed', IpcChannel.EventWorkspaceItemsChanged],
  ['mineru.install-progress', IpcChannel.EventMineruInstallProgress],
  ['ocr.progress', IpcChannel.EventOcrProgress],
  ['ocr.completed', IpcChannel.EventOcrCompleted],
  ['ocr.error', IpcChannel.EventOcrError]
]

const connectorEvents: readonly WsEventName[] = CONNECTOR_EVENT_NAMES

export interface ServerEventBridgeDeps {
  serverClient: ServerClient
  getWin: () => BrowserWindow | null
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
    deps.serverClient.ws.subscribe([
      ...eventForwards.map(([event]) => event),
      ...connectorEvents
    ])
  }

  function stop(): void {
    if (!started) return
    started = false
    for (const unsubscribe of unsubscribeListeners) unsubscribe()
    unsubscribeListeners = []
    deps.serverClient.ws.unsubscribe([
      ...eventForwards.map(([event]) => event),
      ...connectorEvents
    ])
  }

  return { start, stop }
}
