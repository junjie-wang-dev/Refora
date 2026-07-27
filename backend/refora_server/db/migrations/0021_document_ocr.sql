CREATE TABLE IF NOT EXISTS document_ocr_jobs (
  id TEXT PRIMARY KEY,
  documentId TEXT NOT NULL,
  resultKey TEXT NOT NULL,
  sourceHash TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('compatible', 'balanced', 'quality')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  stage TEXT NOT NULL CHECK (stage IN ('queued', 'startingWorker', 'loadingModels', 'parsing', 'writingResults', 'validating', 'completed')),
  progress REAL,
  errorCode TEXT,
  errorMessage TEXT,
  createdAt INTEGER NOT NULL,
  startedAt INTEGER,
  finishedAt INTEGER,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_ocr_jobs_document ON document_ocr_jobs(documentId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_document_ocr_jobs_status ON document_ocr_jobs(status, updatedAt);

CREATE TABLE IF NOT EXISTS document_ocr_results (
  id TEXT PRIMARY KEY,
  documentId TEXT NOT NULL,
  resultKey TEXT NOT NULL,
  sourceHash TEXT NOT NULL,
  mineruVersion TEXT NOT NULL,
  modelRevision TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('compatible', 'balanced', 'quality')),
  optionsHash TEXT NOT NULL,
  schemaVersion INTEGER NOT NULL,
  relativeRoot TEXT NOT NULL,
  markdownRelativePath TEXT NOT NULL,
  blocksRelativePath TEXT NOT NULL,
  manifestRelativePath TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE,
  UNIQUE (documentId, resultKey)
);

CREATE INDEX IF NOT EXISTS idx_document_ocr_results_document ON document_ocr_results(documentId, createdAt DESC);
