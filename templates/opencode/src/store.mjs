// store.mjs
//
// Durable SQLite-backed store for an opencode-compatible agent server.
// Persists agent definitions and session->agent bindings in two tables
// (`agents`, `session_bindings`) using better-sqlite3 with WAL journaling.
//
// JSON-typed columns (permissions, mcp_servers, workspace) are transparently
// serialized on write and parsed on read, so callers always receive plain JS
// objects/arrays. Exposes a small CRUD surface plus session binding helpers.
// ESM only; Node 20+.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

function genId() {
  return "agt_" + crypto.randomBytes(12).toString("hex");
}

// Convert a raw DB row into a caller-facing row with parsed JSON fields.
function deserialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    system: row.system,
    model: row.model,
    permissions: row.permissions ? JSON.parse(row.permissions) : {},
    mcp_servers: row.mcp_servers ? JSON.parse(row.mcp_servers) : [],
    workspace: row.workspace ? JSON.parse(row.workspace) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createStore(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      system TEXT,
      model TEXT,
      permissions TEXT,
      mcp_servers TEXT,
      workspace TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_bindings (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT,
      created_at INTEGER
    );
  `);

  const stmts = {
    insert: db.prepare(`
      INSERT INTO agents
        (id, name, system, model, permissions, mcp_servers, workspace, created_at, updated_at)
      VALUES
        (@id, @name, @system, @model, @permissions, @mcp_servers, @workspace, @created_at, @updated_at)
    `),
    get: db.prepare(`SELECT * FROM agents WHERE id = ?`),
    list: db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`),
    delete: db.prepare(`DELETE FROM agents WHERE id = ?`),
    bind: db.prepare(`
      INSERT INTO session_bindings (session_id, agent_id, created_at)
      VALUES (@session_id, @agent_id, @created_at)
      ON CONFLICT(session_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        created_at = excluded.created_at
    `),
    getBinding: db.prepare(`SELECT agent_id FROM session_bindings WHERE session_id = ?`),
    unbind: db.prepare(`DELETE FROM session_bindings WHERE session_id = ?`),
  };

  function createAgent({ name, system, model, permissions, mcp_servers, workspace } = {}) {
    const now = Date.now();
    const row = {
      id: genId(),
      name: name ?? null,
      system: system ?? null,
      model: model ?? null,
      permissions: JSON.stringify(permissions ?? {}),
      mcp_servers: JSON.stringify(mcp_servers ?? []),
      workspace: workspace === undefined ? null : JSON.stringify(workspace),
      created_at: now,
      updated_at: now,
    };
    stmts.insert.run(row);
    return deserialize(stmts.get.get(row.id));
  }

  function getAgent(id) {
    return deserialize(stmts.get.get(id));
  }

  function listAgents() {
    return stmts.list.all().map(deserialize);
  }

  function updateAgent(id, patch = {}) {
    const existing = stmts.get.get(id);
    if (!existing) return null;

    const merged = { ...existing };
    if ("name" in patch) merged.name = patch.name ?? null;
    if ("system" in patch) merged.system = patch.system ?? null;
    if ("model" in patch) merged.model = patch.model ?? null;
    if ("permissions" in patch) merged.permissions = JSON.stringify(patch.permissions ?? {});
    if ("mcp_servers" in patch) merged.mcp_servers = JSON.stringify(patch.mcp_servers ?? []);
    if ("workspace" in patch)
      merged.workspace = patch.workspace === undefined || patch.workspace === null
        ? null
        : JSON.stringify(patch.workspace);
    merged.updated_at = Date.now();

    db.prepare(`
      UPDATE agents SET
        name = @name, system = @system, model = @model,
        permissions = @permissions, mcp_servers = @mcp_servers,
        workspace = @workspace, updated_at = @updated_at
      WHERE id = @id
    `).run(merged);

    return deserialize(stmts.get.get(id));
  }

  function deleteAgent(id) {
    return stmts.delete.run(id).changes > 0;
  }

  function bindSession(sessionId, agentId) {
    stmts.bind.run({ session_id: sessionId, agent_id: agentId, created_at: Date.now() });
  }

  function getSessionAgent(sessionId) {
    const row = stmts.getBinding.get(sessionId);
    return row ? row.agent_id : null;
  }

  function unbindSession(sessionId) {
    stmts.unbind.run(sessionId);
  }

  return {
    createAgent,
    getAgent,
    listAgents,
    updateAgent,
    deleteAgent,
    bindSession,
    getSessionAgent,
    unbindSession,
  };
}
