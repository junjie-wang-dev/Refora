ALTER TABLE ai_providers ADD COLUMN presetId TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE ai_providers ADD COLUMN apiProtocol TEXT NOT NULL DEFAULT 'openai-compatible';
ALTER TABLE ai_providers ADD COLUMN reasoningControl TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE ai_providers ADD COLUMN reasoningEffort TEXT NOT NULL DEFAULT 'medium';

UPDATE ai_providers
SET presetId = CASE
  WHEN lower(baseUrl) LIKE '%api.openai.com%' THEN 'openai'
  WHEN lower(baseUrl) LIKE '%api.deepseek.com%' THEN 'deepseek'
  WHEN lower(baseUrl) LIKE '%moonshot%' THEN 'kimi'
  WHEN lower(baseUrl) LIKE '%localhost:11434%' OR lower(baseUrl) LIKE '%127.0.0.1:11434%' THEN 'ollama-local'
  WHEN lower(baseUrl) LIKE '%bigmodel%' THEN 'glm'
  WHEN lower(baseUrl) LIKE '%openrouter%' THEN 'openrouter'
  WHEN lower(baseUrl) LIKE '%dashscope%' THEN 'qwen'
  WHEN lower(baseUrl) LIKE '%siliconflow%' THEN 'siliconflow'
  WHEN lower(baseUrl) LIKE '%together%' THEN 'together'
  WHEN lower(baseUrl) LIKE '%groq.com%' THEN 'groq'
  WHEN lower(baseUrl) LIKE '%mistral.ai%' THEN 'mistral'
  ELSE 'custom'
END;

UPDATE ai_providers
SET apiProtocol = CASE WHEN presetId = 'openai' THEN 'openai-responses' ELSE 'openai-compatible' END,
    reasoningControl = CASE
      WHEN presetId IN ('deepseek', 'kimi', 'glm') THEN 'thinking'
      WHEN presetId = 'qwen' THEN 'enable-thinking'
      WHEN presetId = 'mistral' THEN 'none'
      ELSE 'openai'
    END,
    reasoningEffort = CASE
      WHEN presetId IN ('deepseek', 'kimi', 'glm', 'qwen', 'siliconflow') THEN 'high'
      WHEN presetId = 'mistral' THEN 'none'
      ELSE 'medium'
    END;
