CREATE TABLE IF NOT EXISTS agent_trace_steps (
  id TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  runId TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  input TEXT,
  output TEXT,
  status TEXT NOT NULL,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  seq INTEGER NOT NULL,
  FOREIGN KEY (threadId) REFERENCES chat_threads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_trace_steps_thread ON agent_trace_steps(threadId);
CREATE INDEX IF NOT EXISTS idx_agent_trace_steps_run ON agent_trace_steps(runId);
