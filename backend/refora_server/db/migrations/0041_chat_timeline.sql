ALTER TABLE chat_messages ADD COLUMN displayContent TEXT;
ALTER TABLE chat_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE chat_messages ADD COLUMN activeDocumentId TEXT;

ALTER TABLE agent_trace_steps ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
UPDATE agent_trace_steps SET revision = rowid;

CREATE TABLE agent_trace_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
INSERT INTO agent_trace_clock (id, revision)
SELECT 1, COALESCE(MAX(revision), 0) FROM agent_trace_steps;

CREATE TRIGGER agent_trace_revision_insert AFTER INSERT ON agent_trace_steps
BEGIN
  UPDATE agent_trace_clock SET revision = revision + 1 WHERE id = 1;
  UPDATE agent_trace_steps SET revision = (SELECT revision FROM agent_trace_clock WHERE id = 1)
  WHERE id = NEW.id;
END;

CREATE TRIGGER agent_trace_revision_update
AFTER UPDATE OF input, output, status, endedAt, inputTokens, outputTokens, totalTokens,
parentStepId, agentName, namespace, depth, checkpointId ON agent_trace_steps
BEGIN
  UPDATE agent_trace_clock SET revision = revision + 1 WHERE id = 1;
  UPDATE agent_trace_steps SET revision = (SELECT revision FROM agent_trace_clock WHERE id = 1)
  WHERE id = NEW.id;
END;

CREATE INDEX idx_agent_traces_run_revision ON agent_trace_steps(runId, revision);
CREATE INDEX idx_chat_messages_thread_timeline ON chat_messages(threadId, createdAt);
CREATE INDEX idx_agent_runs_user_message ON agent_runs(userMessageId);
