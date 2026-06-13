-- Make agents.session_id nullable and set ON DELETE SET NULL
-- so sessions can be deleted without first deleting the agent.
ALTER TABLE "LiteLLM_ManagedAgentsTable"
  DROP CONSTRAINT IF EXISTS "LiteLLM_ManagedAgentsTable_session_id_fkey";

ALTER TABLE "LiteLLM_ManagedAgentsTable"
  ALTER COLUMN session_id DROP NOT NULL;

ALTER TABLE "LiteLLM_ManagedAgentsTable"
  ADD CONSTRAINT "LiteLLM_ManagedAgentsTable_session_id_fkey"
  FOREIGN KEY (session_id)
  REFERENCES "LiteLLM_ManagedAgentSessionsTable" (id)
  ON DELETE SET NULL;
