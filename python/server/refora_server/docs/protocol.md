# Refora Server Protocol Contract

This document is the canonical contract for the Refora Python server. All
endpoint and WebSocket event definitions here are the input contract for every
parallel migration task. Any change to this file must be coordinated across
task packages.

## Conventions

### Transport
- HTTP/1.1 + WebSocket. Server binds **only** to `127.0.0.1` (loopback).
- Every HTTP request (except `GET /health`) MUST carry header
  `X-Refora-Token: <token>`. The token is generated at startup and written to
  `<state-dir>/server.token` (mode `0o600`, owner-only).
- WebSocket connections authenticate the token via query string
  `?token=<token>` on the upgrade request.
- API keys (provider keys) are **never persisted** by the server and **never
  logged**. They are supplied per-request by the TS client from the Electron
  secure store.

### Response envelope
All HTTP responses use the `Result<T>` envelope:

```jsonc
// success
{ "ok": true, "data": <T> }
// failure
{ "ok": false, "error": { "code": "<machine-code>", "message": "<human text>" } }
```

HTTP status codes:
- `200` — success
- `400` — bad request / validation error (code `bad_request` / `validation`)
- `401` — invalid/missing token (code `unauthorized`)
- `404` — resource not found (code `not_found`)
- `409` — conflict / state error (code `conflict`)
- `500` — internal error (code `internal`)
- `503` — dependency unavailable, e.g. Mineru missing (code `unavailable`)

Every handler must catch its own exceptions and return an envelope; handlers
never raise across the transport.

### Identifiers
- `documentId`, `workspaceId`, `threadId`, `runId`, `sessionId`, `categoryId`,
  `assetId`, `noteId`, `connectionId`, `reportId` are opaque strings (UUIDs).
- File path arguments are resolved to absolute paths inside the server and
  validated to be `.pdf` where applicable.

---

## HTTP endpoints

### System
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/health` | optional | — | `{status:"ok"}` |
| GET | `/ready` | required | — | `{status:"ready"}` |
| POST | `/shutdown` | required | — | `{ack:true}` (graceful shutdown) |

### Documents (literature management)
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/documents` | required | query: `?q=&categoryId=&starred=&limit=&offset=` | `Document[]` |
| GET | `/documents/count` | required | query filters | `{count:number}` |
| GET | `/documents/search` | required | query: `?q=` | `Document[]` (global/full-text) |
| GET | `/documents/{documentId}` | required | — | `Document` |
| PATCH | `/documents/{documentId}` | required | `DocumentPatch` | `Document` |
| POST | `/documents/{documentId}/starred` | required | `{starred:boolean}` | `Document` |
| DELETE | `/documents/{documentId}` | required | — | `{ack:true}` (trashes PDF via connector callback) |
| POST | `/documents/bulk-delete` | required | `{ids:string[]}` | `{ack:true}` |
| POST | `/documents/bulk-categorize` | required | `{ids:string[],categoryId:string\|null}` | `{ack:true}` |
| POST | `/documents/bulk-refresh-metadata` | required | `{ids:string[]}` | `{ack:true}` |
| POST | `/documents/{documentId}/refresh-metadata` | required | — | `Document` |
| POST | `/documents/{documentId}/relocate` | required | `{path:string}` | `Document` |
| POST | `/documents/{documentId}/restore-file` | required | — | `Document` |
| POST | `/documents/{documentId}/open-pdf` | required | — | `{ack:true}` (via connector) |
| POST | `/documents/{documentId}/open-in-finder` | required | — | `{ack:true}` (via connector) |

`Document` shape mirrors the existing `DocumentRecord` domain type:
```
{ id, title, authors[], year, journal, doi, arxivId, tags[], categoryId,
  starred, filePath, addedAt, updatedAt, metadata:{pageCount, fileSize, ...} }
```

### Import
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| POST | `/import/files` | required | multipart: file paths (server resolves abs paths) | `{imported:Document[], skipped:{path,reason}[]}` |
| POST | `/import/folder` | required | `{path:string, recursive?:boolean}` | `{imported:Document[]}` |
| POST | `/import/json` | required | `ExportPayload` | `{imported:number}` |
| POST | `/import/zotero` | required | `{dbPath?:string, paths:string[]}` | `{imported:number}` |
| POST | `/import/mendeley` | required | `{dbPath?:string, paths:string[]}` | `{imported:number}` |
| POST | `/import/identifier` | required | `{identifier:string}` | `{documentId:string}` |

### Categories
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/categories` | required | — | `Category[]` |
| POST | `/categories` | required | `{name:string,color?:string}` | `Category` |
| PATCH | `/categories/{categoryId}` | required | `{name?,color?}` | `Category` |
| DELETE | `/categories/{categoryId}` | required | — | `{ack:true}` |
| POST | `/categories/{categoryId}/assign` | required | `{documentIds:string[]}` | `{ack:true}` |
| POST | `/categories/{categoryId}/unassign` | required | `{documentIds:string[]}` | `{ack:true}` |

### Watch
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/watch` | required | — | `WatchEntry[]` |
| POST | `/watch` | required | `{path:string}` | `WatchEntry` |
| DELETE | `/watch/{watchId}` | required | — | `{ack:true}` |
| POST | `/watch/{watchId}/toggle` | required | `{enabled:boolean}` | `WatchEntry` |

### Library
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| POST | `/library/switch` | required | `{path:string}` | `{ack:true}` |

### Settings
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/settings` | required | — | `Settings` |
| PATCH | `/settings` | required | `SettingsPatch` | `Settings` |
| GET | `/settings/web-search` | required | — | `WebSearchConfig` |
| PATCH | `/settings/web-search` | required | `WebSearchConfig` | `WebSearchConfig` |
| POST | `/settings/web-search/test` | required | `{query:string}` | `{results:WebResult[]}` |

### AI providers
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/ai/providers` | required | — | `Provider[]` |
| POST | `/ai/providers` | required | `ProviderInput` | `Provider` |
| PATCH | `/ai/providers/{providerId}` | required | `ProviderInput` | `Provider` |
| DELETE | `/ai/providers/{providerId}` | required | — | `{ack:true}` |
| POST | `/ai/providers/{providerId}/test` | required | `{apiKey:string}` | `{ok:boolean,model?:string}` |
| GET | `/ai/providers/{providerId}/models` | required | `{apiKey:string}` (body or header) | `{models:string[]}` |

> `apiKey` is supplied per-call by the TS client from the secure store and is
> never persisted or logged server-side.

### AI document text & summaries
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/ai/doc-text/{documentId}` | required | — | `{text:string}` |
| POST | `/ai/summarize` | required | `{documentId:string,provider:ProviderConfig}` | `{summaryId:string}` (streams via WS) |
| GET | `/ai/summary/{documentId}` | required | — | `Summary` |

### AI chat / agent
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| POST | `/ai/chat/send` | required | `AgentRequest` | `{runId:string}` (events on WS) |
| POST | `/ai/chat/resume` | required | `{runId:string,...}` | `{runId:string}` |
| POST | `/ai/chat/cancel` | required | `{runId:string}` | `{ack:true}` |
| GET | `/ai/chat/threads` | required | `?workspaceId=` | `Thread[]` |
| GET | `/ai/chat/threads/{threadId}/history` | required | — | `Message[]` |
| GET | `/ai/chat/threads/{threadId}/traces` | required | — | `Trace[]` |
| GET | `/ai/chat/threads/{threadId}/pending-interrupt` | required | — | `Interrupt\|null` |
| DELETE | `/ai/chat/threads/{threadId}` | required | — | `{ack:true}` |
| PATCH | `/ai/chat/threads/{threadId}` | required | `{title:string}` | `Thread` |
| GET | `/ai/chat/threads/{threadId}/memories` | required | — | `Memory[]` |
| PUT | `/ai/chat/threads/{threadId}/memories/{memoryId}` | required | `{value:string}` | `Memory` |
| DELETE | `/ai/chat/threads/{threadId}/memories/{memoryId}` | required | — | `{ack:true}` |

### AI reports
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/ai/reports` | required | `?workspaceId=` | `Report[]` |
| DELETE | `/ai/reports/{reportId}` | required | — | `{ack:true}` |
| PATCH | `/ai/reports/{reportId}` | required | `ReportPatch` | `Report` |

### Workspaces
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/workspaces` | required | — | `Workspace[]` |
| POST | `/workspaces` | required | `{name:string}` | `Workspace` |
| PATCH | `/workspaces/{workspaceId}` | required | `{name:string}` | `Workspace` |
| DELETE | `/workspaces/{workspaceId}` | required | — | `{ack:true}` |
| POST | `/workspaces/{workspaceId}/open-sandbox` | required | — | `{ack:true}` (via connector) |

### Workspace items
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/workspaces/{workspaceId}/items` | required | — | `WorkspaceItem[]` |
| POST | `/workspaces/{workspaceId}/items` | required | `ItemInput` | `WorkspaceItem` |
| DELETE | `/workspaces/{workspaceId}/items/{itemId}` | required | — | `{ack:true}` |
| POST | `/workspaces/{workspaceId}/items/reorder` | required | `{ids:string[]}` | `{ack:true}` |
| PATCH | `/workspaces/{workspaceId}/items/{itemId}/size` | required | `{width,height}` | `WorkspaceItem` |
| POST | `/workspaces/{workspaceId}/items/move` | required | `{itemId,targetWorkspaceId}` | `WorkspaceItem` |

### Workspace assets
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/workspaces/{workspaceId}/assets` | required | — | `Asset[]` |
| POST | `/workspaces/{workspaceId}/assets/files` | required | `{paths:string[]}` | `Asset[]` |
| GET | `/workspaces/{workspaceId}/assets/{assetId}/preview` | required | — | `{text:string}` |
| POST | `/workspaces/{workspaceId}/assets/{assetId}/open` | required | — | `{ack:true}` (connector) |
| POST | `/workspaces/{workspaceId}/assets/{assetId}/reveal` | required | — | `{ack:true}` (connector) |
| DELETE | `/workspaces/{workspaceId}/assets/{assetId}` | required | — | `{ack:true}` |

### Workspace canvas / connections / notes
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/workspaces/{workspaceId}/canvas` | required | — | `Canvas` |
| PUT | `/workspaces/{workspaceId}/canvas` | required | `Canvas` | `Canvas` |
| GET | `/workspaces/{workspaceId}/connections` | required | — | `Connection[]` |
| POST | `/workspaces/{workspaceId}/connections` | required | `ConnectionInput` | `Connection` |
| DELETE | `/workspaces/{workspaceId}/connections/{connectionId}` | required | — | `{ack:true}` |
| GET | `/workspaces/{workspaceId}/notes` | required | — | `Note[]` |
| POST | `/workspaces/{workspaceId}/notes` | required | `NoteInput` | `Note` |
| PATCH | `/workspaces/{workspaceId}/notes/{noteId}` | required | `NoteInput` | `Note` |
| DELETE | `/workspaces/{workspaceId}/notes/{noteId}` | required | — | `{ack:true}` |

### OCR / Mineru
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| GET | `/mineru/status` | required | — | `MineruStatus` |
| POST | `/mineru/install` | required | `{installRoot?:string}` | `{ack:true}` (progress via WS) |
| POST | `/mineru/cancel-install` | required | — | `{ack:true}` |
| POST | `/mineru/uninstall` | required | — | `{ack:true}` |
| POST | `/ocr/start` | required | `{documentId:string, ...}` | `{jobId:string}` (progress via WS) |
| POST | `/ocr/cancel` | required | `{jobId:string}` | `{ack:true}` |
| GET | `/ocr/state` | required | — | `OcrState` |
| GET | `/ocr/{jobId}/markdown` | required | — | `{markdown:string}` |

### Export
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| POST | `/export/json` | required | `{documentIds?:string[], workspaceId?:string}` | `ExportPayload` |
| POST | `/export/bibtex` | required | `{documentIds:string[]}` | `ExportPayload` |
| GET | `/export/bibtex-string` | required | query: `?documentIds=a,b` | `{bibtex:string}` |

### Clipboard (via connector)
| Method | Path | Token | Body | Returns |
|---|---|---|---|---|
| POST | `/clipboard/write-text` | required | `{text:string}` | `{ack:true}` |
| POST | `/clipboard/copy-markdown` | required | `{markdown:string}` | `{ack:true}` |
| POST | `/clipboard/copy-workspace-asset` | required | `{assetId:string}` | `{ack:true}` |

---

## WebSocket event stream

Single multiplexed WebSocket: `ws://127.0.0.1:<port>/ws?token=<token>`.

### Client → Server (commands)
| Event | Payload | Response |
|---|---|---|
| `subscribe` | `{topics:string[]}` | `{event:"subscribed",topics:string[]}` |
| `unsubscribe` | `{topics:string[]}` | `{event:"unsubscribed",topics:string[]}` |
| `ping` | — | `pong` |

### Server → Client (events)
All events are JSON: `{event:"<name>", data:<...>}`.

#### Agent / chat stream
| Event | data |
|---|---|
| `ai.chat.token` | `{runId, threadId, delta:string}` |
| `ai.chat.reasoning` | `{runId, threadId, delta:string}` |
| `ai.chat.done` | `{runId, threadId, result, state}` |
| `ai.chat.error` | `{runId, threadId, error:{code,message}}` |
| `ai.chat.trace` | `{runId, name, parentIds[], data, tags[], metadata}` |
| `ai.chat.interrupted` | `{runId, threadId}` |
| `ai.chat.run-status` | `{runId, status:"running"\|"idle"\|"waiting"}` |
| `ai.chat.title-updated` | `{threadId, title}` |
| `ai.chat.interrupt-request` | `{runId, question}` (server asks connector/UI to resolve tool approval) |
| `ai.chat.interrupt-resolve` | `{runId, decision}` (connector/UI resolves; server-bound variant for completeness) |
| `ai.summary.updated` | `{documentId, summaryId, delta}` |
| `ai.summary.error` | `{documentId, error:{code,message}}` |
| `ai.report.created` | `{reportId, workspaceId}` |

#### Library / documents
| Event | data |
|---|---|
| `document.updated` | `{documentId, patch}` |
| `library.scanning` | `{active:boolean}` |
| `library.switched` | `{path}` |
| `window.focus-changed` | `{focused:boolean}` |
| `import.progress` | `{importId, current, total, path?}` |
| `import.toast` | `{importId, kind, message}` |
| `workspace.items.changed` | `{workspaceId}` |

#### OCR / Mineru
| Event | data |
|---|---|
| `mineru.install-progress` | `{stage, percent, message?}` |
| `ocr.progress` | `{jobId, percent, current, total}` |
| `ocr.completed` | `{jobId, documentId}` |
| `ocr.error` | `{jobId, error:{code,message}}` |

---

## Connector callbacks

The server frequently needs privileged Electron-host operations that must not
be reimplemented in Python (trash, open files, native dialogs, clipboard,
secure key store). These are implemented as **connector callbacks**: the
server, when it needs such an action, emits a connector-request event over the
WS and waits (with timeout) for the TS client to resolve it. The TS client is
the single privileged surface.

### Connector request events (Server → Client)
All carry `requestId` for correlation. Client must reply with a
`connector.result` or `connector.error` message containing the same
`requestId`.

| Event | request data | expected result |
|---|---|---|
| `connector.trash-item` | `{requestId, path:string}` | `{requestId, ok:true}` or `{requestId, ok:false, error}` — uses `shell.trashItem`; never `fs.unlink` |
| `connector.open-path` | `{requestId, path:string}` | `{requestId, ok:true}` — `shell.openPath` |
| `connector.show-in-folder` | `{requestId, path:string}` | `{requestId, ok:true}` — `shell.showItemInFolder` |
| `connector.dialog-open-directory` | `{requestId, title?:string}` | `{requestId, ok:true, data:{path:string\|null}}` — `dialog.showOpenDialog` |
| `connector.clipboard-write` | `{requestId, text:string}` | `{requestId, ok:true}` — `clipboard.writeText` |
| `connector.get-api-key` | `{requestId, providerId:string}` | `{requestId, ok:true, data:{apiKey:string\|null}}` — fetches from Electron secure store; **server must not persist or log the returned key** |

### Client → Server (connector replies)
| Event | Payload |
|---|---|
| `connector.result` | `{requestId, ok:true, data:any}` |
| `connector.error` | `{requestId, ok:false, error:{code,message}}` |

Server-side semantics:
- A connector request that times out (default 30s, configurable) resolves to
  a `Result.error` with code `connector_timeout`.
- Connector callbacks are the **only** path by which the server performs
  destructive/host actions; the server never imports `shell`/`fs`-unlink
  semantics directly.

---

## `ProviderConfig` (per-request AI provider)
Supplied on AI endpoints; never persisted by server:
```
{
  model: string,
  baseUrl: string,
  apiKey: string,
  useResponsesApi: boolean,
  modelKwargs: object,
  reasoning?: { effort: string, summary: "auto" },
  temperature: number | null,
  maxTokens: number | null
}
```

## `AgentRequest` (POST /ai/chat/send)
```
{
  runId: string,
  threadId: string,
  workspaceId: string | null,
  checkpointPath: string,
  checkpointBefore: string | null,
  provider: ProviderConfig,
  systemPrompt: string,
  messages?: object[],
  decisions?: object[],
  enabledToolNames: string[],
  sandboxRoot: string | null,
  memories: Record<string,string>,
  includeResearchMemory: boolean,
  recursionLimit: number
}
```

---

## Startup handshake
1. TS spawns `python -m refora_server.server.run --port <p> --host 127.0.0.1 --state-dir <dir>`.
2. Server selects the port (0 => OS-assigned), generates a token, writes
   `<state-dir>/server.token` (mode `0o600`) containing `{"port":<p>,"token":"..."}`.
3. Server prints exactly one line to stdout: `LISTENING <port>`.
4. TS reads the token file, then issues `GET /health` (no token needed) and
   `GET /ready` (with token) to confirm readiness before opening the WS.