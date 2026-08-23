CREATE TABLE IF NOT EXISTS legacy_path_repair_candidates (
  documentId TEXT PRIMARY KEY,
  candidatePath TEXT NOT NULL,
  relativePath TEXT NOT NULL,
  FOREIGN KEY (documentId) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS legacy_author_repair_pending (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

INSERT OR IGNORE INTO legacy_author_repair_pending (id) VALUES (1);

WITH library(root) AS (
  SELECT json_extract(value, '$')
  FROM settings
  WHERE key = 'libraryFolderPath'
)
INSERT OR IGNORE INTO legacy_path_repair_candidates (
  documentId,
  candidatePath,
  relativePath
)
SELECT
  id,
  rtrim(originalFolderPath, '/') || '/' || fileName,
  filePath
FROM documents
WHERE EXISTS (SELECT 1 FROM library WHERE root <> '')
  AND substr(filePath, 1, 1) <> '/'
  AND substr(originalFolderPath, 1, 1) = '/'
  AND originalFolderPath <> ''
  AND substr(
    rtrim(originalFolderPath, '/') || '/' || fileName,
    length((SELECT root FROM library)) + 2
  ) = filePath
  AND (rtrim(originalFolderPath, '/') || '/' || fileName)
    LIKE (SELECT root FROM library) || '/%'
  AND substr(
    rtrim(originalFolderPath, '/') || '/' || fileName,
    1,
    length((SELECT root FROM library)) + 1
  ) <> (SELECT root FROM library) || '/';

WITH RECURSIVE author_parts(rowid, rest, author, ordinal) AS (
  SELECT rowid, authors || ';', '', 0
  FROM documents
  WHERE authors IS NOT NULL AND trim(authors) <> ''

  UNION ALL

  SELECT
    rowid,
    substr(rest, instr(rest, ';') + 1),
    trim(substr(rest, 1, instr(rest, ';') - 1)),
    ordinal + 1
  FROM author_parts
  WHERE rest <> ''
),
repaired_parts(rowid, ordinal, author) AS (
  SELECT
    rowid,
    ordinal,
    CASE
      WHEN instr(author, ',') = 0 AND author GLOB 'Inc. *' THEN substr(author, 6) || ', Inc.'
      WHEN instr(author, ',') = 0 AND author GLOB 'Inc *' THEN substr(author, 5) || ', Inc'
      WHEN instr(author, ',') = 0 AND author GLOB 'Ltd. *' THEN substr(author, 6) || ', Ltd.'
      WHEN instr(author, ',') = 0 AND author GLOB 'Ltd *' THEN substr(author, 5) || ', Ltd'
      WHEN instr(author, ',') = 0 AND author GLOB 'LLC *' THEN substr(author, 5) || ', LLC'
      WHEN instr(author, ',') = 0 AND author GLOB 'LLP *' THEN substr(author, 5) || ', LLP'
      WHEN instr(author, ',') = 0 AND author GLOB 'PLC *' THEN substr(author, 5) || ', PLC'
      WHEN instr(author, ',') = 0 AND author GLOB 'GmbH *' THEN substr(author, 6) || ', GmbH'
      WHEN instr(author, ',') = 0 AND author GLOB 'Corp. *' THEN substr(author, 7) || ', Corp.'
      WHEN instr(author, ',') = 0 AND author GLOB 'Corporation *' THEN substr(author, 13) || ', Corporation'
      WHEN instr(author, ',') = 0 AND author GLOB 'Company *' THEN substr(author, 9) || ', Company'
      WHEN instr(author, ',') = 0 AND author GLOB '* Massachusetts Institute of Technology'
        THEN substr(author, instr(author, ' Massachusetts Institute of Technology') + 1) || ', ' ||
          substr(author, 1, instr(author, ' Massachusetts Institute of Technology') - 1)
      WHEN instr(author, ',') = 0 AND author GLOB '* University of California'
        THEN substr(author, instr(author, ' University of California') + 1) || ', ' ||
          substr(author, 1, instr(author, ' University of California') - 1)
      ELSE author
    END
  FROM author_parts
  WHERE author <> ''
),
repaired_authors(rowid, authors) AS (
  SELECT rowid, group_concat(author, '; ')
  FROM (
    SELECT rowid, author
    FROM repaired_parts
    ORDER BY rowid, ordinal
  )
  GROUP BY rowid
)
UPDATE documents
SET authors = (
  SELECT repaired_authors.authors
  FROM repaired_authors
  WHERE repaired_authors.rowid = documents.rowid
)
WHERE rowid IN (
  SELECT rowid
  FROM repaired_authors
  WHERE authors <> (SELECT documents.authors FROM documents WHERE documents.rowid = repaired_authors.rowid)
);
