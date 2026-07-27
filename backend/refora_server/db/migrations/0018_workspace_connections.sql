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

CREATE INDEX idx_workspace_connections_workspace ON workspace_connections(workspaceId, createdAt);
