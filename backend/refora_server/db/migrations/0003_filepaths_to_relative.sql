UPDATE documents
SET filePath = substr(
  filePath,
  length(json_extract((SELECT value FROM settings WHERE key = 'libraryFolderPath'), '$')) + 2
)
WHERE json_extract((SELECT value FROM settings WHERE key = 'libraryFolderPath'), '$') <> ''
  AND filePath LIKE json_extract((SELECT value FROM settings WHERE key = 'libraryFolderPath'), '$') || '/%';
