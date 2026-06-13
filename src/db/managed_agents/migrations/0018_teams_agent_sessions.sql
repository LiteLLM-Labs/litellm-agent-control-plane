CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentTeamsConversationSessionsTable" (
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentSessionsTable" (id) ON DELETE CASCADE,
  service_url TEXT NOT NULL,
  tenant_id TEXT,
  team_id TEXT,
  channel_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentTeamsConversationSessions_session_idx"
  ON "LiteLLM_ManagedAgentTeamsConversationSessionsTable" (session_id);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentTeamsEventsTable" (
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, event_id)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentTeamsEvents_created_idx"
  ON "LiteLLM_ManagedAgentTeamsEventsTable" (created_at);
