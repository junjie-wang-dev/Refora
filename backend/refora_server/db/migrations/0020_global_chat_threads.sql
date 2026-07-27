CREATE TABLE chat_threads_new (
  id TEXT PRIMARY KEY,
  workspaceId TEXT,
  providerId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  title TEXT,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

INSERT INTO chat_threads_new (id, workspaceId, providerId, createdAt, title)
SELECT id, workspaceId, providerId, createdAt, title FROM chat_threads;

CREATE TABLE chat_messages_new (
  id TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (threadId) REFERENCES chat_threads_new(id) ON DELETE CASCADE
);

INSERT INTO chat_messages_new (id, threadId, role, content, createdAt)
SELECT id, threadId, role, content, createdAt FROM chat_messages;

CREATE TABLE agent_trace_steps_new (
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
  inputTokens INTEGER,
  outputTokens INTEGER,
  totalTokens INTEGER,
  FOREIGN KEY (threadId) REFERENCES chat_threads_new(id) ON DELETE CASCADE
);

INSERT INTO agent_trace_steps_new (
  id, threadId, runId, kind, name, input, output, status, startedAt, endedAt, seq,
  inputTokens, outputTokens, totalTokens
)
SELECT
  id, threadId, runId, kind, name, input, output, status, startedAt, endedAt, seq,
  inputTokens, outputTokens, totalTokens
FROM agent_trace_steps;

DROP TABLE chat_messages;
DROP TABLE agent_trace_steps;
DROP TABLE chat_threads;

ALTER TABLE chat_threads_new RENAME TO chat_threads;
ALTER TABLE chat_messages_new RENAME TO chat_messages;
ALTER TABLE agent_trace_steps_new RENAME TO agent_trace_steps;

CREATE INDEX idx_chat_threads_ws ON chat_threads(workspaceId);
CREATE INDEX idx_chat_messages_thread ON chat_messages(threadId);
CREATE INDEX idx_agent_trace_steps_thread ON agent_trace_steps(threadId);
CREATE INDEX idx_agent_trace_steps_run ON agent_trace_steps(runId);
