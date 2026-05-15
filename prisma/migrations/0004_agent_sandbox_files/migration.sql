-- AlterTable
ALTER TABLE "managed_agent" ADD COLUMN "sandbox_files" JSONB NOT NULL DEFAULT '[]';
