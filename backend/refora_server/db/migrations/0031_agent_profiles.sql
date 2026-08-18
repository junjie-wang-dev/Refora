CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('api', 'cli')),
  apiProviderId TEXT,
  cliRuntimeId TEXT,
  executablePath TEXT,
  model TEXT NOT NULL DEFAULT '',
  reasoningEffort TEXT NOT NULL DEFAULT 'medium',
  nativeWebSearch INTEGER NOT NULL DEFAULT 0,
  webSearchPolicy TEXT NOT NULL DEFAULT 'auto' CHECK (webSearchPolicy IN ('auto', 'native', 'refora', 'disabled')),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  CHECK (
    (kind = 'api' AND apiProviderId IS NOT NULL AND cliRuntimeId IS NULL)
    OR (kind = 'cli' AND apiProviderId IS NULL AND cliRuntimeId IS NOT NULL)
  ),
  FOREIGN KEY (apiProviderId) REFERENCES ai_providers(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_profiles_kind ON agent_profiles(kind, createdAt);
CREATE UNIQUE INDEX idx_agent_profiles_api_provider ON agent_profiles(apiProviderId) WHERE apiProviderId IS NOT NULL;

INSERT INTO agent_profiles (
  id, name, kind, apiProviderId, cliRuntimeId, executablePath, model,
  reasoningEffort, nativeWebSearch, webSearchPolicy, createdAt, updatedAt
)
SELECT
  'api-' || id, name, 'api', id, NULL, NULL, model,
  reasoningEffort, 0, 'auto', createdAt, createdAt
FROM ai_providers;

ALTER TABLE chat_threads ADD COLUMN agentProfileId TEXT;
UPDATE chat_threads SET agentProfileId = 'api-' || providerId;

ALTER TABLE agent_runs ADD COLUMN agentProfileId TEXT;
ALTER TABLE agent_runs ADD COLUMN runtimeSessionId TEXT;
UPDATE agent_runs SET agentProfileId = 'api-' || providerId;

CREATE TABLE agent_runtime_sessions (
  threadId TEXT NOT NULL,
  agentProfileId TEXT NOT NULL,
  runtimeId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (threadId, agentProfileId, runtimeId),
  FOREIGN KEY (threadId) REFERENCES chat_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (agentProfileId) REFERENCES agent_profiles(id) ON DELETE CASCADE
);
