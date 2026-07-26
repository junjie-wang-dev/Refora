ALTER TABLE agent_trace_steps ADD COLUMN inputTokens INTEGER;
ALTER TABLE agent_trace_steps ADD COLUMN outputTokens INTEGER;
ALTER TABLE agent_trace_steps ADD COLUMN totalTokens INTEGER;
