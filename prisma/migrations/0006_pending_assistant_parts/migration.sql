-- AlterTable: add pending_assistant_parts column to managed_agent_session
ALTER TABLE "managed_agent_session" ADD COLUMN "pending_assistant_parts" JSONB;
