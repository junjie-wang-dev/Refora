export const SERVER_PROTOCOL_VERSION = 1 as const

export const SERVER_PROTOCOL_DIGEST = "224ad3de017e3a4f2cbe1d0f416516fd98d899bc8d43e6735f90216226cbfe5d" as const

export const SERVER_HTTP_ROUTES = [
  {
    "method": "DELETE",
    "path": "/ai/chat/threads/{thread_id}"
  },
  {
    "method": "DELETE",
    "path": "/ai/memories"
  },
  {
    "method": "DELETE",
    "path": "/ai/providers/{provider_id}"
  },
  {
    "method": "DELETE",
    "path": "/ai/reports/{report_id}"
  },
  {
    "method": "DELETE",
    "path": "/categories/{category_id}"
  },
  {
    "method": "DELETE",
    "path": "/documents/{document_id}"
  },
  {
    "method": "DELETE",
    "path": "/watch/{watch_id}"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}/assets/{asset_id}"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}/connections/{connection_id}"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}/items/{item_id}"
  },
  {
    "method": "DELETE",
    "path": "/workspaces/{workspace_id}/notes/{note_id}"
  },
  {
    "method": "GET",
    "path": "/ai/chat/runs/{run_id}"
  },
  {
    "method": "GET",
    "path": "/ai/chat/runs/{run_id}/pending-interrupt"
  },
  {
    "method": "GET",
    "path": "/ai/chat/threads"
  },
  {
    "method": "GET",
    "path": "/ai/chat/threads/{thread_id}/history"
  },
  {
    "method": "GET",
    "path": "/ai/chat/threads/{thread_id}/traces"
  },
  {
    "method": "GET",
    "path": "/ai/doc-text/{document_id}"
  },
  {
    "method": "GET",
    "path": "/ai/memories"
  },
  {
    "method": "GET",
    "path": "/ai/providers"
  },
  {
    "method": "GET",
    "path": "/ai/reports"
  },
  {
    "method": "GET",
    "path": "/ai/summary/{document_id}"
  },
  {
    "method": "GET",
    "path": "/app/bootstrap"
  },
  {
    "method": "GET",
    "path": "/categories"
  },
  {
    "method": "GET",
    "path": "/documents"
  },
  {
    "method": "GET",
    "path": "/documents/count"
  },
  {
    "method": "GET",
    "path": "/documents/search"
  },
  {
    "method": "GET",
    "path": "/documents/{document_id}"
  },
  {
    "method": "GET",
    "path": "/export/bibtex-string"
  },
  {
    "method": "GET",
    "path": "/health"
  },
  {
    "method": "GET",
    "path": "/mineru/status"
  },
  {
    "method": "GET",
    "path": "/ocr/documents/{document_id}/results/{result_key}/assets/{asset_path:path}"
  },
  {
    "method": "GET",
    "path": "/ocr/documents/{document_id}/results/{result_key}/markdown"
  },
  {
    "method": "GET",
    "path": "/ocr/state"
  },
  {
    "method": "GET",
    "path": "/ready"
  },
  {
    "method": "GET",
    "path": "/search/global"
  },
  {
    "method": "GET",
    "path": "/settings"
  },
  {
    "method": "GET",
    "path": "/settings/web-search"
  },
  {
    "method": "GET",
    "path": "/watch"
  },
  {
    "method": "GET",
    "path": "/workspace-assets/{asset_id}"
  },
  {
    "method": "GET",
    "path": "/workspace-assets/{asset_id}/content"
  },
  {
    "method": "GET",
    "path": "/workspace-connections/{connection_id}"
  },
  {
    "method": "GET",
    "path": "/workspace-items/{item_id}"
  },
  {
    "method": "GET",
    "path": "/workspace-notes/{note_id}"
  },
  {
    "method": "GET",
    "path": "/workspaces"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/assets"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/assets/{asset_id}/preview"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/canvas"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/connections"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/items"
  },
  {
    "method": "GET",
    "path": "/workspaces/{workspace_id}/notes"
  },
  {
    "method": "PATCH",
    "path": "/ai/chat/threads/{thread_id}"
  },
  {
    "method": "PATCH",
    "path": "/ai/providers/{provider_id}"
  },
  {
    "method": "PATCH",
    "path": "/ai/reports/{report_id}"
  },
  {
    "method": "PATCH",
    "path": "/categories/{category_id}"
  },
  {
    "method": "PATCH",
    "path": "/documents/{document_id}"
  },
  {
    "method": "PATCH",
    "path": "/settings"
  },
  {
    "method": "PATCH",
    "path": "/settings/web-search"
  },
  {
    "method": "PATCH",
    "path": "/workspaces/{workspace_id}"
  },
  {
    "method": "PATCH",
    "path": "/workspaces/{workspace_id}/items/{item_id}/size"
  },
  {
    "method": "PATCH",
    "path": "/workspaces/{workspace_id}/notes/{note_id}"
  },
  {
    "method": "POST",
    "path": "/ai/chat/cancel"
  },
  {
    "method": "POST",
    "path": "/ai/chat/resume"
  },
  {
    "method": "POST",
    "path": "/ai/chat/send"
  },
  {
    "method": "POST",
    "path": "/ai/providers"
  },
  {
    "method": "POST",
    "path": "/ai/providers/models"
  },
  {
    "method": "POST",
    "path": "/ai/providers/{provider_id}/test"
  },
  {
    "method": "POST",
    "path": "/ai/summarize"
  },
  {
    "method": "POST",
    "path": "/categories"
  },
  {
    "method": "POST",
    "path": "/categories/{category_id}/assign"
  },
  {
    "method": "POST",
    "path": "/categories/{category_id}/unassign"
  },
  {
    "method": "POST",
    "path": "/clipboard/copy-markdown"
  },
  {
    "method": "POST",
    "path": "/clipboard/copy-workspace-asset"
  },
  {
    "method": "POST",
    "path": "/clipboard/write-text"
  },
  {
    "method": "POST",
    "path": "/dialog/open-directory"
  },
  {
    "method": "POST",
    "path": "/documents/bulk-categorize"
  },
  {
    "method": "POST",
    "path": "/documents/bulk-delete"
  },
  {
    "method": "POST",
    "path": "/documents/bulk-refresh-metadata"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/open-in-finder"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/open-pdf"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/refresh-metadata"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/relocate"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/restore-file"
  },
  {
    "method": "POST",
    "path": "/documents/{document_id}/starred"
  },
  {
    "method": "POST",
    "path": "/export/bibtex"
  },
  {
    "method": "POST",
    "path": "/export/json"
  },
  {
    "method": "POST",
    "path": "/import/files"
  },
  {
    "method": "POST",
    "path": "/import/folder"
  },
  {
    "method": "POST",
    "path": "/import/identifier"
  },
  {
    "method": "POST",
    "path": "/import/json"
  },
  {
    "method": "POST",
    "path": "/import/mendeley"
  },
  {
    "method": "POST",
    "path": "/import/zotero"
  },
  {
    "method": "POST",
    "path": "/library/switch"
  },
  {
    "method": "POST",
    "path": "/mineru/cancel-install"
  },
  {
    "method": "POST",
    "path": "/mineru/choose-install-root"
  },
  {
    "method": "POST",
    "path": "/mineru/install"
  },
  {
    "method": "POST",
    "path": "/mineru/uninstall"
  },
  {
    "method": "POST",
    "path": "/ocr/cancel"
  },
  {
    "method": "POST",
    "path": "/ocr/start"
  },
  {
    "method": "POST",
    "path": "/settings/web-search/test"
  },
  {
    "method": "POST",
    "path": "/shutdown"
  },
  {
    "method": "POST",
    "path": "/watch"
  },
  {
    "method": "POST",
    "path": "/watch/{watch_id}/toggle"
  },
  {
    "method": "POST",
    "path": "/workspaces"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/assets/files"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/assets/{asset_id}/open"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/assets/{asset_id}/reveal"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/connections"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/items"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/items/batch"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/items/move"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/items/reorder"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/notes"
  },
  {
    "method": "POST",
    "path": "/workspaces/{workspace_id}/open-sandbox"
  },
  {
    "method": "PUT",
    "path": "/ai/memories"
  },
  {
    "method": "PUT",
    "path": "/workspaces/{workspace_id}/canvas"
  }
] as const

export const SERVER_WEBSOCKET_PATH = "/ws" as const

export const SERVER_EVENT_NAMES = [
  "ai.chat.token",
  "ai.chat.reasoning",
  "ai.chat.done",
  "ai.chat.error",
  "ai.chat.trace",
  "ai.chat.interrupted",
  "ai.chat.run-status",
  "ai.chat.title-updated",
  "ai.chat.interrupt-request",
  "ai.chat.interrupt-resolve",
  "ai.summary.updated",
  "ai.summary.error",
  "ai.report.created",
  "document.updated",
  "library.scanning",
  "library.switched",
  "window.focus-changed",
  "import.progress",
  "import.toast",
  "workspace.items.changed",
  "mineru.install-progress",
  "ocr.progress",
  "ocr.completed",
  "ocr.error"
] as const

export const CONNECTOR_EVENT_NAMES = [
  "connector.trash-item",
  "connector.open-path",
  "connector.show-in-folder",
  "connector.dialog-open-directory",
  "connector.dialog-open-file",
  "connector.dialog-choose",
  "connector.clipboard-write",
  "connector.clipboard-write-file",
  "connector.encrypt-api-key",
  "connector.decrypt-api-key",
  "connector.apply-proxy"
] as const

export const CLIENT_WEBSOCKET_EVENT_NAMES = [
  "subscribe",
  "unsubscribe",
  "ping",
  "connector.result",
  "connector.error"
] as const

export const SERVER_WEBSOCKET_EVENT_NAMES = [
  "subscribed",
  "unsubscribed",
  "pong"
] as const

export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number]

export type ConnectorEventName = (typeof CONNECTOR_EVENT_NAMES)[number]

export type ServerWebsocketEventName = (typeof SERVER_WEBSOCKET_EVENT_NAMES)[number]

