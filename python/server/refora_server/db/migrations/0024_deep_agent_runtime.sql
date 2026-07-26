ALTER TABLE chat_threads ADD COLUMN headCheckpointId TEXT;
ALTER TABLE chat_threads ADD COLUMN agentStateVersion INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_trace_steps ADD COLUMN parentStepId TEXT;
ALTER TABLE agent_trace_steps ADD COLUMN agentName TEXT;
ALTER TABLE agent_trace_steps ADD COLUMN namespace TEXT;
ALTER TABLE agent_trace_steps ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_trace_steps ADD COLUMN checkpointId TEXT;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  modelId TEXT NOT NULL,
  status TEXT NOT NULL,
  checkpointBefore TEXT,
  checkpointAfter TEXT,
  replacesRunId TEXT,
  userMessageId TEXT,
  assistantMessageId TEXT,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  error TEXT,
  FOREIGN KEY (threadId) REFERENCES chat_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (replacesRunId) REFERENCES agent_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (userMessageId) REFERENCES chat_messages(id) ON DELETE SET NULL,
  FOREIGN KEY (assistantMessageId) REFERENCES chat_messages(id) ON DELETE SET NULL
);
CREATE INDEX idx_agent_runs_thread ON agent_runs(threadId, startedAt);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);

CREATE TABLE workspace_agent_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'global')),
  scopeId TEXT NOT NULL,
  workspaceId TEXT,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  sourceThreadId TEXT,
  sourceRunId TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  UNIQUE(scope, scopeId, path),
  CHECK (
    (scope = 'workspace' AND workspaceId IS NOT NULL AND scopeId = workspaceId)
    OR (scope = 'global' AND workspaceId IS NULL AND scopeId = 'global')
  ),
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (sourceThreadId) REFERENCES chat_threads(id) ON DELETE SET NULL,
  FOREIGN KEY (sourceRunId) REFERENCES agent_runs(id) ON DELETE SET NULL
);
CREATE INDEX idx_workspace_agent_memories_scope ON workspace_agent_memories(scope, scopeId);

CREATE TABLE workspace_agent_memory_revisions (
  id TEXT PRIMARY KEY,
  memoryId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  sourceThreadId TEXT,
  sourceRunId TEXT,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (memoryId) REFERENCES workspace_agent_memories(id) ON DELETE CASCADE,
  FOREIGN KEY (sourceThreadId) REFERENCES chat_threads(id) ON DELETE SET NULL,
  FOREIGN KEY (sourceRunId) REFERENCES agent_runs(id) ON DELETE SET NULL,
  UNIQUE(memoryId, revision)
);

CREATE TABLE agent_interrupts (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  checkpointId TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  createdAt INTEGER NOT NULL,
  resolvedAt INTEGER,
  FOREIGN KEY (runId) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (threadId) REFERENCES chat_threads(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_interrupts_thread_status ON agent_interrupts(threadId, status);

CREATE TABLE agent_tool_effects (
  runId TEXT NOT NULL,
  toolCallId TEXT NOT NULL,
  toolName TEXT NOT NULL,
  workspaceId TEXT,
  status TEXT NOT NULL,
  result TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (runId, toolCallId),
  FOREIGN KEY (runId) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE SET NULL
);
