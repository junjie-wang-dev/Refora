# Refora — Agent Guide

## Project overview
- Refora is a local-first macOS Electron application for managing, reading, and discussing PDF literature.
- The stack is Electron + electron-vite + React + TypeScript with a Python 3.12 FastAPI + SQLite sidecar.
- Keep user data and source PDFs local unless an existing, user-configured AI provider is explicitly involved.

## Platform
macOS only.

## Repository map
- `src/main/`: Electron main process, native macOS integration, IPC handlers, and Python sidecar lifecycle.
- `src/main/sidecar/`: Electron-to-Python lifecycle, client, native RPC, and renderer IPC adapters.
- `src/preload/`: the isolated, typed bridge exposed to the renderer.
- `src/shared/`: IPC channels, request/response types, and cross-process domain types.
- `src/renderer/`: React UI, Zustand stores, hooks, styles, theme tokens, and localization.
- `backend/`: Python FastAPI sidecar project, backend tests, and isolated Python workers.
- `backend/refora_server/db/migrations/`: ordered SQLite migrations; add a new numbered migration instead of rewriting an applied one.
- `tests/unit/` and `tests/component/`: Vitest coverage for services, stores, hooks, and renderer components.
- `build/`: application icons and packaging resources that are intentionally checked in.
- `.github/workflows/`: macOS CI and tag-driven release automation.

## Working conventions
- Inspect `git status` before editing. Preserve unrelated user changes and keep the patch scoped to the request.
- Use the existing TypeScript types and IPC channel constants; do not duplicate contracts in the renderer.
- Renderer code must access privileged capabilities through the preload API only. Do not import Node or Electron APIs into `src/renderer/`.
- When changing an IPC operation, update the shared channel/types, main handler, preload bridge, and focused tests together.
- Keep migrations forward-only and transactional. Schema changes require a new migration and migration tests.
- Add or update focused tests for behavior changes. Prefer observable behavior over implementation-detail assertions.
- Keep English and Chinese locale keys synchronized when user-facing copy changes.
- Do not hand-edit generated output in `out/`, `dist/`, `coverage/`, or `node_modules/`.
- Keep `package-lock.json` in sync with dependency changes and use `npm ci` in automation.

## Verification gate
After **any** code change, before declaring work done, run:
```
npm run typecheck && npm run lint && npm run test
```
- Smoke a feature with `npm run dev`.
- Before claiming a build works: `npm run package`.
- When dependencies, native modules, packaging, or release automation changes, run the package command even if application code is unchanged.

A task's own Verification assertions must also pass. Do not mark a task done until both the gate and the task's assertions pass.


## Security baseline (never violate)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (preload), no `remote`.
- All file-path args validated to be `.pdf` and resolved to absolute paths in main before any fs action.
- CSP per spec — prod: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`. Dev (only when `!app.isPackaged`): add `'unsafe-inline'` to script-src + allow `ws://localhost:*` in connect-src for HMR.
- Every IPC response is a typed envelope `Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }`. Handlers never throw across the bridge (wrap in try/catch, always resolve). Preload unwraps `{ok:false}` into a serializable `IpcError`.
- Keyboard shortcuts are app-scoped only: `Menu` accelerators + renderer `keydown`. NEVER import `globalShortcut`.

## Don't-do list
- No code comments unless asked.
- Deleting a document moves its PDF to the system Trash (via `shell.trashItem`, best-effort) and removes the DB record. Never hard-delete a source PDF with `fs.unlink`; the file must remain recoverable from the Trash.
- Never read a whole PDF into memory for hashing (stream it).
- Never git commit unless explicitly asked.
- If a test fails and you can't fix it, or a task is blocked, STOP and report — don't guess.

## Toolchain notes
- Use the Node.js 24 line locally and in automation.
- SQLite is owned by the Python sidecar and uses Python's standard `sqlite3` module.
- `tsc -b` (typecheck) uses project references and **excludes test files**; tests are run by vitest only.

## CI and release automation
- `.github/workflows/ci.yml` runs the verification gate and an unsigned macOS package build for every branch push and pull request.
- `.github/workflows/release.yml` runs the same gate and publishes the DMG plus a SHA-256 checksum when a `v*` tag is pushed.
- A release tag must exactly match the package version, for example package version `0.2.0` uses tag `v0.2.0`.
- Never weaken or bypass the verification steps to make a workflow pass.
- GitHub Releases are unsigned when signing secrets are absent. Signed and notarized releases require repository secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- `APPLE_API_KEY_BASE64` must contain the base64-encoded App Store Connect API private key (`.p8`). Do not commit certificates, API keys, or decoded signing material.
