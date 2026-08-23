CREATE TABLE IF NOT EXISTS legacy_document_id_repair_candidates (
  documentId TEXT PRIMARY KEY,
  FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO legacy_document_id_repair_candidates(documentId)
SELECT id
FROM documents
WHERE id = ''
  OR length(id) > 128
  OR substr(id, 1, 1) NOT GLOB '[A-Za-z0-9]'
  OR id GLOB '*[^A-Za-z0-9._:-]*';

CREATE TABLE IF NOT EXISTS legacy_chat_terminal_cleanup (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

INSERT OR IGNORE INTO legacy_chat_terminal_cleanup(id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_agent_runs_assistant_message
ON agent_runs(assistantMessageId);
