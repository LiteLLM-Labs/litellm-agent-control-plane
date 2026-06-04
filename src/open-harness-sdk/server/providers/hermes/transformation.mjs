// Pure: ACP session notification params → canonical stream-json frame(s).
//
// ACP event types handled (confirm exact names against hermes-acp in Phase 0):
//   agent_message_chunk    { text: string }  → stream_event content_block_delta
//   agent_message_complete { text: string }  → assistant frame
//
// All other event types → [] (forward-compatible).
// Empty text chunks → [] (no zero-length deltas).
export function transform(event, { sessionId, model }) {
  if (!event || typeof event !== "object") return [];

  switch (event.type) {
    case "agent_message_chunk": {
      const text = event.text;
      if (typeof text !== "string" || text.length === 0) return [];
      return [
        {
          type: "stream_event",
          session_id: sessionId,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
        },
      ];
    }

    case "agent_message_complete": {
      const text = typeof event.text === "string" ? event.text : "";
      return [
        {
          type: "assistant",
          message: {
            model,
            content: [{ type: "text", text }],
          },
          parent_tool_use_id: null,
        },
      ];
    }

    default:
      return [];
  }
}
