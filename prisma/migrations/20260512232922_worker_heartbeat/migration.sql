-- Worker heartbeat singleton row. The session-create path checks this
-- timestamp before flipping a session to `ready` so a dead worker
-- doesn't silently drop the user's first message on the floor.
CREATE TABLE IF NOT EXISTS "lap_worker_heartbeat" (
  id           INTEGER PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL
);
