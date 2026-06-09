CREATE TABLE IF NOT EXISTS "LiteLLM_SpendLogs" (
  request_id TEXT PRIMARY KEY,
  call_type TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  spend DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  "startTime" TIMESTAMPTZ NOT NULL,
  "endTime" TIMESTAMPTZ NOT NULL,
  request_duration_ms INTEGER,
  "completionStartTime" TIMESTAMPTZ,
  model TEXT NOT NULL DEFAULT '',
  model_id TEXT DEFAULT '',
  model_group TEXT DEFAULT '',
  custom_llm_provider TEXT DEFAULT '',
  api_base TEXT DEFAULT '',
  "user" TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}'::jsonb,
  cache_hit TEXT DEFAULT '',
  cache_key TEXT DEFAULT '',
  request_tags JSONB DEFAULT '[]'::jsonb,
  team_id TEXT,
  organization_id TEXT,
  end_user TEXT,
  requester_ip_address TEXT,
  messages JSONB DEFAULT '{}'::jsonb,
  response JSONB DEFAULT '{}'::jsonb,
  session_id TEXT,
  status TEXT,
  mcp_namespaced_tool_name TEXT,
  agent_id TEXT,
  proxy_server_request JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "LiteLLM_SpendLogs_startTime_idx"
  ON "LiteLLM_SpendLogs" ("startTime");

CREATE INDEX IF NOT EXISTS "LiteLLM_SpendLogs_startTime_request_id_idx"
  ON "LiteLLM_SpendLogs" ("startTime", request_id);

CREATE INDEX IF NOT EXISTS "LiteLLM_SpendLogs_end_user_idx"
  ON "LiteLLM_SpendLogs" (end_user);

CREATE INDEX IF NOT EXISTS "LiteLLM_SpendLogs_session_id_idx"
  ON "LiteLLM_SpendLogs" (session_id);
