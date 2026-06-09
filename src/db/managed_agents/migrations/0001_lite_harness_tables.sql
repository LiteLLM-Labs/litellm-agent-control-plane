CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentSessionsTable" (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  agent_id TEXT,
  title TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT,
  sdk_session_id TEXT,
  tz TEXT
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentSessions_agent_id_idx"
  ON "LiteLLM_ManagedAgentSessionsTable" (agent_id);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentSessionMessagesTable" (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentSessionsTable" (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  info_json TEXT NOT NULL,
  parts_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentSessionMessages_sid_seq"
  ON "LiteLLM_ManagedAgentSessionMessagesTable" (session_id, seq);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentsTable" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  system TEXT NOT NULL,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  cadence TEXT,
  interval_seconds INTEGER,
  session_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentSessionsTable" (id),
  loop_id TEXT,
  created_at BIGINT NOT NULL,
  prompt TEXT,
  cron TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  vault_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  setup_commands JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_runtime_minutes INTEGER NOT NULL DEFAULT 30,
  on_failure TEXT NOT NULL DEFAULT 'pause_and_notify',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'paused',
  description TEXT,
  harness TEXT NOT NULL DEFAULT 'claude-code',
  skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgents_owner_id_idx"
  ON "LiteLLM_ManagedAgentsTable" (owner_id);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgents_status_idx"
  ON "LiteLLM_ManagedAgentsTable" (status);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentFilesTable" (
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'utf8',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, path)
);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentSkillsTable" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  owner_id TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentSkills_owner_id_idx"
  ON "LiteLLM_ManagedAgentSkillsTable" (owner_id);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentMemoriesTable" (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  always_on INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (agent_id, key)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentMemories_agent_id_idx"
  ON "LiteLLM_ManagedAgentMemoriesTable" (agent_id);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentInboxItemsTable" (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  session_id TEXT,
  agent TEXT,
  body TEXT,
  args_json TEXT,
  status TEXT NOT NULL,
  feedback TEXT,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentInboxItems_status_created_idx"
  ON "LiteLLM_ManagedAgentInboxItemsTable" (status, created_at);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentSlackThreadSessionsTable" (
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (agent_id, channel_id, thread_ts)
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentSlackThreadSessions_session_idx"
  ON "LiteLLM_ManagedAgentSlackThreadSessionsTable" (session_id);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentLoopsTable" (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentSessionsTable" (id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  max_iterations INTEGER,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  next_run_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  cron_expr TEXT,
  tz TEXT
);

CREATE TABLE IF NOT EXISTS "LiteLLM_ManagedAgentRunsTable" (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES "LiteLLM_ManagedAgentsTable" (id) ON DELETE CASCADE,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  summary TEXT,
  error TEXT,
  config_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  sandbox_id TEXT,
  logs TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS "LiteLLM_ManagedAgentRuns_agent_started_idx"
  ON "LiteLLM_ManagedAgentRunsTable" (agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS "LiteLLM_SavedAgentsTable" (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  system_prompt TEXT NOT NULL,
  base_agent TEXT NOT NULL DEFAULT 'cc',
  created_at BIGINT NOT NULL
);
