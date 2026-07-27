CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  filePath      TEXT NOT NULL,
  originalFolderPath TEXT NOT NULL,
  fileName      TEXT NOT NULL,
  fileSize      INTEGER,
  fileHash      TEXT,
  title         TEXT,
  authors       TEXT,
  year          TEXT,
  venue         TEXT,
  volume        TEXT,
  abstract      TEXT,
  keywords      TEXT,
  url           TEXT,
  doi           TEXT,
  note          TEXT,
  starred       INTEGER NOT NULL DEFAULT 0,
  addedAt       INTEGER NOT NULL,
  lastReadAt    INTEGER,
  updatedAt     INTEGER NOT NULL,
  metadataSource TEXT,
  metadataStatus TEXT NOT NULL DEFAULT 'pending',
  metadataAttempts INTEGER NOT NULL DEFAULT 0,
  editedFields  TEXT NOT NULL DEFAULT '[]',
  remoteValues  TEXT,
  fileMissing   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_documents_addedAt ON documents(addedAt DESC);
CREATE INDEX IF NOT EXISTS idx_documents_lastReadAt ON documents(lastReadAt DESC);
CREATE INDEX IF NOT EXISTS idx_documents_starred ON documents(starred);
CREATE INDEX IF NOT EXISTS idx_documents_filePath ON documents(filePath);
CREATE INDEX IF NOT EXISTS idx_documents_fileHash ON documents(fileHash);
CREATE INDEX IF NOT EXISTS idx_documents_metadataStatus ON documents(metadataStatus);

CREATE TABLE IF NOT EXISTS categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  sortOrder     INTEGER NOT NULL DEFAULT 0,
  moveToLibrary INTEGER,
  createdAt     INTEGER NOT NULL,
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS document_categories (
  documentId TEXT NOT NULL,
  categoryId TEXT NOT NULL,
  PRIMARY KEY (documentId, categoryId),
  FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (categoryId) REFERENCES categories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_doccat_doc ON document_categories(documentId);
CREATE INDEX IF NOT EXISTS idx_doccat_cat ON document_categories(categoryId);

CREATE TABLE IF NOT EXISTS watch_folders (
  id      TEXT PRIMARY KEY,
  path    TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  addedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, authors, venue, year, keywords, abstract, url, note, fileName,
  content='documents', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO docs_fts(rowid, title, authors, venue, year, keywords, abstract, url, note, fileName)
  VALUES (new.rowid, new.title, new.authors, new.venue, new.year, new.keywords, new.abstract, new.url, new.note, new.fileName);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, authors, venue, year, keywords, abstract, url, note, fileName)
  VALUES ('delete', old.rowid, old.title, old.authors, old.venue, old.year, old.keywords, old.abstract, old.url, old.note, old.fileName);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE OF title, authors, venue, year, keywords, abstract, url, note, fileName ON documents BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, authors, venue, year, keywords, abstract, url, note, fileName)
  VALUES ('delete', old.rowid, old.title, old.authors, old.venue, old.year, old.keywords, old.abstract, old.url, old.note, old.fileName);
  INSERT INTO docs_fts(rowid, title, authors, venue, year, keywords, abstract, url, note, fileName)
  VALUES (new.rowid, new.title, new.authors, new.venue, new.year, new.keywords, new.abstract, new.url, new.note, new.fileName);
END;
