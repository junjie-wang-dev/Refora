CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  libraryId TEXT NOT NULL,
  remoteLibraryId TEXT,
  deviceId TEXT,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  lastPushAt INTEGER,
  lastPullAt INTEGER,
  lastError TEXT,
  updatedAt INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_state (id, libraryId)
VALUES (
  1,
  lower(hex(randomblob(4))) || '-' ||
  lower(hex(randomblob(2))) || '-' ||
  lower(hex(randomblob(2))) || '-' ||
  lower(hex(randomblob(2))) || '-' ||
  lower(hex(randomblob(6)))
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  operationId TEXT PRIMARY KEY,
  entityType TEXT NOT NULL CHECK (entityType IN (
    'document_user_data',
    'category',
    'document_category',
    'workspace',
    'workspace_note',
    'workspace_layout',
    'workspace_connection',
    'pdf_annotation',
    'agent_memory'
  )),
  entityId TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  baseVersion INTEGER NOT NULL DEFAULT 0 CHECK (baseVersion >= 0),
  payloadJson TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payloadJson)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lastError TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
ON sync_outbox(status, createdAt);

CREATE TABLE IF NOT EXISTS sync_entity_versions (
  entityType TEXT NOT NULL,
  entityId TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (entityType, entityId)
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  entityType TEXT NOT NULL,
  entityId TEXT NOT NULL,
  localPayloadJson TEXT NOT NULL CHECK (json_valid(localPayloadJson)),
  remotePayloadJson TEXT NOT NULL CHECK (json_valid(remotePayloadJson)),
  remoteVersion INTEGER NOT NULL CHECK (remoteVersion >= 0),
  createdAt INTEGER NOT NULL,
  resolvedAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_unresolved
ON sync_conflicts(resolvedAt, createdAt);
