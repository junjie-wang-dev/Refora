CREATE TABLE IF NOT EXISTS workspace_notes (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  title TEXT NOT NULL,
  contentMd TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_notes_ws ON workspace_notes(workspaceId);

CREATE TABLE workspace_items_v14 (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'report', 'note')),
  docId TEXT,
  reportId TEXT,
  noteId TEXT,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 300 CHECK (width BETWEEN 220 AND 640),
  height INTEGER NOT NULL DEFAULT 200 CHECK (height BETWEEN 140 AND 520),
  addedAt INTEGER NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (docId) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (reportId) REFERENCES ai_reports(id) ON DELETE CASCADE,
  FOREIGN KEY (noteId) REFERENCES workspace_notes(id) ON DELETE CASCADE,
  CHECK (
    (kind = 'document' AND docId IS NOT NULL AND reportId IS NULL AND noteId IS NULL) OR
    (kind = 'report' AND docId IS NULL AND reportId IS NOT NULL AND noteId IS NULL) OR
    (kind = 'note' AND docId IS NULL AND reportId IS NULL AND noteId IS NOT NULL)
  )
);

INSERT INTO workspace_items_v14 (id, workspaceId, kind, docId, reportId, noteId, sortOrder, width, height, addedAt)
SELECT wi.id, wi.workspaceId, 'document', wi.docId, NULL, NULL, wi.sortOrder, 300, 200, wi.addedAt
FROM workspace_items wi
JOIN documents d ON d.id = wi.docId
WHERE wi.kind = 'document'
  AND wi.id = (
    SELECT wi2.id
    FROM workspace_items wi2
    WHERE wi2.workspaceId = wi.workspaceId AND wi2.kind = 'document' AND wi2.docId = wi.docId
    ORDER BY wi2.sortOrder, wi2.addedAt, wi2.id
    LIMIT 1
  );

INSERT INTO workspace_items_v14 (id, workspaceId, kind, docId, reportId, noteId, sortOrder, width, height, addedAt)
SELECT wi.id, wi.workspaceId, 'report', NULL, wi.reportId, NULL, wi.sortOrder, 300, 200, wi.addedAt
FROM workspace_items wi
JOIN ai_reports r ON r.id = wi.reportId AND r.workspaceId = wi.workspaceId
WHERE wi.kind = 'report'
  AND wi.id = (
    SELECT wi2.id
    FROM workspace_items wi2
    WHERE wi2.workspaceId = wi.workspaceId AND wi2.kind = 'report' AND wi2.reportId = wi.reportId
    ORDER BY wi2.sortOrder, wi2.addedAt, wi2.id
    LIMIT 1
  );

INSERT INTO workspace_items_v14 (id, workspaceId, kind, docId, reportId, noteId, sortOrder, width, height, addedAt)
SELECT
  lower(hex(randomblob(16))),
  r.workspaceId,
  'report',
  NULL,
  r.id,
  NULL,
  (SELECT COALESCE(MAX(wi.sortOrder), -1) FROM workspace_items_v14 wi WHERE wi.workspaceId = r.workspaceId)
    + ROW_NUMBER() OVER (PARTITION BY r.workspaceId ORDER BY r.createdAt, r.id),
  300,
  200,
  r.createdAt
FROM ai_reports r
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_items_v14 wi WHERE wi.kind = 'report' AND wi.reportId = r.id
);

DROP TABLE workspace_items;
ALTER TABLE workspace_items_v14 RENAME TO workspace_items;

CREATE INDEX idx_workspace_items_ws ON workspace_items(workspaceId);
CREATE UNIQUE INDEX uq_workspace_items_document ON workspace_items(workspaceId, docId) WHERE kind = 'document';
CREATE UNIQUE INDEX uq_workspace_items_report ON workspace_items(workspaceId, reportId) WHERE kind = 'report';
CREATE UNIQUE INDEX uq_workspace_items_note ON workspace_items(workspaceId, noteId) WHERE kind = 'note';
