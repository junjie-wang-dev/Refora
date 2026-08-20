DROP TRIGGER IF EXISTS sync_outbox_validate_insert;
DROP TRIGGER IF EXISTS sync_outbox_validate_update;
DROP TRIGGER IF EXISTS sync_entity_versions_validate_insert;
DROP TRIGGER IF EXISTS sync_entity_versions_validate_update;
DROP TRIGGER IF EXISTS sync_conflicts_validate_insert;
DROP TRIGGER IF EXISTS sync_conflicts_validate_update;

DROP INDEX IF EXISTS idx_sync_outbox_pending;
DROP INDEX IF EXISTS idx_sync_conflicts_unresolved;

DROP TABLE IF EXISTS sync_outbox;
DROP TABLE IF EXISTS sync_entity_versions;
DROP TABLE IF EXISTS sync_conflicts;

ALTER TABLE sync_state RENAME TO sync_state_legacy;

CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  libraryId TEXT NOT NULL,
  remoteLibraryId TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updatedAt INTEGER NOT NULL DEFAULT 0
);

INSERT INTO sync_state (id, libraryId, remoteLibraryId, enabled, updatedAt)
SELECT id, libraryId, remoteLibraryId, enabled, updatedAt
FROM sync_state_legacy;

DROP TABLE sync_state_legacy;
