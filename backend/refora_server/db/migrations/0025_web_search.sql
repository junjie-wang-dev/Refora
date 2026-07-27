CREATE TABLE IF NOT EXISTS web_search_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'disabled'
    CHECK (provider IN ('disabled', 'ddgs', 'tavily', 'brave')),
  tavilyApiKeyEnc BLOB,
  braveApiKeyEnc BLOB,
  updatedAt INTEGER NOT NULL
);

INSERT OR IGNORE INTO web_search_config (
  id,
  provider,
  tavilyApiKeyEnc,
  braveApiKeyEnc,
  updatedAt
) VALUES (1, 'disabled', NULL, NULL, 0);
