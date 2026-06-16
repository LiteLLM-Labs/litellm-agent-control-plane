CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentGoogleChatSpaceSessionsTable" (
  agent_id         TEXT    NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable"(id) ON DELETE CASCADE,
  conversation_key TEXT    NOT NULL,
  session_id       TEXT    NOT NULL REFERENCES "LiteLLM_ManagedAgentSessionsTable"(id) ON DELETE CASCADE,
  space_name       TEXT    NOT NULL,
  thread_name      TEXT,
  created_at       BIGINT  NOT NULL,
  updated_at       BIGINT  NOT NULL,
  PRIMARY KEY (agent_id, conversation_key)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentGoogleChatSpaceSessions_session_idx"
  ON "LiteLLM_ManagedAgentGoogleChatSpaceSessionsTable" (session_id);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentGoogleChatEventsTable" (
  agent_id   TEXT    NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable"(id) ON DELETE CASCADE,
  event_id   TEXT    NOT NULL,
  created_at BIGINT  NOT NULL,
  PRIMARY KEY (agent_id, event_id)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentGoogleChatEvents_created_idx"
  ON "LiteLLM_ManagedAgentGoogleChatEventsTable" (created_at);
