ALTER TABLE "managed_agent_session_assessment"
    ADD COLUMN IF NOT EXISTS "reviewer_output" TEXT;

ALTER TABLE "managed_agent_session_assessment"
    ADD COLUMN IF NOT EXISTS "improvement_suggestions" JSONB NOT NULL DEFAULT '[]';
