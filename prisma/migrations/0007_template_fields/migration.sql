-- Add Helm-style template provenance to managed_agent.
-- template_id: which template spawned this agent (null = not template-derived).
-- template_version: version of that template at last sync; compare to current
--   template's version to detect drift and surface "sync available" in the UI.
ALTER TABLE "managed_agent" ADD COLUMN "template_id" TEXT;
ALTER TABLE "managed_agent" ADD COLUMN "template_version" INTEGER;
