CREATE TABLE ai_summaries_replacement (
  docId TEXT PRIMARY KEY,
  model TEXT,
  summaryJson TEXT,
  fullText TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  fullTextHash TEXT,
  FOREIGN KEY (docId) REFERENCES documents(id) ON DELETE CASCADE
);

INSERT INTO ai_summaries_replacement(
  docId, model, summaryJson, fullText, createdAt, updatedAt, fullTextHash
)
SELECT
  summaries.docId,
  summaries.model,
  summaries.summaryJson,
  summaries.fullText,
  summaries.createdAt,
  summaries.updatedAt,
  summaries.fullTextHash
FROM ai_summaries AS summaries
JOIN documents ON documents.id = summaries.docId;

DROP TABLE ai_summaries;
ALTER TABLE ai_summaries_replacement RENAME TO ai_summaries;
