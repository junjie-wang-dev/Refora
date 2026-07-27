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
normalized_parts(rowid, ordinal, author) AS (
  SELECT
    rowid,
    ordinal,
    CASE
      WHEN instr(author, ',') > 0
        AND length(trim(substr(author, 1, instr(author, ',') - 1))) = 4
        AND trim(substr(author, 1, instr(author, ',') - 1)) GLOB '[0-9][0-9][0-9][0-9]'
        THEN trim(substr(author, instr(author, ',') + 1))
      WHEN instr(author, ',') > 0
        THEN trim(substr(author, instr(author, ',') + 1)) || ' ' ||
          trim(substr(author, 1, instr(author, ',') - 1))
      WHEN length(author) > 5
        AND substr(author, -5, 1) = ' '
        AND substr(author, -4) GLOB '[0-9][0-9][0-9][0-9]'
        THEN trim(substr(author, 1, length(author) - 5))
      ELSE trim(author)
    END
  FROM author_parts
  WHERE author <> ''
),
normalized_authors(rowid, authors) AS (
  SELECT rowid, group_concat(author, '; ')
  FROM (
    SELECT rowid, author
    FROM normalized_parts
    ORDER BY rowid, ordinal
  )
  GROUP BY rowid
)
UPDATE documents
SET authors = (
  SELECT normalized_authors.authors
  FROM normalized_authors
  WHERE normalized_authors.rowid = documents.rowid
)
WHERE rowid IN (SELECT rowid FROM normalized_authors);
