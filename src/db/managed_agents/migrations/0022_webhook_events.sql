CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentWebhookEventsTable" (
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentSessionsTable" (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'processing',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, event_id)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentWebhookEvents_created_idx"
  ON "LiteLLM_ManagedAgentWebhookEventsTable" (created_at);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentWebhookEvents_session_idx"
  ON "LiteLLM_ManagedAgentWebhookEventsTable" (session_id);
