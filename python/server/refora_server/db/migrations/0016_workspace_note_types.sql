ALTER TABLE workspace_notes
ADD COLUMN noteType TEXT NOT NULL DEFAULT 'markdown'
CHECK (noteType IN ('markdown', 'plain'));
