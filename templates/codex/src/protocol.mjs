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
    description: null,
    model: { id: row.model || "" },
    system: row.system || "",
    tools: [],
    mcp_servers: row.mcp_servers || [],
    metadata: null,
    version: 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function sessionResponse(row) {
  return {
    id: row.id,
    type: "session",
    agent: row.agent_id,
    environment_id: row.environment_id,
    status: row.status,
  };
}

export function textFromEvents(events) {
  const text = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== "user.message") continue;
    if (typeof event.content === "string") text.push(event.content);
    for (const part of Array.isArray(event.content) ? event.content : []) {
      if (typeof part === "string") text.push(part);
      else if (part?.type === "text" && part.text) text.push(part.text);
    }
  }
  return text.filter(Boolean).join("\n");
}

function toolName(item) {
  if (item.type === "commandExecution") return "shell";
  if (item.type === "fileChange") return "file_change";
  if (item.type === "mcpToolCall") return `${item.server || "mcp"}.${item.tool || "tool"}`;
  if (item.type === "dynamicToolCall") return item.tool || "dynamic_tool";
  return item.type || "tool";
}

function toolInput(item) {
  if (item.type === "commandExecution") return { command: item.command, cwd: item.cwd };
  if (item.type === "fileChange") return { changes: item.changes };
  return item.arguments ?? item.input ?? {};
}

function toolOutput(item) {
  if (item.type === "commandExecution") {
    return { output: item.aggregatedOutput || "", exit_code: item.exitCode ?? null };
  }
  return item.result ?? item.output ?? item.error ?? { status: item.status };
}

export function translateNotification(method, params, context = {}) {
  const model = context.model || null;
  if (method === "turn/started") return [{ event: "session.status_running", data: {} }];
  if (method === "item/agentMessage/delta" && params?.delta) {
    return [{
      event: "agent.message",
      data: { id: params.itemId, content: [{ type: "text", text: params.delta }], model },
    }];
  }
  if ((method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") && params?.delta) {
    return [{
      event: "agent.thinking",
      data: { id: params.itemId, thinking: params.delta, content: [{ type: "thinking", text: params.delta }], model },
    }];
  }
  if (method === "item/started") {
    const item = params?.item;
    if (!item || item.type === "userMessage" || item.type === "agentMessage" || item.type === "reasoning") return [];
    return [{
      event: "agent.tool_use",
      data: { id: item.id, tool_use_id: item.id, name: toolName(item), input: toolInput(item), status: item.status },
    }];
  }
  if (method === "item/completed") {
    const item = params?.item;
    if (!item) return [];
    if (item.type === "agentMessage") {
      if (!item.text || context.messageItems?.has(item.id)) return [];
      return [{
        event: "agent.message",
        data: { id: item.id, content: [{ type: "text", text: item.text }], model },
      }];
    }
    if (item.type === "userMessage" || item.type === "reasoning") return [];
    return [{
      event: "agent.tool_result",
      data: {
        id: item.id,
        tool_use_id: item.id,
        name: toolName(item),
        content: [{ type: "json", json: toolOutput(item) }],
        output: toolOutput(item),
      },
    }];
  }
  if (method === "turn/completed") {
    const failed = params?.turn?.status === "failed";
    if (failed) {
      const message = params?.turn?.error?.message || "Codex turn failed";
      return [{ event: "session.error", data: { error: { message } } }];
    }
    return [{ event: "session.status_idle", data: { stop_reason: { type: "end_turn" } } }];
  }
  if (method === "error" && !params?.willRetry) {
    return [{ event: "session.error", data: { error: { message: params?.message || "Codex app-server error" } } }];
  }
  return [];
}
