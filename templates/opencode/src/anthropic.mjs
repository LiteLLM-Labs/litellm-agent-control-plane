// Pure-logic translation layer between the Anthropic Managed Agents API spec
// and opencode. No external deps, no I/O — just data mapping. ESM (Node 20).

/**
 * Resolve a model identifier from a string or {id, speed?} shape.
 * @param {string|{id?: string}} model
 * @returns {string}
 */
export function modelId(model) {
  if (typeof model === "string") return model;
  if (model && typeof model === "object") return model.id || "";
  return "";
}

/**
 * Map a store agent row to Anthropic-shaped agent JSON.
 */
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

/**
 * Build an Anthropic session JSON object.
 */
export function sessionResponse({ id, agentId, environmentId }) {
  return {
    id,
    type: "session",
    agent: agentId,
    environment_id: environmentId ?? null,
    status: "running",
  };
}

/**
 * Collect text from Anthropic user.message events into opencode text parts.
 * @param {Array<{type: string, content?: any}>} events
 * @returns {Array<{type: "text", text: string}>}
 */
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

/**
 * Translate a single opencode SSE event into an Anthropic {event, data} pair.
 * Returns null when the event should be dropped (other session / no mapping).
 * @param {object} raw opencode event ({type, properties} or flat)
 * @param {{sessionId?: string, model?: string}} ctx
 * @returns {{event: string, data: object}|null}
 */
export function translateOpencodeEvent(raw, ctx) {
  if (!raw || typeof raw !== "object") return null;
  const props = raw.properties || raw;

  // Resolve the event's session id from the various known locations.
  const sid =
    raw.properties?.sessionID ??
    raw.sessionID ??
    raw.properties?.session_id ??
    raw.properties?.info?.sessionID ??
    raw.properties?.part?.sessionID ??
    raw.properties?.message?.sessionID;

  // Filter out events that clearly belong to another session.
  if (sid != null && sid !== ctx.sessionId) return null;

  switch (raw.type) {
    // Stream assistant tokens from deltas only. `message.part.updated` is
    // skipped: it fires for the echoed user message and again as the final
    // assistant duplicate, so emitting it would double-send and echo input.
    case "message.part.delta": {
      const thinking = thinkingText(props);
      if (thinking) return thinkingEvent(thinking, ctx.model);
      const text =
        props.delta?.text ||
        (typeof props.delta === "string" ? props.delta : "") ||
        "";
      if (!text) return null;
      return {
        event: "agent.message",
        data: {
          content: [{ type: "text", text }],
          model: ctx.model || null,
        },
      };
    }
    case "message.part.updated": {
      // Tool calls arrive as updated parts — surface them as agent.tool_use.
      // Text updates are skipped (deltas already streamed them).
      const part = props.part || {};
      if (part.type === "tool" || part.tool) {
        return toolPartEvent(part, ctx);
      }
      return null;
    }
    case "agent.thinking":
    case "agent.reasoning":
    case "thinking":
    case "thinking_delta":
    case "reasoning":
    case "reasoning-delta": {
      const thinking = thinkingText(props, { allowBareDelta: true });
      if (!thinking) return null;
      return thinkingEvent(thinking, ctx.model);
    }
    case "session.status": {
      const status = props.status?.type;
      if (status === "busy") {
        return { event: "session.status_running", data: {} };
      }
      if (status === "idle") {
        return {
          event: "session.status_idle",
          data: { stop_reason: { type: "end_turn" } },
        };
      }
      return null;
    }
    case "session.idle":
      return {
        event: "session.status_idle",
        data: { stop_reason: { type: "end_turn" } },
      };
    case "session.error":
      return {
        event: "session.error",
        data: {
          error: { message: props.error?.message || props.message || "error" },
        },
      };
    default: {
      // Best-effort tool-use mapping.
      const isTool =
        props.part?.type === "tool" ||
        (typeof raw.type === "string" && raw.type.includes("tool"));
      if (isTool) {
        return toolPartEvent(props.part || props, ctx);
      }
      return null;
    }
  }
}

function toolPartEvent(part, ctx) {
  const id = toolPartId(part, ctx);
  const name = part.tool || part.name || "tool";
  const state = part.state || {};
  const status = state.status || part.status || null;
  const rawInput = state.input ?? part.input;
  const input = status === "pending" && isEmptyObject(rawInput) ? undefined : rawInput;
  const output = state.output ?? state.result ?? part.output ?? part.result;
  const error = state.error ?? part.error;

  if (status === "completed" || error != null || output != null) {
    const data = {
      tool_use_id: id,
      name,
      tool: name,
      content: toolResultContent(output, error),
    };
    if (output !== undefined) data.output = output;
    if (error !== undefined) data.error = error;
    return {
      event: "agent.tool_result",
      data,
    };
  }

  const data = {
    id,
    name,
    tool: name,
    status,
  };
  if (input !== undefined) data.input = input;
  return {
    event: "agent.tool_use",
    data,
  };
}

function toolPartId(part, ctx) {
  return (
    part.id ||
    part.toolCallID ||
    part.tool_call_id ||
    part.callID ||
    part.messageID ||
    `${ctx.sessionId || "session"}:${part.tool || part.name || "tool"}`
  );
}

function toolResultContent(output, error) {
  const value = error ?? output ?? "";
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [{ type: "text", text: value }];
  return [{ type: "json", json: value }];
}

function isEmptyObject(value) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function thinkingText(props, { allowBareDelta = false } = {}) {
  const partType = props.part?.type;
  const isThinkingPart = partType === "thinking" || partType === "reasoning";
  return (
    props.text ||
    props.thinking ||
    props.reasoning ||
    props.delta?.thinking ||
    props.delta?.reasoning ||
    (isThinkingPart && props.delta?.text) ||
    (isThinkingPart && typeof props.delta === "string" ? props.delta : "") ||
    (allowBareDelta && typeof props.delta === "string" ? props.delta : "") ||
    props.part?.thinking ||
    props.part?.reasoning ||
    ""
  );
}

function thinkingEvent(thinking, model) {
  return {
    event: "agent.thinking",
    data: {
      thinking,
      content: [{ type: "thinking", text: thinking }],
      model: model || null,
    },
  };
}
