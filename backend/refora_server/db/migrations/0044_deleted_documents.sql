CREATE TABLE IF NOT EXISTS deleted_documents (
  id TEXT PRIMARY KEY,
  deletedAt INTEGER NOT NULL,
  payloadJson TEXT NOT NULL
);
