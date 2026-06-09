CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentSlackEventsTable" (
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, event_id)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentSlackEvents_created_idx"
  ON "LiteLLM_ManagedAgentSlackEventsTable" (created_at);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentSlackOAuthStatesTable" (
  state TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentSlackOAuthStates_agent_idx"
  ON "LiteLLM_ManagedAgentSlackOAuthStatesTable" (agent_id);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentSlackOAuthStates_expires_idx"
  ON "LiteLLM_ManagedAgentSlackOAuthStatesTable" (expires_at);
