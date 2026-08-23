CREATE TABLE IF NOT EXISTS ai_report_sources (
  reportId TEXT NOT NULL,
  docId TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (reportId, docId),
  FOREIGN KEY (reportId) REFERENCES ai_reports(id) ON DELETE CASCADE,
  FOREIGN KEY (docId) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_report_sources_ordinal
ON ai_report_sources(reportId, ordinal);

CREATE INDEX IF NOT EXISTS idx_ai_report_sources_document
ON ai_report_sources(docId);
