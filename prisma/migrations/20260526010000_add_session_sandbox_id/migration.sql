-- Per-session e2b sandbox ID for the inline-direct harness mode.
-- The legacy in-memory `sandboxes` Map in sandbox-mcp.mjs was global across the
-- shared inline-shared harness process, keyed only by `name` ("main"), so two
-- concurrent sessions both calling provision("main") collided — one's sandbox
-- silently became the other's. Persisting the e2b sandbox ID on the session
-- row makes the session the unit of ownership and survives harness restarts
-- (the SDK can reconnect to the live e2b sandbox by id).
ALTER TABLE "managed_agent_session" ADD COLUMN "sandbox_id" TEXT;
