CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentRulesTable" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  owner_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentRules_owner_id_idx"
  ON "LiteLLM_ManagedAgentRulesTable" (owner_id);

ALTER TABLE "LiteLLM_ManagedAgentsTable"
  ADD COLUMN IF NOT EXISTS rule_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
