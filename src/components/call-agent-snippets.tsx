"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { getProxyBase } from "@/lib/api";

type Lang = "curl" | "python" | "typescript";

const LANG_LABEL: Record<Lang, string> = {
  curl: "cURL",
  python: "Python",
  typescript: "TypeScript",
};

interface CallAgentSnippetsProps {
  agentId: string;
}

function curlSnippet(base: string, agentId: string): string {
  return `curl -X POST ${base}/v1/managed_agents/agents/${agentId}/session \\
  -H "Authorization: Bearer $LITELLM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "smoke test",
    "initial_prompt": "In one sentence, what is this repo?"
  }'`;
}

function pythonSnippet(base: string, agentId: string): string {
  return `import os
import httpx

BASE = "${base}"
KEY = os.environ["LITELLM_API_KEY"]
AGENT_ID = "${agentId}"

# Spawn a session — proxy provisions a Fargate task; ~50–90s the first call.
# initial_prompt is optional; if set, the first response is included inline.
with httpx.Client(timeout=420, headers={"Authorization": f"Bearer {KEY}"}) as c:
    session = c.post(
        f"{BASE}/v1/managed_agents/agents/{AGENT_ID}/session",
        json={
            "title": "smoke test",
            "initial_prompt": "In one sentence, what is this repo?",
        },
    ).json()
    print(session["response"])

    # Continue the conversation:
    reply = c.post(
        f"{BASE}/v1/managed_agents/sessions/{session['id']}/message",
        json={"text": "What about its router?"},
    ).json()
    print(reply)`;
}

function typescriptSnippet(base: string, agentId: string): string {
  return `const BASE = "${base}";
const KEY = process.env.LITELLM_API_KEY!;
const AGENT_ID = "${agentId}";

// Spawn a session — proxy provisions a Fargate task; ~50–90s the first call.
const session = await fetch(
  \`\${BASE}/v1/managed_agents/agents/\${AGENT_ID}/session\`,
  {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: "smoke test",
      initial_prompt: "In one sentence, what is this repo?",
    }),
  },
).then((r) => r.json());

console.log(session.response);

// Continue the conversation:
const reply = await fetch(
  \`\${BASE}/v1/managed_agents/sessions/\${session.id}/message\`,
  {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "What about its router?" }),
  },
).then((r) => r.json());

console.log(reply);`;
}

export function CallAgentSnippets({ agentId }: CallAgentSnippetsProps) {
  const [lang, setLang] = useState<Lang>("curl");
  const [base, setBase] = useState<string>("http://localhost:4000");
  const [copied, setCopied] = useState<boolean>(false);

  // getProxyBase reads from window.localStorage, so resolve it on mount.
  useEffect(() => {
    setBase(getProxyBase());
  }, []);

  const snippet = useMemo(() => {
    switch (lang) {
      case "curl":
        return curlSnippet(base, agentId);
      case "python":
        return pythonSnippet(base, agentId);
      case "typescript":
        return typescriptSnippet(base, agentId);
    }
  }, [lang, base, agentId]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // navigator.clipboard requires HTTPS or localhost; on http://lan-ip
      // it silently fails. Surface a fallback tooltip rather than crashing.
      setCopied(false);
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Call this agent
        </h2>
        <span className="text-[11px] text-muted-foreground">
          POST <span className="font-mono">/v1/managed_agents/...</span>
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border bg-zinc-950 text-zinc-100">
        {/* Tabs */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-2">
          <div role="tablist" aria-label="Language" className="flex">
            {(Object.keys(LANG_LABEL) as Lang[]).map((l) => {
              const active = l === lang;
              return (
                <button
                  key={l}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  onClick={() => setLang(l)}
                  className={cn(
                    "relative h-9 px-3 text-[12px] font-medium transition-colors focus-visible:outline-none",
                    active
                      ? "text-zinc-100"
                      : "text-zinc-400 hover:text-zinc-200",
                  )}
                >
                  {LANG_LABEL[l]}
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute right-0 bottom-0 left-0 h-px bg-zinc-100"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy snippet"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-300"
          >
            {copied ? (
              <>
                <Check className="size-3" aria-hidden /> Copied
              </>
            ) : (
              <>
                <Copy className="size-3" aria-hidden /> Copy
              </>
            )}
          </button>
        </div>

        <pre className="overflow-x-auto px-4 py-3 text-[12px] leading-relaxed">
          <code className="font-mono">{snippet}</code>
        </pre>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Set <span className="font-mono">LITELLM_API_KEY</span> in your
        environment. Spawn is the slowest call (≈50–90s on first invocation
        — that&rsquo;s the Fargate cold start).
      </p>
    </section>
  );
}
