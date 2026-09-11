CREATE TABLE document_file_aliases (
  fileHash TEXT PRIMARY KEY,
  documentId TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_document_file_aliases_document ON document_file_aliases(documentId);
