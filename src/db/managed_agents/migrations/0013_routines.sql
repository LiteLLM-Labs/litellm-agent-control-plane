CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentRoutinesTable" (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'active',
  last_run_id TEXT REFERENCES "LiteLLM_ManagedAgentRunsTable" (id) ON DELETE SET NULL,
  last_run_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentRoutines_agent_id_idx"
  ON "LiteLLM_ManagedAgentRoutinesTable" (agent_id);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentRoutines_status_idx"
  ON "LiteLLM_ManagedAgentRoutinesTable" (status);
