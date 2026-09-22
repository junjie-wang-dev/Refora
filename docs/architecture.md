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

The full local pipeline runs in a fresh temporary checkout:

```sh
npm run ci:local
npm run ci:local -- --working-tree
```

The first command requires a clean checkout and validates the current commit.
The second explicitly snapshots tracked changes and non-ignored new files without
committing them; its result is labelled `working-tree`, not a tested GitHub commit.
Neither mode reuses `node_modules`, the Python virtual environment, build output,
or ignored `.env` files from the working directory. A failed checkout is retained
for diagnosis; a successful checkout is removed after evidence and DMGs are copied.

Both local and GitHub jobs use `scripts/ci.mjs` via `npm run ci:stage -- <stages>`.
The full sequence is `prepare verify audit stability database e2e package`.
`prepare` installs with `npm ci` and `uv sync --locked`; `verify` includes runner
regression tests, type checks, lint, frontend coverage, backend tests, Python source
compilation, and the sidecar integration test. Stability checks run the focused
regression suites three times, stopping on the first failure. Playwright retries
are disabled. A skipped or missing gate cannot produce full-pipeline success.

Tool versions are pinned by `.nvmrc`, `package.json`, `.uv-version`,
`backend/.python-version`, and `.postgres-version`. The runner checks Node/npm/uv
versions, selects the pinned Python, and sets `CI=true`, `TZ=UTC`, and
`PYTHONHASHSEED=0`. It removes inherited interpreter overrides such as
`PYTHONPATH`, `VIRTUAL_ENV`, and `NODE_OPTIONS`. OS build and architecture are
recorded; local macOS and GitHub's macOS image are not claimed to be identical.

The local database gate automatically provisions an isolated PostgreSQL 17.6
container when Docker is running. Alternatively set `REFORA_POSTGRES_BIN` to a
directory containing PostgreSQL 17.6 `postgres`, `initdb`, `pg_ctl`, and `createdb`;
a fresh temporary cluster is created and removed by the gate. Nothing is skipped
when the database prerequisite is absent: the pipeline fails with setup guidance.
GitHub uses the matching PostgreSQL service and the same test entry point.
An externally supplied `REFORA_SUPABASE_TEST_DB_URL` and
`REFORA_SUPABASE_TEST_DB_PASSWORD` must refer to an empty disposable database:
the suite applies bootstrap SQL and all migrations. Never use production data.

Local evidence is stored under `test-results/ci/local-<timestamp>/`, including the
source snapshot hash, commit, actual tool versions, OS/CPU details, per-command
logs, `result.json`, and `summary.md`. Each command records status, duration, exit
code, and signal; later commands stay `not_run` after a failure. E2E traces,
screenshots, HTML/JUnit reports, and coverage are retained. GitHub uploads the
available evidence with `if: always()` and names artifacts by run attempt, so a
retry does not replace the first failure. Do not dump environment variables or
credentials into diagnostics.

During local execution, CI evidence is first written inside the temporary checkout
using the same default directory as GitHub, then copied back after execution.
Playwright owns only `test-results/playwright/`; its automatic cleanup must never
remove the sibling `test-results/ci/` reports. The runner regression suite executes
real Playwright cleanup and checks that CI results and command logs survive.

CI's `CI Ready` job runs even when dependencies fail and requires both the complete
quality workflow and packaging to succeed. The main-branch ruleset should require
pull requests, up-to-date branches, no force pushes/deletions, and the required
checks. Configure GitHub rules separately from workflow files: committing a YAML
file alone does not activate repository protection. Require the individual existing
checks until `CI Ready` has first appeared on GitHub, then also require `CI Ready`.
Do not claim GitHub verification until that exact pushed commit has passed there.

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
