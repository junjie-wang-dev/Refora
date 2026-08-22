UPDATE web_search_config
SET provider = 'disabled'
WHERE id = 1
  AND provider = 'ddgs'
  AND updatedAt = 0;
