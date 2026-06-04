// Hermes provider: drives hermes-acp over JSON-RPC stdio and maps ACP session
// notifications to the canonical stream-json wire.
//
// This is an intentional exception to the "native SDK in-process" standard.
// No Node-native Hermes SDK exists comparable to the Codex SDK or Claude Agent
// SDK. The ACP stdio subprocess is the supported integration path for Hermes.
import { createAcpClient } from "./acp-client.mjs";
import { transform, finalAssistantFrame } from "./transformation.mjs";

export const id = "hermes";
export const aliases = ["hermes-agent", "nous-hermes"];
export const harnessId = "hermes";
export const displayName = "Hermes Agent";

export function createRuntime({ model, permissionMode, cwd, env = process.env, diagnostics = () => {} }) {
  let currentModel = model || env.HERMES_DEFAULT_MODEL || env.LITELLM_DEFAULT_MODEL || "";
  let client = null; // ACP client — lazily created on first runTurn, belongs to THIS instance
  let pendingInterrupt = false; // interrupt() called before client was ready

  return {
    get model() {
      return currentModel || "hermes";
    },
    setModel(next) {
      if (next) currentModel = next;
    },
    setPermissionMode() {
      // Phase 3: wire to ACP session/set_mode when Hermes exposes it
    },
    interrupt() {
      if (client) {
        client.cancelActivePrompt();
      } else {
        pendingInterrupt = true;
      }
    },
    async *runTurn({ prompt, session }) {
      if (!client) {
        client = await createAcpClient({ cwd, env, diagnostics });
        if (pendingInterrupt) {
          pendingInterrupt = false;
          client.cancelActivePrompt();
          return;
        }
      }

      const ctx = {
        sessionId: session.sessionId,
        model: currentModel || "hermes",
      };

      let accumulated = "";

      try {
        for await (const event of client.prompt({
          text: prompt,
          sessionCwd: cwd,
          mcpServers: session.mcpServers ?? [],
        })) {
          for (const frame of transform(event, ctx)) {
            // Accumulate text from stream_event deltas for the final assistant frame
            if (frame.type === "stream_event" && frame.event?.delta?.type === "text_delta") {
              accumulated += frame.event.delta.text;
            }
            yield frame;
          }
        }
        // Emit the final assistant frame after prompt completes
        yield finalAssistantFrame(accumulated, ctx);
      } catch (err) {
        diagnostics(`hermes runtime error: ${err?.message ?? err}\n`);
        throw err;
      }
    },
    shutdown() {
      client?.terminate();
      client = null;
    },
  };
}
