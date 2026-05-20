-- Snapshot of the template's prompt text at agent creation / last sync.
-- Used by the "View changes" diff overlay to show what actually changed
-- between the old template version and the new one, rather than comparing
-- against agent.prompt (which is user customizations, not the old template text).
ALTER TABLE "managed_agent" ADD COLUMN "template_prompt" TEXT;
