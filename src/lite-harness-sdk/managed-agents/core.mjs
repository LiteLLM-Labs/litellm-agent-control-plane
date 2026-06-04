// core.mjs — shared primitives: ids, event factories, HTTP error/response helpers.
// Pure Node, no deps beyond node:crypto.
import { randomUUID } from "node:crypto";

// ── ids / time ──────────────────────────────────────────────────────────────

/** `${prefix}_<32 hex>` — stable id format for sessions and events. */
export function genId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export const SUPPORTED_HARNESSES = ["claude-code", "codex", "pi-ai", "hermes"];

// ── event factories ──────────────────────────────────────────────────────────
// Each returns a BARE event {type, ...payload}. The event store stamps
// id / session_id / created_at at publish time.

export function userMessageEvent(content) {
  return { type: "user.message", content: normalizeContent(content) };
}

export function agentMessageEvent(content) {
  return { type: "agent.message", content: normalizeContent(content) };
}

export function agentToolUseEvent({ name, input, tool_use_id }) {
  return { type: "agent.tool_use", name, input: input ?? {}, tool_use_id };
}

export function agentToolResultEvent({ tool_use_id, content, is_error = false }) {
  return { type: "agent.tool_result", tool_use_id, content, is_error: Boolean(is_error) };
}

export function sessionIdleEvent({ usage = {}, total_cost_usd = 0 } = {}) {
  return { type: "session.status_idle", usage, total_cost_usd };
}

export function sessionErrorEvent(message) {
  return { type: "session.status_error", error: String(message ?? "unknown error") };
}

/** Accept a plain string or an array of content blocks; always return blocks. */
function normalizeContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Write a JSON response with the given status. */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Write a `{ error: { message } }` JSON response. */
export function sendError(res, status, message) {
  sendJson(res, status, { error: { message: String(message) } });
}
