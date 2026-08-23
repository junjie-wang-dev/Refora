# Historical Code Review Audit

**Status:** Superseded. This July 2026 snapshot is retained only as historical context and is not an active engineering backlog.

The prior report referenced components and services that no longer exist, including `TopBar.tsx`, `CategoryDialog.tsx`, `WatchFoldersSettings.tsx`, the old main-process importer/files services, and the legacy agent sandbox. Its line numbers, issue counts, and proposed fixes must not be used for current implementation work.

Current review and verification should be based on the live repository, focused tests, and the required gate:

```sh
npm run typecheck && npm run lint && npm run test
```

For backend changes, additionally run the relevant `backend/tests` coverage through `npm run test:backend`. CI and release workflows enforce the same verification, integration, E2E, dependency-audit, and Supabase checks.
