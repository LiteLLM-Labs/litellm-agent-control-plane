-- CreateTable
CREATE TABLE "managed_agent_session_event" (
    "session_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "managed_agent_session_event_pkey" PRIMARY KEY ("session_id","seq")
);

-- CreateIndex
CREATE INDEX "managed_agent_session_event_session_id_seq_idx" ON "managed_agent_session_event"("session_id", "seq");

-- AddForeignKey
ALTER TABLE "managed_agent_session_event" ADD CONSTRAINT "managed_agent_session_event_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "managed_agent_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;
