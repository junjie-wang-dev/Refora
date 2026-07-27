CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_items (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  kind TEXT NOT NULL,
  docId TEXT,
  reportId TEXT,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  addedAt INTEGER NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspace_items_ws ON workspace_items(workspaceId);

CREATE TABLE IF NOT EXISTS ai_summaries (
  docId TEXT PRIMARY KEY,
  model TEXT,
  summaryJson TEXT,
  fullText TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_reports (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  title TEXT NOT NULL,
  contentMd TEXT NOT NULL,
  sourceDocIds TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_reports_ws ON ai_reports(workspaceId);

CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_ws ON chat_threads(workspaceId);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (threadId) REFERENCES chat_threads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(threadId);

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  baseUrl TEXT NOT NULL,
  model TEXT NOT NULL,
  apiKeyEnc BLOB,
  createdAt INTEGER NOT NULL
);
