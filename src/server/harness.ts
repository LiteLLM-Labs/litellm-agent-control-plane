/**
 * Opencode harness client.
 *
 * Mirrors litellm/proxy/managed_agents_endpoints/harness_client.py — same
 * endpoints, same body shape. Translates httpx.AsyncClient calls to
 * undici.fetch with AbortSignal-based timeouts.
 */

import { fetch } from "undici";

import type {
  HarnessCreateSessionOpts,
  HarnessMessage,
  HarnessMessagePart,
  HarnessMessageResponse,
  HarnessSendMessageOpts,
} from "./types";

// 60s is plenty for /session create. Message responses can run minutes when
// the model invokes tools and reads files, so callers should bump this on
// the message path (or the harness will end up disconnected mid-stream).
const DEFAULT_CREATE_TIMEOUT_MS = 60_000;
const DEFAULT_MESSAGE_TIMEOUT_MS = 600_000;

export function expandMessage(
  text?: string,
  parts?: HarnessMessagePart[],
): HarnessMessagePart[] {
  if (parts !== undefined) return parts;
  if (text !== undefined) return [{ type: "text", text }];
  throw new Error("message body must include 'text' or 'parts'");
}

async function postJson(
  url: string,
  body: unknown,
  timeout_ms: number,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout_ms),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `harness request failed: POST ${url} -> ${res.status} ${res.statusText}: ${text}`,
    );
  }
  return res.json();
}

export async function harnessCreateSession(
  opts: HarnessCreateSessionOpts,
): Promise<string> {
  const { sandbox_url, title = "default", timeout_ms = DEFAULT_CREATE_TIMEOUT_MS } =
    opts;
  let data = await postJson(
    `${sandbox_url}/session`,
    { title },
    timeout_ms,
  );
  // Harness may return a bare object OR a single-element array (proto quirk).
  if (Array.isArray(data)) {
    if (data.length === 0) {
      throw new Error(
        `unexpected harness session response: ${JSON.stringify(data)}`,
      );
    }
    data = data[0];
  }
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as { id?: unknown }).id !== "string"
  ) {
    throw new Error(
      `unexpected harness session response: ${JSON.stringify(data)}`,
    );
  }
  return (data as { id: string }).id;
}

/**
 * `GET /session/:id/message` — full thread including all intermediate
 * assistant messages (tool calls, reasoning) within each agent loop. POST
 * only returns the final assistant message, so the UI uses this list as
 * the source of truth for rendering tool/reasoning parts.
 */
export async function harnessListMessages(opts: {
  sandbox_url: string;
  harness_session_id: string;
  timeout_ms?: number;
}): Promise<HarnessMessage[]> {
  const {
    sandbox_url,
    harness_session_id,
    timeout_ms = DEFAULT_CREATE_TIMEOUT_MS,
  } = opts;
  const url = `${sandbox_url}/session/${harness_session_id}/message`;
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(timeout_ms),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `harness request failed: GET ${url} -> ${res.status} ${res.statusText}: ${text}`,
    );
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(
      `unexpected harness messages response (not array): ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return data as HarnessMessage[];
}

export async function harnessSendMessage(
  opts: HarnessSendMessageOpts,
): Promise<HarnessMessageResponse> {
  const {
    sandbox_url,
    harness_session_id,
    model,
    parts,
    timeout_ms = DEFAULT_MESSAGE_TIMEOUT_MS,
  } = opts;
  const body = {
    model: { providerID: "litellm", modelID: model },
    parts,
  };
  const data = await postJson(
    `${sandbox_url}/session/${harness_session_id}/message`,
    body,
    timeout_ms,
  );
  return data as HarnessMessageResponse;
}
