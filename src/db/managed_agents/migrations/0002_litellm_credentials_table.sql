CREATE TABLE IF NOT EXISTS "LiteLLM_CredentialsTable" (
  credential_id TEXT PRIMARY KEY,
  credential_name TEXT UNIQUE NOT NULL,
  credential_values JSONB NOT NULL,
  credential_info JSONB,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT NOT NULL
);
