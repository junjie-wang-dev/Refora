UPDATE web_search_config
SET provider = 'ddgs'
WHERE id = 1
  AND provider = 'disabled'
  AND updatedAt = 0;
