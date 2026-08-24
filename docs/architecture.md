# Refora architecture

Refora is split into four explicit runtime boundaries:

| Directory | Responsibility |
| --- | --- |
| `backend/` | Python FastAPI sidecar, domain services, repositories, migrations, backend tests, and Python worker entry points |
| `src/main/` | Electron main process and macOS-native capabilities |
| `src/preload/` | Isolated, typed bridge between Electron and the renderer |
| `src/renderer/` | React user interface and client-side state |

## Electron and Python boundary

`src/main/sidecar/` owns all Electron integration with the Python backend:

- `runtime.ts` provisions the development Python runtime.
- `lifecycle.ts` starts, monitors, and stops the sidecar.
- `client.ts` implements the authenticated HTTP and WebSocket client.
- `nativeRpc.ts` exposes narrowly scoped macOS capabilities to Python.
- `assembly.ts` wires the sidecar client to Electron IPC.
- `ipc/` contains the renderer-facing adapters grouped by application domain.

General desktop services remain in `src/main/services/`. Renderer code must never import from either directory and continues to use the preload API.

## Python backend

The Python project is rooted at `backend/`:

- `refora_server/server/` contains FastAPI composition, routes, transport, and lifecycle.
- `refora_server/services/` contains application use cases.
- `refora_server/repositories/` contains SQLite persistence adapters.
- `refora_server/db/` owns connection setup, schema, and forward-only migrations.
- `refora_server/agent/`, `academic/`, `library/`, `ocr/`, and `web/` contain domain-specific code.
- `workers/` contains isolated Python process entry points.
- `tests/` contains backend tests.

The generated TypeScript protocol contract remains in `src/shared/server-contract.ts`. Run `npm run generate:server-contract` after changing the Python contract.

## Verification

Run the application gate:

```sh
npm run verify
```

Packaging and release changes also require `npm run package`.
