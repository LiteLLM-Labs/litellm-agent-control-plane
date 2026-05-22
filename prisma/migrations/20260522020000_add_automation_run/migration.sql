-- CreateTable
CREATE TABLE "managed_agent_automation_run" (
    "run_id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "session_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "managed_agent_automation_run_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE INDEX "managed_agent_automation_run_agent_id_started_at_idx" ON "managed_agent_automation_run"("agent_id", "started_at");

-- CreateIndex
CREATE INDEX "managed_agent_automation_run_status_idx" ON "managed_agent_automation_run"("status");

-- AddForeignKey
ALTER TABLE "managed_agent_automation_run" ADD CONSTRAINT "managed_agent_automation_run_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "managed_agent_automation"("automation_id") ON DELETE CASCADE ON UPDATE CASCADE;
