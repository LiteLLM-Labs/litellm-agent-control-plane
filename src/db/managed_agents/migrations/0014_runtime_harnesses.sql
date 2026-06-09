CREATE TABLE IF NOT EXISTS "LiteLLM_RuntimeHarnessTable" (
  id          TEXT PRIMARY KEY,
  alias       TEXT UNIQUE NOT NULL,
  api_spec    TEXT NOT NULL,
  api_base    TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
