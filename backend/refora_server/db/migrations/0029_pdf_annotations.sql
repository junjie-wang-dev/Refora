CREATE TABLE pdf_annotations (
  documentId TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  annotationsJson TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);
