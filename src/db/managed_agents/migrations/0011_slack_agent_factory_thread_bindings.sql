ALTER TABLE "LiteLLM_SlackAgentBindingsTable"
  ADD COLUMN IF NOT EXISTS thread_ts TEXT;

ALTER TABLE "LiteLLM_SlackPendingInstallsTable"
  ADD COLUMN IF NOT EXISTS thread_ts TEXT;

DROP INDEX IF EXISTS "LiteLLM_SlackAgentBindings_location_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "LiteLLM_SlackAgentBindings_location_idx"
  ON "LiteLLM_SlackAgentBindingsTable" (
    platform_agent_id,
    COALESCE(team_id, ''),
    channel_id,
    COALESCE(thread_ts, '')
  );
