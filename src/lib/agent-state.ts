/**
 * agent-state.ts — the single reducer that folds an opencode `/event` stream
 * into renderable message state.
 *
 * ONE implementation, imported by every surface (web UI, Slack, Linear), so a
 * session started on any channel renders identically everywhere. The input is
 * the verbatim opencode bus frame relayed by
 *   GET /api/v1/managed_agents/sessions/:id/stream
 * — no harness-specific shapes, so this works for opencode, claude-agent-sdk,
 * or any future harness that emits the opencode `/event` contract.
 *
 * Usage (seed then subscribe — opencode's /event does NOT replay past frames):
 *   let state = seedFromHistory(await listMessages(id)); // GET /session/:id/message
 *   for await (const ev of subscribe(id)) {              // GET .../stream
 *     state = applyEvent(state, ev);
 *     render(state);
 *   }
 */

export interface AgentPart {
  id: string;
  type: string; // "text" | "thinking" | "tool" | "image" | string
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    input?: unknown;
    status?: string;
    output?: string;
    error?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface AgentMessage {
  id: string;
  role: string; // "user" | "assistant" | string
  parts: AgentPart[];
}

/** A pending permission request the agent is blocked on (opencode asks before
 *  running a tool unless the config auto-allows it). `sessionID` may be a child
 *  (subagent) session — respond against THAT session. */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  title: string;
  tool?: string;
}

export interface AgentState {
  /** insertion-ordered messages */
  messages: AgentMessage[];
  /** true once the agent loop returns control (session.idle / session.aborted) */
  idle: boolean;
  /** set on session.error */
  error?: string;
  /** permission prompts the agent is currently blocked on */
  permissions: PermissionRequest[];
}

/** A verbatim opencode bus frame, as relayed by the /stream endpoint. */
export interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export function initState(): AgentState {
  return { messages: [], idle: false, permissions: [] };
}

// ── internal immutable helpers (new refs along the changed path → React-safe) ──

function withMessage(
  state: AgentState,
  id: string,
  role: string,
  mut: (m: AgentMessage) => AgentMessage,
): AgentState {
  const idx = state.messages.findIndex((m) => m.id === id);
  const base: AgentMessage =
    idx >= 0 ? state.messages[idx] : { id, role, parts: [] };
  const next = mut(base);
  const messages =
    idx >= 0
      ? state.messages.map((m, i) => (i === idx ? next : m))
      : [...state.messages, next];
  return { ...state, messages };
}

function setPart(message: AgentMessage, part: AgentPart): AgentMessage {
  const idx = message.parts.findIndex((p) => p.id === part.id);
  const parts =
    idx >= 0
      ? message.parts.map((p, i) => (i === idx ? part : p))
      : [...message.parts, part];
  return { ...message, parts };
}

function appendDelta(
  message: AgentMessage,
  partID: string,
  field: "text" | "thinking" | "reasoning",
  delta: string,
): AgentMessage {
  const idx = message.parts.findIndex((p) => p.id === partID);
  const prev: AgentPart =
    idx >= 0 ? message.parts[idx] : { id: partID, type: field, text: "" };
  // A part can flip text<->thinking mid-stream; trust the latest field.
  const next: AgentPart = {
    ...prev,
    type: field,
    text: (prev.text ?? "") + delta,
  };
  const parts =
    idx >= 0
      ? message.parts.map((p, i) => (i === idx ? next : p))
      : [...message.parts, next];
  return { ...message, parts };
}

// ── the reducer ───────────────────────────────────────────────────────────────

/**
 * Fold one opencode bus frame into the running state. Pure: returns a new
 * AgentState (with new refs only along the changed path) or the same state
 * for no-op frames (stream.opened, server.*, message.updated for users, …).
 */
export function applyEvent(state: AgentState, ev: OpencodeEvent): AgentState {
  const p = ev.properties ?? {};
  switch (ev.type) {
    case "message.updated": {
      const info = p.info as { id?: string; role?: string } | undefined;
      if (!info?.id) return state;
      return withMessage(state, info.id, info.role ?? "assistant", (m) => m);
    }
    case "message.part.delta": {
      const messageID = p.messageID as string | undefined;
      const partID = p.partID as string | undefined;
      const delta = p.delta as string | undefined;
      const field = p.field as string | undefined;
      if (!messageID || !partID || delta === undefined) return state;
      if (field !== "text" && field !== "thinking" && field !== "reasoning")
        return state;
      return withMessage(state, messageID, "assistant", (m) =>
        appendDelta(m, partID, field, delta),
      );
    }
    case "message.part.updated": {
      const part = p.part as (AgentPart & { messageID?: string }) | undefined;
      // opencode carries messageID INSIDE the part; the claude-agent-sdk
      // harness puts it on properties. Accept either. The message role is set
      // by message.updated (which precedes), so the create-if-missing default
      // here is just a fallback.
      const messageID =
        part?.messageID ?? (p.messageID as string | undefined);
      if (!messageID || !part?.id) return state;
      return withMessage(state, messageID, "assistant", (m) =>
        setPart(m, part),
      );
    }
    case "permission.updated": {
      // properties IS the Permission object: { id, type, title, sessionID, ... }
      const id = p.id as string | undefined;
      if (!id) return state;
      const req: PermissionRequest = {
        id,
        sessionID: (p.sessionID as string) ?? "",
        title: (p.title as string) ?? (p.type as string) ?? "permission",
        tool: p.type as string | undefined,
      };
      return {
        ...state,
        permissions: [...state.permissions.filter((x) => x.id !== id), req],
      };
    }
    case "permission.replied": {
      const pid = p.permissionID as string | undefined;
      if (!pid) return state;
      return {
        ...state,
        permissions: state.permissions.filter((x) => x.id !== pid),
      };
    }
    case "session.error": {
      const message = (p.message as string) ?? "agent error";
      return { ...state, error: message, idle: true };
    }
    case "session.idle":
    case "session.aborted":
      return state.idle ? state : { ...state, idle: true };
    default:
      return state;
  }
}

// ── shared turn view (text + "doing now" subtext) ────────────────────────────
// One place that turns folded state into a renderable summary, used by the
// integration dispatchers (Slack/Linear) to post a streaming message: the
// assistant text plus a one-line activity derived from the latest tool/thinking
// part.

export interface TurnView {
  /** Assistant text accumulated so far this turn. */
  text: string;
  /** Current activity subtext (e.g. "Reading: …/file.py"), "" when none. */
  activity: string;
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === "string" && v) return v;
  return "";
}

function toolActivity(name: string, rawInput: unknown): string {
  const o = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<
    string,
    unknown
  >;
  const path = firstString(o.file_path, o.path, o.filePath, o.notebook_path);
  const cmd = firstString(o.command);
  const pattern = firstString(o.pattern, o.query);
  const n = (name || "").toLowerCase();
  if (n.includes("todo") || n.includes("plan")) return "Updating plan";
  if (n === "read" || n.includes("read") || n === "cat")
    return path ? `Reading: ${path}` : "Reading a file";
  if (n === "bash" || n.includes("shell") || n.includes("exec"))
    return cmd ? `Running: ${cmd}` : "Running a command";
  if (n.includes("edit") || n.includes("write") || n.includes("patch") || n.includes("apply"))
    return path ? `Editing: ${path}` : "Editing a file";
  if (n.includes("grep") || n.includes("search") || n.includes("glob") || n.includes("find"))
    return pattern ? `Searching: ${pattern}` : "Searching the repo";
  if (n.includes("browser") || n.includes("screenshot")) return "Using the browser";
  return name ? `Using ${name}` : "Working";
}

/**
 * Derive {text, activity} from folded state. `text` is every assistant text
 * part concatenated; `activity` reflects the last part — a tool call shows what
 * it's doing, a trailing thinking part shows "Thinking…", and text clears it.
 * Reset the state per turn (on session.idle) so this reflects the current turn.
 */
export function deriveTurnView(state: AgentState): TurnView {
  const texts: string[] = [];
  let activity = "";
  for (const m of state.messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type === "text" && p.text) {
        texts.push(p.text);
        activity = "";
      } else if (p.type === "thinking") {
        activity = "Thinking…";
      } else if (p.type === "tool") {
        activity = toolActivity(p.tool ?? "", p.state?.input);
      }
    }
  }
  return { text: texts.join("\n\n"), activity };
}

/**
 * Seed state from a history snapshot (GET /session/:id/message → an array of
 * { info: {id, role}, parts: [...] }). Call before subscribing so a client
 * joining mid-turn (e.g. the UI opening a Slack-started session) doesn't start
 * empty — opencode's /event does not replay past frames.
 */
export function seedFromHistory(
  history: Array<{
    info?: { id?: string; role?: string };
    parts?: AgentPart[];
  }>,
): AgentState {
  const messages: AgentMessage[] = [];
  for (const h of history) {
    if (!h.info?.id) continue;
    messages.push({
      id: h.info.id,
      role: h.info.role ?? "assistant",
      parts: Array.isArray(h.parts) ? h.parts : [],
    });
  }
  return { messages, idle: true, permissions: [] };
}
