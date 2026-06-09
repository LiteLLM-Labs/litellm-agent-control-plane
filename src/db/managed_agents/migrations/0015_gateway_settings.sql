CREATE TABLE IF NOT EXISTS "LiteLLM_GatewaySettingsTable" (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT
);
