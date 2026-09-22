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

`npm run verify` covers type checking, lint, frontend coverage, backend tests,
Python source compilation, and the sidecar integration test. It does not run
Playwright, dependency audits, packaging, or the PostgreSQL RPC/RLS suite.

For the broader local macOS pipeline, use `npm run ci:local`. It checks the pinned
Node/npm versions, reinstalls with `npm ci`, runs both dependency audits, the
verification gate, Playwright, and packaging. The PostgreSQL suite remains a
separate check: provision an empty disposable PostgreSQL 17.6 database, set
`REFORA_SUPABASE_TEST_DB_URL`, `REFORA_SUPABASE_TEST_DB_PASSWORD`, and
`REFORA_SUPABASE_TEST_SSL=false`, then run `npm run supabase:test:local`.
This command applies the test bootstrap and migrations; never target a production
database. The `supabase` job in `.github/workflows/quality.yml` is the reference setup.
Record the commit, commands, and any skipped checks when reporting CI parity.

### Timing-sensitive tests

Vitest uses at most four workers (and never more than the available CPU count)
locally and in CI. This bounds simultaneous jsdom, component-library, and coverage
work instead of scaling memory and CPU contention with every core on the host.
Test timeouts and coverage thresholds remain unchanged.

A worker cap alone does not make expensive component tests reliable. In
`LobeControls.test.tsx`, the package entry is resolved to the real Button, Modal,
and Select subpath exports. This retains the actual third-party components and
all interaction assertions while avoiding unrelated components' eager static
style registration. Profiling the previous full-package import traced most of
the test execution time to jsdom `HTMLCollection` scans during dynamic CSS
registration. Keep tests focused on the dependencies they exercise; do not replace
those components with stand-ins merely to make integration tests faster.

Test debounce, retry, and timeout boundaries with controlled clocks. A real
filesystem observer, background thread, or `asyncio.sleep()` does not guarantee
when a callback will run. Live integration tests should wait for observable
completion with a bounded timeout, and assert delivery, content, and duplicate
handling. They should not infer timing guarantees from requested sleep durations.

The watcher tests separate these responsibilities: controlled time requires one
batch only after the last stable file's full debounce interval, while real
filesystem tests require exactly one delivery per file for both rapid and spaced
writes. Spaced writes may legitimately produce multiple batches.

When a check fails intermittently, retain the first failure and reproduce the
suspected scheduling or environment difference. A successful retry alone is not
evidence of a fix. Do not loosen assertions, skip checks, or add retries to hide
flakiness; move timing assertions to deterministic tests while retaining live
integration coverage.
