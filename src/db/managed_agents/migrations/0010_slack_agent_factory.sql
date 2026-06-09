CREATE TABLE IF NOT EXISTS "LiteLLM_SlackAgentBindingsTable" (
  id TEXT PRIMARY KEY,
  platform_agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable"(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable"(id) ON DELETE CASCADE,
  team_id TEXT,
  channel_id TEXT NOT NULL,
  dm_user_id TEXT,
  created_by TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS "LiteLLM_SlackAgentBindings_agent_idx"
  ON "LiteLLM_SlackAgentBindingsTable" (agent_id);

CREATE UNIQUE INDEX IF NOT EXISTS "LiteLLM_SlackAgentBindings_location_idx"
  ON "LiteLLM_SlackAgentBindingsTable" (platform_agent_id, COALESCE(team_id, ''), channel_id);

CREATE TABLE IF NOT EXISTS "LiteLLM_SlackPendingInstallsTable" (
  state TEXT PRIMARY KEY,
  platform_agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable"(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable"(id) ON DELETE CASCADE,
  team_id TEXT,
  channel_id TEXT NOT NULL,
  dm_user_id TEXT,
  requested_by TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);

CREATE INDEX IF NOT EXISTS "LiteLLM_SlackPendingInstalls_agent_idx"
  ON "LiteLLM_SlackPendingInstallsTable" (platform_agent_id, agent_id);
