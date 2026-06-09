CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentRuntimeEventsTable" (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentSessionsTable" (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (session_id, seq),
  UNIQUE (session_id, event_key)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentRuntimeEvents_session_seq_idx"
  ON "LiteLLM_ManagedAgentRuntimeEventsTable" (session_id, seq);
