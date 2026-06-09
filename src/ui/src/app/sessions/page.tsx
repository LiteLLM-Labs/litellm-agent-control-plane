"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUp, Bot, Mic, Paperclip } from "lucide-react";
import { BrandIcon } from "@/components/brand-icons";
import { Sidebar } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createAgent,
  createSession,
  listRuntimeHarnesses,
  listAgents,
  listSessions,
} from "@/lib/api";
import type { Agent, AgentRuntimeId, RuntimeHarness, BuiltinRuntimeId } from "@/lib/types";
import { resolveApiSpec } from "@/lib/types";

const NEW_AGENT_VALUE = "__new_agent__";
const CLAUDE_RUNTIME: AgentRuntimeId = "claude_managed_agents";

function runtimeIconId(id: string) {
  if (id === "gemini_antigravity") return "gemini";
  return id === "claude_managed_agents" || id === "claude_agents" ? "claude" : id;
}

function runtimeLabel(runtime: RuntimeHarness | string): string {
  if (typeof runtime !== "string") return runtime.display_name;
  if (runtime === "claude_managed_agents") return "Claude Agents";
  if (runtime === "cursor") return "Cursor";
  if (runtime === "gemini_antigravity") return "Gemini Antigravity";
  if (runtime === "opencode") return "OpenCode";
  if (runtime === "claude-code" || runtime === "cc") return "Claude Code";
  return runtime;
}

function runtimeSubtitle(harness: RuntimeHarness): string {
  if (!harness.connected) return "missing key";
  if (harness.api_spec === "claude_managed_agents") return "Anthropic sessions and tools";
  if (harness.api_spec === "cursor") return "Background repo agents";
  if (harness.api_spec === "gemini_antigravity") return "Google managed agent sandbox";
  if (harness.api_spec === "opencode") return "OpenCode server sessions";
  return "Managed runtime sessions";
}

function modelForApiSpec(apiSpec: BuiltinRuntimeId): string {
  if (apiSpec === "claude_managed_agents") return "claude-sonnet-4-6";
  if (apiSpec === "gemini_antigravity") return "antigravity-preview-05-2026";
  if (apiSpec === "opencode") return "opencode/default";
  return "claude-4-sonnet";
}

function runtimeRoutePrefix(apiSpec: BuiltinRuntimeId | ""): string {
  if (apiSpec === "claude_managed_agents") return "anthropic/*";
  if (apiSpec === "cursor") return "cursor/*";
  if (apiSpec === "gemini_antigravity") return "gemini/*";
  if (apiSpec === "opencode") return "opencode/*";
  return "runtime/*";
}

function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return typeof value === "string" && value.length > 0;
}

function configuredRuntime(agent: Agent | null): AgentRuntimeId | "" {
  if (!agent) return "";
  const config = agent.config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const runtime = (config as { runtime?: unknown }).runtime;
    if (isAgentRuntimeId(runtime)) return runtime;
  }
  return isAgentRuntimeId(agent.harness) ? agent.harness : "";
}

function promptTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "New agent session";
  return compact.length > 46 ? `${compact.slice(0, 46).trimEnd()}…` : compact;
}

function isDbBackedAgent(agent: Agent): boolean {
  return agent.id.startsWith("agent_");
}

function cursorEnvironment(repository: string, ref: string): Record<string, unknown> {
  return {
    repository: repository.trim(),
    ref: ref.trim() || "main",
    target_branch: "agent/{agent_id}/{session_id}",
    auto_create_pr: false,
  };
}

function SessionsStart() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedAgentId, setSelectedAgentId] = useState(searchParams.get("agent") ?? "");
  const [prompt, setPrompt] = useState("");
  const [runtime, setRuntime] = useState<AgentRuntimeId | "">("");
  const [harnesses, setHarnesses] = useState<RuntimeHarness[]>([]);
  const [savedAgents, setSavedAgents] = useState<Agent[]>([]);
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("main");
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const [agentCount, setAgentCount] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listRuntimeHarnesses(), listSessions(), listAgents()])
      .then(([nextHarnesses, nextSessions, nextAgents]) => {
        setHarnesses(nextHarnesses);
        setRuntime((current) => {
          if (current && nextHarnesses.some((item) => item.alias === current)) return current;
          return nextHarnesses.find((item) => item.alias === CLAUDE_RUNTIME)?.alias ?? nextHarnesses[0]?.alias ?? "";
        });
        setSessionCount(nextSessions.length);
        setAgentCount(nextAgents.length);
        setSavedAgents(nextAgents);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load runtimes"));
  }, []);

  const selectedRuntime = useMemo(
    () => harnesses.find((item) => item.alias === runtime),
    [runtime, harnesses],
  );
  const selectedAgent = useMemo(
    () => savedAgents.find((agent) => agent.id === selectedAgentId) ?? null,
    [savedAgents, selectedAgentId],
  );
  const selectedAgentRuntime = configuredRuntime(selectedAgent);
  const selectedAgentMissing = selectedAgentId !== "" && selectedAgent === null;
  const selectedAgentIsConfigured = Boolean(selectedAgent && !isDbBackedAgent(selectedAgent));
  const needsRuntime = !selectedAgentIsConfigured;
  const needsPrompt = !selectedAgent;
  const canStart =
    (!needsPrompt || prompt.trim().length > 0) &&
    !starting &&
    !selectedAgentMissing &&
    (!needsRuntime ||
      (runtime !== "" &&
        Boolean(selectedRuntime?.connected) &&
        (resolveApiSpec(runtime, harnesses) !== "cursor" || repository.trim().length > 0)));

  useEffect(() => {
    if (!selectedAgentRuntime) return;
    if (!harnesses.some((item) => item.alias === selectedAgentRuntime)) return;
    setRuntime(selectedAgentRuntime);
  }, [harnesses, selectedAgentRuntime]);

  const startSession = async () => {
    const trimmed = prompt.trim();
    const runtimeId = runtime;
    if (selectedAgentMissing) {
      setError("Selected agent is no longer available.");
      return;
    }
    if (
      starting ||
      !canStart ||
      (needsRuntime && !runtimeId) ||
      (needsPrompt && !trimmed)
    ) {
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const title = selectedAgent ? `${selectedAgent.name} session` : promptTitle(trimmed);
      let shouldAutostartPrompt = Boolean(trimmed);
      const session =
        selectedAgent && !isDbBackedAgent(selectedAgent)
          ? await createSession(title, selectedAgent.id)
          : await (async () => {
              const runtimeForSession = runtimeId as AgentRuntimeId;
              const runtimeSpec = resolveApiSpec(runtimeForSession, harnesses);
              const agent =
                selectedAgent ??
                (await createAgent({
                  name: title,
                  owner_id: "default",
                  description: `Started from ${runtimeLabel(selectedRuntime ?? runtimeForSession)} landing prompt.`,
                  model: runtimeSpec ? modelForApiSpec(runtimeSpec) : "claude-sonnet-4-6",
                  runtime: runtimeForSession,
                  harness: "claude-code",
                  system: "You are a helpful managed agent. Use available tools when they help complete the user's request.",
                  tools: [{ type: "agent_toolset_20260401" }],
                  mcp_servers: [],
                  skills: [],
                }));
              const environment =
                runtimeSpec === "cursor" ? cursorEnvironment(repository, ref) : {};
              shouldAutostartPrompt = false;
              return createSession(title, agent.id, {
                runtime: runtimeForSession,
                prompt: trimmed || undefined,
                environment,
              });
            })();
      const params = new URLSearchParams({
        id: session.id,
      });
      if (trimmed && shouldAutostartPrompt) {
        params.set("prompt", trimmed);
        params.set("autostart", "1");
      }
      router.push(`/chat/?${params.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start session");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <main id="main-content" className="relative flex min-w-0 flex-1 overflow-hidden bg-background text-foreground">
        <div
          aria-hidden
          className="absolute inset-0 opacity-80"
          style={{
            backgroundImage:
              "radial-gradient(circle at center, rgba(59, 130, 246, 0.18) 1px, transparent 1.4px)",
            backgroundSize: "10px 10px",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[48%] opacity-70"
          style={{
            background:
              "radial-gradient(ellipse at 52% 15%, rgba(59,130,246,0.26), rgba(59,130,246,0.08) 42%, transparent 72%)",
          }}
        />

        <section className="relative z-10 flex min-h-full w-full flex-col items-center justify-center px-6 py-12">
          <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card shadow-lg backdrop-blur">
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void startSession();
                }
              }}
              placeholder={selectedAgent ? "Optional first message" : "Ask or build anything"}
              aria-label="Session prompt"
              className="min-h-24 resize-none border-0 bg-transparent px-4 py-4 text-[15px] shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0 dark:text-foreground"
            />
            <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-3 py-3">
              <Select
                value={selectedAgentId || NEW_AGENT_VALUE}
                onValueChange={(value) => {
                  const next = value ?? "";
                  const nextAgentId = next === NEW_AGENT_VALUE ? "" : next;
                  setSelectedAgentId(nextAgentId);
                  const nextAgent = savedAgents.find((agent) => agent.id === nextAgentId) ?? null;
                  const nextRuntime = configuredRuntime(nextAgent);
                  if (nextRuntime) setRuntime(nextRuntime);
                }}
              >
                <SelectTrigger className="h-10 w-auto min-w-[230px] max-w-[320px] rounded-full border border-border bg-background px-3 text-left text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Agent
                    </span>
                    <span className="truncate text-sm font-medium">
                      {selectedAgent?.name ?? "New managed agent"}
                    </span>
                  </span>
                </SelectTrigger>
                <SelectContent className="w-[340px]">
                  <SelectItem value={NEW_AGENT_VALUE} className="py-3">
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                        <Bot className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">New managed agent</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          Create one from this prompt
                        </span>
                      </span>
                    </span>
                  </SelectItem>
                  {savedAgents.length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        Saved agents
                      </div>
                      {savedAgents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id} className="py-3">
                          <span className="block truncate text-sm font-medium">{agent.name}</span>
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>

              <Select value={runtime} onValueChange={(value) => setRuntime((value ?? "") as AgentRuntimeId | "")}>
                <SelectTrigger className="h-10 w-auto min-w-[260px] max-w-[340px] rounded-full border border-border bg-background px-3 text-left text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Runtime
                    </span>
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
                      <BrandIcon id={runtimeIconId(runtime)} className="size-4" />
                    </span>
                    <span className="truncate text-sm font-medium">
                      {selectedRuntime?.display_name ?? (runtime ? runtimeLabel(runtime) : "Select runtime")}
                    </span>
                  </span>
                </SelectTrigger>
                <SelectContent className="w-[340px]">
                  {harnesses.map((item) => (
                    <SelectItem key={item.alias} value={item.alias} disabled={!item.connected} className="py-3">
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
                          <BrandIcon id={runtimeIconId(item.alias)} className="size-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{item.display_name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {runtimeSubtitle(item)}
                          </span>
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="hidden rounded-full border border-border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground 2xl:inline">
                {selectedAgentIsConfigured ? "agent/*" : runtimeRoutePrefix(resolveApiSpec(runtime, harnesses) ?? "")}
              </span>
              <Button variant="ghost" size="icon-sm" disabled aria-label="Voice input (coming soon)" className="ml-auto hidden text-[#5d5a55] 2xl:inline-flex">
                <Mic className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" disabled aria-label="Attach file (coming soon)" className="hidden text-[#5d5a55] 2xl:inline-flex">
                <Paperclip className="size-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void startSession()}
                disabled={!canStart}
                className="ml-auto rounded-full"
                aria-label="Start session"
              >
                <ArrowUp className="size-4" />
                <span>Run</span>
              </Button>
            </div>
            {resolveApiSpec(runtime, harnesses) === "cursor" && (
              <div className="grid gap-2 border-t border-border bg-muted/40 px-4 py-3 sm:grid-cols-[1fr_120px]">
                <Input
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="https://github.com/org/repo"
                  className="h-8 border-border bg-background text-sm"
                />
                <Input
                  value={ref}
                  onChange={(event) => setRef(event.target.value)}
                  placeholder="main"
                  className="h-8 border-border bg-background text-sm"
                />
              </div>
            )}
            {error && (
              <div className="border-t border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>

          <div className="mt-5 grid w-full max-w-2xl gap-3 sm:grid-cols-3">
            <MetricCard title="Sessions" value={sessionCount} />
            <MetricCard title="Saved agents" value={agentCount} />
            <MetricCard
              title="Connected runtimes"
              value={harnesses.filter((item) => item.connected).length}
            />
          </div>

          <div className="absolute bottom-6 rounded-full border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
            <span className="mr-2 inline-block size-2 rounded-full bg-[#b7b3ad]" />
            {selectedAgentIsConfigured
              ? `${selectedAgent?.name} ready`
              : selectedRuntime?.connected
                ? `${selectedRuntime.display_name} ready`
                : "Runtime key missing"}
          </div>
        </section>
      </main>
    </div>
  );
}

export default function SessionsPage() {
  return (
    <Suspense>
      <SessionsStart />
    </Suspense>
  );
}

function MetricCard({
  title,
  value,
}: {
  title: string;
  value: number | null;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/90 p-4 shadow-sm backdrop-blur">
      <div className="text-sm text-muted-foreground">{title}</div>
      <div className="mt-1 text-3xl tracking-tight text-foreground">
        {value === null ? "..." : value.toLocaleString()}
      </div>
      <div className="mt-4 h-1.5 rounded-full bg-black/5">
        <div
          className="h-full rounded-full bg-blue-600/50"
          style={{ width: `${Math.min(100, Math.max(12, (value ?? 0) * 12))}%` }}
        />
      </div>
    </div>
  );
}
