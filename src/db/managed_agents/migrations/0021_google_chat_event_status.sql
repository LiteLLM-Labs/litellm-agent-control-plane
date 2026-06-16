ALTER TABLE "LiteLLM_ManagedAgentGoogleChatEventsTable"
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE "LiteLLM_ManagedAgentGoogleChatEventsTable"
  ADD COLUMN IF NOT EXISTS updated_at BIGINT;

UPDATE "LiteLLM_ManagedAgentGoogleChatEventsTable"
SET updated_at = created_at
WHERE updated_at IS NULL;

ALTER TABLE "LiteLLM_ManagedAgentGoogleChatEventsTable"
  ALTER COLUMN updated_at SET NOT NULL;
