// Pure: ACP SessionNotification params → canonical stream-json frame(s).
//
// The server sends session/update notifications with this shape:
//   {
//     sessionId: "...",
//     update: {
//       sessionUpdate: "agent_message_chunk",   ← discriminator (camelCase alias)
//       content: { type: "text", text: "hello " }
//     }
//   }
//
// Handled sessionUpdate types:
//   agent_message_chunk    → stream_event content_block_delta
//   agent_message_complete → (not used in ACP — final text comes via PromptResponse
//                             or accumulated from chunks; we emit the assistant frame
//                             when the runtime calls finalAssistantFrame())
//
// For Phase 1, the runtime accumulates all chunks and calls finalAssistantFrame()
// after the prompt request resolves.
//
// All other sessionUpdate types → [] (forward-compatible).
// Empty text chunks → [] (no zero-length deltas).

export function transform(event, { sessionId, model }) {
  if (!event || typeof event !== "object") return [];

  const update = event.update;
  if (!update || typeof update !== "object") return [];

  const kind = update.sessionUpdate;  // discriminator field (camelCase alias)
  const text = update.content?.text ?? update.content?.text;

  switch (kind) {
    case "agent_message_chunk": {
      const chunkText = update.content?.text;
      if (typeof chunkText !== "string" || chunkText.length === 0) return [];
      return [
        {
          type: "stream_event",
          session_id: sessionId,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: chunkText },
          },
        },
      ];
    }

    default:
      return [];
  }
}

/**
 * Produce a final assistant frame from accumulated text after a prompt completes.
 * Called by the runtime after the session/prompt request resolves.
 */
export function finalAssistantFrame(accumulatedText, { model }) {
  return {
    type: "assistant",
    message: {
      model,
      content: [{ type: "text", text: accumulatedText }],
    },
    parent_tool_use_id: null,
  };
}
