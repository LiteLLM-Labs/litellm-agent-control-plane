#!/usr/bin/env node
/*
 * opencode inline adapter — makes attached skills LOADABLE on the single shared
 * `opencode serve` (the opencode-brain-inline harness).
 *
 * Why an adapter at all: opencode discovers skills from disk at session-create
 * time, and the platform delivers an agent's skills as SandboxFileSpec entries
 * in the POST /session `files` array. opencode *does* write that array, but only
 * after the session is created — too late for the new session to discover them.
 * So this adapter writes the skill files to the shared global skills dir
 * (~/.claude/skills) BEFORE forwarding session-create, so opencode picks them up
 * for that turn.
 *
 * Skills are written to the shared dir (not a per-agent directory): on this
 * shared server every agent sees every attached skill. We deliberately do NOT
 * pin sessions to a per-agent `?directory` — opencode's `/event` bus is
 * directory-scoped, and the UI's `/event` subscription has no directory, so a
 * per-session directory would hide the live transcript (the chat would hang on
 * "thinking…" even though the turn completed).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 4096);
const CHILD_PORT = Number(process.env.OPENCODE_CHILD_PORT || PORT + 1);
const UP = `http://127.0.0.1:${CHILD_PORT}`;
const SKILLS_ROOT = path.join(process.env.HOME || "/home/sandbox", ".claude", "skills");

const log = (...a) => console.log("[inline-adapter]", ...a);

// A SandboxFileSpec is a skill file when its sandbox_path lands in a skills dir
// and is a SKILL.md. Returns the slug (the directory under skills/), else null.
// Leading-alnum anchor rejects "." / ".." so a crafted name can't escape the dir.
function skillSlug(sandboxPath) {
  if (!sandboxPath) return null;
  const m = sandboxPath.replace(/\\/g, "/").match(/\/skills\/([^/]+)\/SKILL\.md$/);
  return m && /^[a-z0-9][a-z0-9._-]*$/i.test(m[1]) ? m[1] : null;
}

// Write a session's skill files to the shared global skills dir so opencode
// discovers them when it creates the session. Returns how many were written.
function materializeSkills(files) {
  let written = 0;
  for (const f of files || []) {
    const slug = skillSlug(f.sandbox_path);
    if (!slug) continue;
    const dir = path.join(SKILLS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), Buffer.from(f.content || "", "base64"));
    written++;
  }
  return written;
}

function readBody(req) {
  return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); });
}

function forward(method, urlPath, search, bodyBuf, clientRes) {
  const upReq = http.request(UP + urlPath + (search || ""), { method, headers: { "content-type": "application/json" } }, (upRes) => {
    clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(clientRes);
  });
  upReq.on("error", (e) => { clientRes.writeHead(502); clientRes.end(JSON.stringify({ error: String(e) })); });
  if (bodyBuf) upReq.write(bodyBuf);
  upReq.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/" || p === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ harness: "opencode-brain-inline", ok: true }));
    return;
  }

  // POST /session: materialize this agent's skills before opencode creates the
  // session, then forward unchanged (no ?directory — keep the /event bus global).
  if (p === "/session" && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const n = materializeSkills(body.files);
    // Drop skill files from the forwarded body — opencode would otherwise
    // re-write them (to the same path) after create, which is just wasted work.
    if (Array.isArray(body.files)) body.files = body.files.filter((f) => !skillSlug(f.sandbox_path));
    log(`session create: materialized ${n} skill(s)`);
    forward("POST", "/session", "", Buffer.from(JSON.stringify(body)), res);
    return;
  }

  // Everything else (/event, /session/:id/*, ...) — transparent passthrough.
  const raw = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
  forward(req.method, p, url.search, raw ? Buffer.from(raw) : null, res);
});

// Boot the shared opencode serve as a child, then start accepting traffic.
function startChild() {
  log(`spawning: opencode serve on :${CHILD_PORT}`);
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(CHILD_PORT)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => { log(`opencode serve exited (${code}) — shutting down`); process.exit(code ?? 1); });
}

async function waitChild() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => {
      const rq = http.get(UP + "/", (res) => { res.resume(); r(res.statusCode === 200); });
      rq.on("error", () => r(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

fs.mkdirSync(SKILLS_ROOT, { recursive: true });
startChild();
waitChild().then((ok) => {
  if (!ok) { log("opencode serve never became ready"); process.exit(1); }
  server.listen(PORT, "0.0.0.0", () => log(`listening :${PORT} -> ${UP} | skills=${SKILLS_ROOT}`));
});
