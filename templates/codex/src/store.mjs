import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const parse = (value, fallback) => value ? JSON.parse(value) : fallback;

function agentRow(row) {
  if (!row) return null;
  return {
    ...row,
    permissions: parse(row.permissions, {}),
    mcp_servers: parse(row.mcp_servers, []),
  };
}

export function createStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, system TEXT, model TEXT,
      permissions TEXT, mcp_servers TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE,
      environment_id TEXT, workspace TEXT NOT NULL, active_turn_id TEXT,
      status TEXT NOT NULL, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      event_id TEXT NOT NULL, event_json TEXT NOT NULL,
      UNIQUE(session_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_codex_events ON session_events(session_id, seq);
  `);

  const getAgentStmt = db.prepare("SELECT * FROM agents WHERE id = ?");
  const getSessionStmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const getThreadStmt = db.prepare("SELECT * FROM sessions WHERE thread_id = ?");

  function createAgent(input = {}) {
    const now = Date.now();
    const row = {
      id: id("agt"), name: input.name ?? null, system: input.system || "",
      model: input.model || "", permissions: JSON.stringify(input.permissions || {}),
      mcp_servers: JSON.stringify(input.mcp_servers || []), created_at: now, updated_at: now,
    };
    db.prepare(`INSERT INTO agents VALUES
      (@id,@name,@system,@model,@permissions,@mcp_servers,@created_at,@updated_at)`).run(row);
    return agentRow(getAgentStmt.get(row.id));
  }

  function updateAgent(agentId, patch = {}) {
    const current = agentRow(getAgentStmt.get(agentId));
    if (!current) return null;
    const row = {
      ...current, ...patch,
      permissions: JSON.stringify(patch.permissions ?? current.permissions),
      mcp_servers: JSON.stringify(patch.mcp_servers ?? current.mcp_servers),
      updated_at: Date.now(),
    };
    db.prepare(`UPDATE agents SET name=@name,system=@system,model=@model,
      permissions=@permissions,mcp_servers=@mcp_servers,updated_at=@updated_at WHERE id=@id`).run(row);
    return agentRow(getAgentStmt.get(agentId));
  }

  function createSession(input) {
    const now = Date.now();
    const row = {
      id: id("ses"), agent_id: input.agent_id, thread_id: input.thread_id,
      environment_id: input.environment_id || null, workspace: input.workspace,
      active_turn_id: null, status: "idle", created_at: now, updated_at: now,
    };
    db.prepare(`INSERT INTO sessions VALUES
      (@id,@agent_id,@thread_id,@environment_id,@workspace,@active_turn_id,@status,@created_at,@updated_at)`).run(row);
    return getSessionStmt.get(row.id);
  }

  function updateSession(sessionId, patch) {
    const row = getSessionStmt.get(sessionId);
    if (!row) return null;
    const next = { ...row, ...patch, updated_at: Date.now() };
    db.prepare(`UPDATE sessions SET active_turn_id=@active_turn_id,status=@status,
      updated_at=@updated_at WHERE id=@id`).run(next);
    return getSessionStmt.get(sessionId);
  }

  return {
    createAgent,
    getAgent: (agentId) => agentRow(getAgentStmt.get(agentId)),
    listAgents: () => db.prepare("SELECT * FROM agents ORDER BY created_at").all().map(agentRow),
    updateAgent,
    deleteAgent: (agentId) => db.prepare("DELETE FROM agents WHERE id = ?").run(agentId).changes > 0,
    createSession,
    getSession: (sessionId) => getSessionStmt.get(sessionId) || null,
    getSessionByThread: (threadId) => getThreadStmt.get(threadId) || null,
    updateSession,
    insertEvent(sessionId, eventId, event) {
      db.prepare(`INSERT OR IGNORE INTO session_events(session_id,event_id,event_json)
        VALUES(?,?,?)`).run(sessionId, eventId, JSON.stringify(event));
    },
    listEvents(sessionId) {
      return db.prepare(`SELECT seq,event_id,event_json FROM session_events WHERE session_id=? ORDER BY seq`)
        .all(sessionId).map((row) => ({
          ...JSON.parse(row.event_json),
          seq: row.seq,
          event_id: row.event_id,
        }));
    },
    close: () => db.close(),
  };
}
