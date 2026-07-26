ALTER TABLE workspace_items ADD COLUMN x REAL NOT NULL DEFAULT 0;
ALTER TABLE workspace_items ADD COLUMN y REAL NOT NULL DEFAULT 0;
ALTER TABLE workspace_items ADD COLUMN zIndex INTEGER NOT NULL DEFAULT 0;

UPDATE workspace_items
SET
  x = (sortOrder % 4) * 332,
  y = CAST(sortOrder / 4 AS INTEGER) * 232,
  zIndex = sortOrder;

CREATE INDEX idx_workspace_items_canvas ON workspace_items(workspaceId, zIndex);

CREATE TABLE workspace_canvas_state (
  workspaceId TEXT PRIMARY KEY,
  panX REAL NOT NULL DEFAULT 0,
  panY REAL NOT NULL DEFAULT 0,
  zoom REAL NOT NULL DEFAULT 1 CHECK (zoom BETWEEN 0.25 AND 2.5),
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);
