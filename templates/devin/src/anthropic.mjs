// Pure-logic translation between the Anthropic Managed Agents API spec and the
// Agent Client Protocol (ACP). No external deps, no I/O — just data mapping.
// ESM (Node 20).
//
// ACP `session/update` notifications carry an `update` object whose
// `sessionUpdate` discriminator names the variant. This module maps each
// variant to an Anthropic SSE event shape (the same shapes the opencode
// template emits), so LAP can drive a Devin runtime identically.

export function modelId(model) {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") return model.id || "";
  return "";
}

export function agentResponse(row) {
  return {
    id: row.id,
    type: "agent",
    name: row.name,
    description: row.description ?? null,
    model: { id: row.model || "" },
    system: row.system || "",
    tools: row.tools || [],
    mcp_servers: row.mcp_servers || [],
    metadata: row.metadata ?? null,
    version: 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function sessionResponse({ id, agentId, environmentId }) {
  return {
    id,
    type: "session",
    agent: agentId,
    environment_id: environmentId ?? null,
    status: "running",
  };
}

// Collect text from Anthropic user.message events into ACP ContentBlock[] for
// session/prompt. Only text parts are emitted (the baseline ACP content type).
export function partsFromEvents(events) {
  const parts = [];
  if (!Array.isArray(events)) return parts;
  for (const ev of events) {
    if (!ev || ev.type !== "user.message") continue;
    const content = ev.content;
    if (typeof content === "string") {
      if (content) parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "string") {
          if (item) parts.push({ type: "text", text: item });
        } else if (item && item.type === "text" && item.text) {
          parts.push({ type: "text", text: item.text });
        }
      }
    }
  }
  return parts;
}

// Translate a single ACP `update` object into an Anthropic {event, data} pair.
// Returns null when the update should be dropped.
//
// @param {object} update  the `update` field of an ACP session/update params
// @param {{model?: string}} ctx
// @returns {{event: string, data: object}|null}
export function translateAcpEvent(update, ctx = {}) {
  if (!update || typeof update !== "object") return null;
  const kind = update.sessionUpdate;
  const model = ctx.model || null;

  switch (kind) {
    case "agent_message_chunk": {
      const text = textOf(update.content);
      if (!text) return null;
      const data = { content: [{ type: "text", text }], model };
      if (update.messageId != null) data.messageID = update.messageId;
      return { event: "agent.message", data };
    }

    case "user_message_chunk":
      // Echoed user content — drop to avoid double-sending the user's input.
      return null;

    case "agent_thought_chunk": {
      // Streamed reasoning/thinking. Map to thinking events so LAP clients
      // see the agent's reasoning process.
      const text = textOf(update.content);
      if (!text) return null;
      const data = { thinking: text, content: [{ type: "thinking", text }], model };
      if (update.messageId != null) data.messageID = update.messageId;
      return { event: "agent.thinking", data };
    }

    case "tool_call": {
      // A "think" tool call is Devin's reasoning surface.
      if (update.kind === "think") {
        const thinking = update.title || textOfToolContent(update.content) || "";
        if (!thinking) return null;
        return {
          event: "agent.thinking",
          data: {
            thinking,
            content: [{ type: "thinking", text: thinking }],
            model,
          },
        };
      }
      const id = update.toolCallId || "tool";
      const name = update.title || update.kind || "tool";
      const data = { id, name, tool: name, status: update.status || "pending" };
      if (update.rawInput !== undefined) data.input = update.rawInput;
      return { event: "agent.tool_use", data };
    }

    case "tool_call_update": {
      const id = update.toolCallId || "tool";
      const status = update.status;
      const content = update.content;
      // Only emit a tool_result for terminal statuses. Intermediate updates
      // with content are preserved as in-progress tool_use events so clients
      // don't prematurely terminate the tool invocation.
      if (status === "completed" || status === "failed") {
        const out = toolResultContent(content);
        const data = { tool_use_id: id, content: out };
        return { event: "agent.tool_result", data };
      }
      // In-progress / pending status update (may carry partial content).
      const data = { id, status: status || "in_progress" };
      if (Array.isArray(content) && content.length > 0) data.content = content;
      return { event: "agent.tool_use", data };
    }

    case "plan":
      // Plans aren't part of the Anthropic event set; surface as thinking so
      // the user still sees the agent's intent.
      return planToThinking(update, model);

    case "usage_update":
    case "config_option_update":
      return null;

    default:
      return null;
  }
}

// Map an ACP prompt-response stopReason to a terminal Anthropic event.
export function stopReasonEvent(stopReason) {
  const type = stopReasonToType(stopReason);
  return { event: "session.status_idle", data: { stop_reason: { type } } };
}

export function runningEvent() {
  return { event: "session.status_running", data: {} };
}

export function errorEvent(message) {
  return { event: "session.error", data: { error: { message } } };
}

function stopReasonToType(stopReason) {
  switch (stopReason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "max_turn_requests":
      return "max_turn_requests";
    case "refusal":
      return "refusal";
    case "cancelled":
      return "cancelled";
    default:
      return "end_turn";
  }
}

function textOf(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

function textOfToolContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (c?.type === "content") parts.push(textOf(c.content));
    else if (c?.type === "text") parts.push(textOf(c));
  }
  return parts.join("");
}

function toolResultContent(content) {
  if (!Array.isArray(content) || !content.length) return [{ type: "text", text: "" }];
  const out = [];
  for (const c of content) {
    if (c?.type === "content") {
      const inner = c.content;
      if (inner?.type === "text") out.push({ type: "text", text: inner.text || "" });
      else if (inner) out.push({ type: "json", json: inner });
    } else if (c?.type === "diff") {
      out.push({ type: "text", text: diffToText(c) });
    } else if (c?.type === "text") {
      out.push({ type: "text", text: c.text || "" });
    } else {
      out.push({ type: "json", json: c });
    }
  }
  return out.length ? out : [{ type: "text", text: "" }];
}

function diffToText(diff) {
  const header = `diff: ${diff.path || "(unknown)"}`;
  if (diff.oldText == null) return `${header}\n${diff.newText || ""}`;
  return `${header}\n--- old\n${diff.oldText}\n+++ new\n${diff.newText || ""}`;
}

function planToThinking(update, model) {
  const entries = Array.isArray(update.entries) ? update.entries : [];
  const text = entries
    .map((e) => `- [${e.status || "pending"}] ${e.content || ""}`)
    .join("\n")
    .trim();
  if (!text) return null;
  return {
    event: "agent.thinking",
    data: { thinking: text, content: [{ type: "thinking", text }], model },
  };
}
