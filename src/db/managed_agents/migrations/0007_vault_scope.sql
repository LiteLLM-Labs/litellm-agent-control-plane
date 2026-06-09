-- Add scope and owner_id to credentials table for per-user vault keys.
-- scope='global'   → admin-managed, visible to all users (default for existing rows)
-- scope='personal' → user-managed, only visible to the owning user

ALTER TABLE "LiteLLM_CredentialsTable"
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS owner_id TEXT;

-- Drop the single-column unique constraint; replaced by the two partial indexes below.
ALTER TABLE "LiteLLM_CredentialsTable"
  DROP CONSTRAINT IF EXISTS "LiteLLM_CredentialsTable_credential_name_key";

-- Global keys: unique by name (owner_id is NULL for global keys)
CREATE UNIQUE INDEX IF NOT EXISTS cred_global_unique
  ON "LiteLLM_CredentialsTable" (credential_name)
  WHERE scope = 'global';

-- Personal keys: unique by (name, owner_id)
CREATE UNIQUE INDEX IF NOT EXISTS cred_personal_unique
  ON "LiteLLM_CredentialsTable" (credential_name, owner_id)
  WHERE scope = 'personal';
