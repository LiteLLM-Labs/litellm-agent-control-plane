ALTER TABLE "LiteLLM_ManagedAgentSessionsTable"
  ADD COLUMN IF NOT EXISTS runtime TEXT,
  ADD COLUMN IF NOT EXISTS runtime_agent_ref_id TEXT,
  ADD COLUMN IF NOT EXISTS environment_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_session_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_run_id TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'starting';

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentRuntimeRefsTable" (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  runtime TEXT NOT NULL,
  runtime_agent_id TEXT NOT NULL,
  provider_session_id TEXT,
  provider_run_id TEXT,
  provider_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (agent_id, runtime)
);
