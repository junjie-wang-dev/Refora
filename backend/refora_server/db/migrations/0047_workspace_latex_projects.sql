CREATE TABLE IF NOT EXISTS workspace_latex_projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  rootFile TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_latex_projects_ws ON workspace_latex_projects(workspaceId);

CREATE TEMP TABLE workspace_connections_v47 AS
SELECT id, workspaceId, sourceItemId, targetItemId, sourceAnchor, targetAnchor, createdAt
FROM workspace_connections;

DROP TABLE workspace_connections;

CREATE TABLE workspace_items_v47 (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'report', 'note', 'asset', 'latex')),
  docId TEXT,
  reportId TEXT,
  noteId TEXT,
  assetId TEXT,
  latexId TEXT,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 300 CHECK (width > 0),
  height INTEGER NOT NULL DEFAULT 200 CHECK (height > 0),
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  zIndex INTEGER NOT NULL DEFAULT 0,
  addedAt INTEGER NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (docId) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (reportId) REFERENCES ai_reports(id) ON DELETE CASCADE,
  FOREIGN KEY (noteId) REFERENCES workspace_notes(id) ON DELETE CASCADE,
  FOREIGN KEY (assetId) REFERENCES workspace_assets(id) ON DELETE CASCADE,
  FOREIGN KEY (latexId) REFERENCES workspace_latex_projects(id) ON DELETE CASCADE,
  CHECK (
    (kind = 'document' AND docId IS NOT NULL AND reportId IS NULL AND noteId IS NULL AND assetId IS NULL AND latexId IS NULL) OR
    (kind = 'report' AND docId IS NULL AND reportId IS NOT NULL AND noteId IS NULL AND assetId IS NULL AND latexId IS NULL) OR
    (kind = 'note' AND docId IS NULL AND reportId IS NULL AND noteId IS NOT NULL AND assetId IS NULL AND latexId IS NULL) OR
    (kind = 'asset' AND docId IS NULL AND reportId IS NULL AND noteId IS NULL AND assetId IS NOT NULL AND latexId IS NULL) OR
    (kind = 'latex' AND docId IS NULL AND reportId IS NULL AND noteId IS NULL AND assetId IS NULL AND latexId IS NOT NULL)
  )
);

INSERT INTO workspace_items_v47
  (id, workspaceId, kind, docId, reportId, noteId, assetId, sortOrder, width, height, x, y, zIndex, addedAt)
SELECT id, workspaceId, kind, docId, reportId, noteId, assetId, sortOrder, width, height, x, y, zIndex, addedAt
FROM workspace_items;

DROP TABLE workspace_items;
ALTER TABLE workspace_items_v47 RENAME TO workspace_items;

CREATE INDEX idx_workspace_items_ws ON workspace_items(workspaceId);
CREATE INDEX idx_workspace_items_canvas ON workspace_items(workspaceId, zIndex);
CREATE UNIQUE INDEX uq_workspace_items_document ON workspace_items(workspaceId, docId) WHERE kind = 'document';
CREATE UNIQUE INDEX uq_workspace_items_report ON workspace_items(workspaceId, reportId) WHERE kind = 'report';
CREATE UNIQUE INDEX uq_workspace_items_note ON workspace_items(workspaceId, noteId) WHERE kind = 'note';
CREATE UNIQUE INDEX uq_workspace_items_asset ON workspace_items(workspaceId, assetId) WHERE kind = 'asset';
CREATE UNIQUE INDEX uq_workspace_items_latex ON workspace_items(workspaceId, latexId) WHERE kind = 'latex';

CREATE TABLE workspace_connections (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  sourceItemId TEXT NOT NULL,
  targetItemId TEXT NOT NULL,
  sourceAnchor TEXT NOT NULL CHECK (sourceAnchor IN ('top', 'right', 'bottom', 'left')),
  targetAnchor TEXT NOT NULL CHECK (targetAnchor IN ('top', 'right', 'bottom', 'left')),
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (sourceItemId) REFERENCES workspace_items(id) ON DELETE CASCADE,
  FOREIGN KEY (targetItemId) REFERENCES workspace_items(id) ON DELETE CASCADE,
  CHECK (sourceItemId <> targetItemId),
  UNIQUE (workspaceId, sourceItemId, targetItemId)
);

INSERT INTO workspace_connections
  (id, workspaceId, sourceItemId, targetItemId, sourceAnchor, targetAnchor, createdAt)
SELECT id, workspaceId, sourceItemId, targetItemId, sourceAnchor, targetAnchor, createdAt
FROM workspace_connections_v47;

DROP TABLE workspace_connections_v47;
CREATE INDEX idx_workspace_connections_workspace ON workspace_connections(workspaceId, createdAt);
