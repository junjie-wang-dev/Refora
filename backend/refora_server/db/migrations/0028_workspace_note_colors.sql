ALTER TABLE workspace_notes
ADD COLUMN color TEXT NOT NULL DEFAULT 'sand'
CHECK (color IN ('sand', 'lemon', 'coral', 'rose', 'mint', 'sky', 'lavender', 'slate'));
