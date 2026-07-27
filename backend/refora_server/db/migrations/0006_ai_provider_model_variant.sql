ALTER TABLE ai_providers ADD COLUMN baseModel TEXT;
ALTER TABLE ai_providers ADD COLUMN variant TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_providers ADD COLUMN variantFormat TEXT NOT NULL DEFAULT 'dash';

UPDATE ai_providers
SET baseModel = model
WHERE baseModel IS NULL OR baseModel = '';
