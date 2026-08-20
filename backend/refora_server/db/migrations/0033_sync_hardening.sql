ALTER TABLE sync_state
ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1));

UPDATE sync_outbox
SET status = 'pending', updatedAt = MAX(updatedAt, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE status = 'sending';

CREATE TRIGGER sync_outbox_validate_insert
BEFORE INSERT ON sync_outbox
WHEN length(new.entityId) NOT BETWEEN 1 AND 200
  OR length(CAST(new.payloadJson AS BLOB)) > 1048576
  OR (new.operation = 'delete' AND json(new.payloadJson) <> '{}')
BEGIN
  SELECT RAISE(ABORT, 'invalid sync outbox entry');
END;

CREATE TRIGGER sync_outbox_validate_update
BEFORE UPDATE ON sync_outbox
WHEN length(new.entityId) NOT BETWEEN 1 AND 200
  OR length(CAST(new.payloadJson AS BLOB)) > 1048576
  OR (new.operation = 'delete' AND json(new.payloadJson) <> '{}')
BEGIN
  SELECT RAISE(ABORT, 'invalid sync outbox entry');
END;

CREATE TRIGGER sync_entity_versions_validate_insert
BEFORE INSERT ON sync_entity_versions
WHEN new.entityType NOT IN (
  'document_user_data',
  'category',
  'document_category',
  'workspace',
  'workspace_note',
  'workspace_layout',
  'workspace_connection',
  'pdf_annotation',
  'agent_memory'
) OR length(new.entityId) NOT BETWEEN 1 AND 200
BEGIN
  SELECT RAISE(ABORT, 'invalid sync entity version');
END;

CREATE TRIGGER sync_entity_versions_validate_update
BEFORE UPDATE ON sync_entity_versions
WHEN new.entityType NOT IN (
  'document_user_data',
  'category',
  'document_category',
  'workspace',
  'workspace_note',
  'workspace_layout',
  'workspace_connection',
  'pdf_annotation',
  'agent_memory'
) OR length(new.entityId) NOT BETWEEN 1 AND 200
BEGIN
  SELECT RAISE(ABORT, 'invalid sync entity version');
END;

CREATE TRIGGER sync_conflicts_validate_insert
BEFORE INSERT ON sync_conflicts
WHEN new.entityType NOT IN (
  'document_user_data',
  'category',
  'document_category',
  'workspace',
  'workspace_note',
  'workspace_layout',
  'workspace_connection',
  'pdf_annotation',
  'agent_memory'
) OR length(new.entityId) NOT BETWEEN 1 AND 200
  OR length(CAST(new.localPayloadJson AS BLOB)) > 1048576
  OR length(CAST(new.remotePayloadJson AS BLOB)) > 1048576
BEGIN
  SELECT RAISE(ABORT, 'invalid sync conflict');
END;

CREATE TRIGGER sync_conflicts_validate_update
BEFORE UPDATE ON sync_conflicts
WHEN new.entityType NOT IN (
  'document_user_data',
  'category',
  'document_category',
  'workspace',
  'workspace_note',
  'workspace_layout',
  'workspace_connection',
  'pdf_annotation',
  'agent_memory'
) OR length(new.entityId) NOT BETWEEN 1 AND 200
  OR length(CAST(new.localPayloadJson AS BLOB)) > 1048576
  OR length(CAST(new.remotePayloadJson AS BLOB)) > 1048576
BEGIN
  SELECT RAISE(ABORT, 'invalid sync conflict');
END;
