ALTER TABLE chat_messages ADD COLUMN media TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_trace_steps ADD COLUMN result TEXT;

CREATE TRIGGER agent_trace_result_revision_update
AFTER UPDATE OF result ON agent_trace_steps
BEGIN
  UPDATE agent_trace_clock SET revision = revision + 1 WHERE id = 1;
  UPDATE agent_trace_steps SET revision = (SELECT revision FROM agent_trace_clock WHERE id = 1)
  WHERE id = NEW.id;
END;
