# Supabase metadata sync

This phase uses Supabase Auth and Postgres only. Supabase Storage is not used. PDFs, OCR output, extracted full text, thumbnails, search indexes, AI credentials, runtime traces, and other rebuildable artifacts stay outside Supabase.

## Runtime configuration

Copy `.env.example` to `.env.local` and set these values before starting or packaging Refora:

```text
REFORA_SUPABASE_URL=https://PROJECT_REF.supabase.co
REFORA_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

The main-process build embeds these public client values. Runtime environment values override the embedded values for development and diagnostics. If either value is missing or invalid, the Account & Sync settings page reports that sync is unavailable. A publishable key is intended for desktop clients. Never put a Supabase secret key or service-role key in Refora.

The remote migration workflow is pinned to Supabase CLI `2.115.0` on macOS. Install that version, run `supabase login`, and link the checkout with `supabase link --project-ref PROJECT_REF`. Then use:

```text
npm run supabase:migrations
npm run supabase:push:dry-run
npm run supabase:push
npm run supabase:test
```

The helper uses a short-lived database role through the linked project's pooler because no permanent database password is stored in the repository. Supabase CLI requires that temporary role to assume its migration role even for listing and dry runs; the credential is requested immediately before each command and is not persisted. Its password is passed through `PGPASSWORD`, not a process argument. Apply every file in `supabase/migrations/` in filename order and never rewrite a migration that has reached a project.

## Email confirmation redirect

Refora requests `refora://auth/confirmed` as the post-confirmation redirect. The packaged macOS app registers the `refora` URL scheme and opens the account window with a success or failure result. Callback tokens are not logged or exposed to the renderer.

Configure the Supabase project before testing email confirmation:

1. Open Authentication → URL Configuration.
2. Add `refora://auth/confirmed` to Additional Redirect URLs.
3. Keep Site URL set to a valid deployed HTTPS page if the project also serves a web app. Do not leave it at an unavailable localhost address.
4. Open Authentication → Email Templates → Confirm signup and make sure the button uses `{{ .ConfirmationURL }}`.

The redirect scheme is present in packaged builds. For an end-to-end macOS callback test, run `npm run package`, install or launch the generated Refora app, then request a fresh confirmation email. Previously generated emails keep their original redirect destination.

The checked-in local Supabase configuration also enables email confirmation and allows `refora://auth/confirmed`, so local Auth responses follow the same confirmation-required branch as production. The custom scheme itself still requires a packaged app for a full macOS callback test.

## Google and Apple sign-in

Refora starts Google and Apple sign-in in the system browser using Supabase Auth's PKCE flow. The main process generates and retains the verifier, exchanges the returned authorization code, and stores the resulting Supabase session with macOS `safeStorage`; OAuth codes and tokens are never exposed to the renderer.

Before testing either provider:

1. Keep `refora://auth/confirmed` in Authentication → URL Configuration → Additional Redirect URLs.
2. Enable Google or Apple under Authentication → Providers and add that provider's client ID and secret.
3. In the Google Cloud console, register `https://PROJECT_REF.supabase.co/auth/v1/callback` as an authorized redirect URI.
4. For Apple web OAuth, configure a Services ID and register `https://PROJECT_REF.supabase.co/auth/v1/callback` as its return URL. Apple client secrets must be rotated before their six-month expiry.

The checked-in `supabase/config.toml` keeps both social providers disabled because their client IDs and secrets are deployment-specific. For local Supabase testing, enable the relevant block locally and supply its secret through the referenced environment variable; never commit provider secrets.

## Current implementation boundary

This build implements Supabase account registration, email confirmation, password sign-in, Google and Apple sign-in, encrypted session storage, sign-out, and the local/cloud database foundations.

Signing in and signing up use Supabase Auth. Refora stores the encrypted account session locally, refreshes expiring access tokens, and does not create a cloud library, register a device, enqueue metadata, upload library content, or call a sync RPC. The per-library `sync_state.enabled` value defaults to `0`, so each SQLite library has an independent, opt-in consent boundary when the engine is implemented. Account IPC is independent from the Python sidecar, and the account window remains available in database recovery mode.

The allowlisted entity types are:

- `document_user_data`
- `category`
- `document_category`
- `workspace`
- `workspace_note`
- `workspace_layout`
- `workspace_connection`
- `pdf_annotation`
- `agent_memory`

The cloud push function also enforces a payload-key allowlist for every entity type. `document_user_data` can contain only notes, starred/read state, and explicitly edited bibliographic fields. `pdf_annotation` can contain only the annotation document and its timestamp. Workspace entities can contain their own names, notes, canvas geometry, and connections, but not AI reports or workspace asset contents. Agent memory can contain its memory content and revision metadata, but never provider credentials, chat traces, or runtime state. Document user data and annotations use the lowercase SHA-256 PDF hash as the entity ID so independently imported copies can converge across devices.

The library SQLite database stores only the stable local/remote library identity and its opt-in flag. It must not store device identity, cursors, delivery attempts, or outbox worker state because a selected library directory may itself be on a cloud-synchronized volume. The future engine must keep device identity and delivery state under the app's device-local `userData` directory. Before enabling API synchronization, each device must also use its own local working database; PDF/attachment directories and immutable database snapshots may remain on a cloud drive, but the same live SQLite file must not be concurrently opened through file-level cloud synchronization.

Entity adapters must only enqueue allowlisted, non-rebuildable fields after checking the per-library enabled state. A UI state must never report synchronization as active until the worker is running and has successfully registered the active remote library and device.

## Cloud access model

Cloud tables are in the non-exposed `refora_sync` schema. Direct access is revoked from anonymous and authenticated clients, and row-level security is enabled as defense in depth. Authenticated desktop clients can only call the explicitly granted `refora_sync_*` functions. Those functions validate `auth.uid()`, library ownership, device ownership, entity type, version, cursor, and pagination bounds. Library discovery returns only the current user's libraries, and library deletion is owner-scoped and cascades through that library's sync data.

Pushes use an operation UUID for 24-hour idempotency and an expected base version for conflict detection. Reusing an operation UUID with different request data is rejected. Conflict results contain version, sequence, and deletion state but never duplicate the entity payload; clients obtain the authoritative value through pull. Pulls page by a per-library monotonic sequence, and clients cannot save a cursor beyond the current library sequence. The entity table stores current state and payload-free tombstones, not a permanent event history.

Server-enforced limits protect a small Supabase project from an authenticated client exhausting the database: 20 libraries and 20 devices per account, 100,000 entities and 32 MiB of JSON payload per library, 200,000 entities and 64 MiB of JSON payload across an account, and 20,000 live idempotency records per account. Each entity payload is limited to 1 MiB and every stored operation result to 4 KiB. These are safety ceilings rather than expected usage; ordinary metadata-only libraries should remain far below them.

The integration suite in `scripts/test-supabase-rpc.py` executes the real PostgreSQL RPCs inside a rolled-back transaction with two temporary authenticated identities. It verifies ownership isolation, direct-table denial, internal-function denial, push idempotency, stale-version conflicts, compact conflict records, expiry, and cross-user pull denial. Run it after every remote migration with `npm run supabase:test`.
