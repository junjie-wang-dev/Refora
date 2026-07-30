ALTER TABLE agent_runs ADD COLUMN activeDocumentId TEXT REFERENCES documents(id) ON DELETE SET NULL;
