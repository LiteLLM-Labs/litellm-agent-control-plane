"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { PfpUpload } from "@/components/pfp-upload";
import {
  ApiError,
  McpAllowedTools,
  McpRow,
  McpToolRow,
  ModelRow,
  createAgent,
  listMcps,
  listMcpTools,
  listModels,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface ServerToolsState {
  status: "idle" | "loading" | "ready" | "error";
  tools: McpToolRow[];
  error?: string;
}

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const NAME_MAX = 64;
// The local backend hard-codes the harness to "opencode" — no template
// picker. We surface the harness id as a static label so users still see
// what they're getting.
const HARNESS_ID = "opencode";

function mcpLabel(m: McpRow): string {
  return m.alias?.trim() || m.server_name?.trim() || m.server_id;
}

export default function NewAgentPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [modelQuery, setModelQuery] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [branchOverride, setBranchOverride] = useState("");
  const [pfpUrl, setPfpUrl] = useState<string | null>(null);

  const [models, setModels] = useState<ModelRow[]>([]);
  const [mcps, setMcps] = useState<McpRow[]>([]);
  // Per-server: which tools are enabled. A missing entry = server not enabled.
  // An entry with an empty set = server enabled but every tool was unchecked
  // (treated as "not enabled" at submit time — submitting an empty whitelist
  // would be confusing).
  const [enabledTools, setEnabledTools] = useState<Map<string, Set<string>>>(
    new Map(),
  );
  // Which server cards are expanded in the UI.
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  // Lazy-fetched tools per server, keyed by server_id.
  const [serverTools, setServerTools] = useState<Map<string, ServerToolsState>>(
    new Map(),
  );
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setMetaError(null);
      try {
        const [modelsRes, mcpsRes] = await Promise.all([
          listModels().catch(() => [] as ModelRow[]),
          listMcps().catch(() => [] as McpRow[]),
        ]);
        if (cancelled) return;
        setModels(modelsRes);
        setMcps(mcpsRes);
      } catch (e) {
        if (cancelled) return;
        setMetaError(
          e instanceof ApiError ? e.message : (e as Error).message,
        );
      } finally {
        if (!cancelled) setLoadingMeta(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedMcps = useMemo(() => {
    return [...mcps].sort((a, b) => mcpLabel(a).localeCompare(mcpLabel(b)));
  }, [mcps]);

  async function loadToolsForServer(serverId: string) {
    setServerTools((prev) => {
      const next = new Map(prev);
      next.set(serverId, { status: "loading", tools: [] });
      return next;
    });
    try {
      const tools = await listMcpTools(serverId);
      setServerTools((prev) => {
        const next = new Map(prev);
        next.set(serverId, { status: "ready", tools });
        return next;
      });
      // Default behavior: if the user has not yet picked any tools for this
      // server, enable all of them — matches the old "select server" UX.
      setEnabledTools((prev) => {
        if (prev.has(serverId)) return prev;
        const next = new Map(prev);
        next.set(serverId, new Set(tools.map((t) => t.name)));
        return next;
      });
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setServerTools((prev) => {
        const next = new Map(prev);
        next.set(serverId, { status: "error", tools: [], error: msg });
        return next;
      });
    }
  }

  function toggleServerExpanded(serverId: string) {
    setExpandedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
        const existing = serverTools.get(serverId);
        if (!existing || existing.status === "error") {
          void loadToolsForServer(serverId);
        }
      }
      return next;
    });
  }

  function toggleTool(serverId: string, toolName: string) {
    setEnabledTools((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(serverId) ?? []);
      if (current.has(toolName)) current.delete(toolName);
      else current.add(toolName);
      next.set(serverId, current);
      return next;
    });
  }

  function setAllToolsForServer(serverId: string, enabled: boolean) {
    const state = serverTools.get(serverId);
    if (!state || state.status !== "ready") return;
    setEnabledTools((prev) => {
      const next = new Map(prev);
      next.set(
        serverId,
        enabled ? new Set(state.tools.map((t) => t.name)) : new Set(),
      );
      return next;
    });
  }

  // Total count of (server, tool) pairs currently enabled — drives the
  // summary line under the picker.
  const totalEnabledTools = useMemo(() => {
    let n = 0;
    for (const set of enabledTools.values()) n += set.size;
    return n;
  }, [enabledTools]);

  const sortedModels = useMemo(
    () => [...models].sort((a, b) => a.id.localeCompare(b.id)),
    [models],
  );
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return sortedModels;
    return sortedModels.filter((m) => m.id.toLowerCase().includes(q));
  }, [sortedModels, modelQuery]);

  function validate(): string | null {
    const trimmedName = name.trim();
    if (trimmedName.length > NAME_MAX) {
      return `Name must be ${NAME_MAX} characters or fewer.`;
    }
    if (!model.trim()) return "Model is required.";
    return null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      // Walk per-server tool selections. A server is "enabled" iff it has at
      // least one tool checked. If every tool of a (fully-loaded) server is
      // checked, send no whitelist for it — that lets the agent see future
      // tools added on that server without re-saving. If only a subset is
      // checked, send `mcp_allowed_tools` so the proxy can filter.
      const mcpServers: string[] = [];
      const mcpAllowedTools: McpAllowedTools[] = [];
      for (const [serverId, toolSet] of enabledTools.entries()) {
        if (toolSet.size === 0) continue;
        mcpServers.push(serverId);
        const state = serverTools.get(serverId);
        const total = state?.status === "ready" ? state.tools.length : 0;
        if (state?.status === "ready" && toolSet.size < total) {
          mcpAllowedTools.push({
            server_id: serverId,
            tools: Array.from(toolSet).sort(),
          });
        }
      }

      const created = await createAgent({
        name: name.trim() || undefined,
        model: model.trim(),
        prompt: systemPrompt.trim() || undefined,
        branch: branchOverride.trim() || undefined,
        pfp_url: pfpUrl ?? undefined,
        mcp_servers: mcpServers.length > 0 ? mcpServers : undefined,
        mcp_allowed_tools:
          mcpAllowedTools.length > 0 ? mcpAllowedTools : undefined,
      });
      router.push(`/agents/${created.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-[22px] font-semibold tracking-tight">New Agent</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick a model and a system prompt. Sessions are spawned per-agent —
        each run gets its own Fargate task.
      </p>

      <Card className="mt-6">
        <CardHeader className="sr-only">
          <CardTitle>New Agent</CardTitle>
          <CardDescription>
            Pick a model and system prompt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={onSubmit} noValidate>
            <div className="space-y-1.5">
              <Label>Profile picture</Label>
              <PfpUpload
                name={name}
                value={pfpUrl}
                onChange={setPfpUrl}
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="name">Name (optional)</Label>
              <Input
                id="name"
                value={name}
                maxLength={NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                placeholder="code-reviewer"
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Harness</Label>
              <div className="rounded-lg border bg-card px-3 py-2.5">
                <span className="text-[13px] font-medium text-foreground">
                  harness:{" "}
                  <span className="font-mono">{HARNESS_ID}</span>
                </span>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  The local backend ships a single harness. Per-agent repo +
                  branch overrides are configured below.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="branch">Branch (optional)</Label>
              <Input
                id="branch"
                value={branchOverride}
                onChange={(e) => setBranchOverride(e.target.value)}
                placeholder="default: main"
                disabled={submitting}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Pin this agent to a specific branch. Leave blank to use the
                default.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="model-search">Model</Label>
              {sortedModels.length > 0 ? (
                <>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      id="model-search"
                      type="search"
                      value={modelQuery}
                      onChange={(e) => setModelQuery(e.target.value)}
                      placeholder={`Search ${sortedModels.length} models…`}
                      disabled={submitting}
                      className="pl-8 font-mono text-xs"
                      autoComplete="off"
                    />
                  </div>
                  <div className="rounded-lg border bg-card">
                    {filteredModels.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        No models match{" "}
                        <span className="font-mono">
                          &quot;{modelQuery.trim()}&quot;
                        </span>
                        .
                      </p>
                    ) : (
                      <ul
                        role="listbox"
                        aria-label="Models"
                        className="max-h-64 divide-y overflow-y-auto"
                      >
                        {filteredModels.map((m) => {
                          const selected = m.id === model;
                          return (
                            <li key={m.id}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                onClick={() => setModel(m.id)}
                                disabled={submitting}
                                className={cn(
                                  "flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                                  selected && "bg-accent/30",
                                )}
                              >
                                <span
                                  className={cn(
                                    "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                                    selected
                                      ? "border-foreground bg-foreground text-background"
                                      : "border-border bg-transparent",
                                  )}
                                  aria-hidden
                                >
                                  {selected ? (
                                    <Check className="size-3" />
                                  ) : null}
                                </span>
                                <span className="truncate font-mono text-xs text-foreground">
                                  {m.id}
                                </span>
                                {m.owned_by ? (
                                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                                    {m.owned_by}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </>
              ) : (
                <Input
                  id="model-search"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={DEFAULT_MODEL}
                  disabled={submitting}
                  className="font-mono text-xs"
                />
              )}
              <p className="text-xs text-muted-foreground">
                {loadingMeta
                  ? "Loading models from backend…"
                  : sortedModels.length > 0
                    ? <>Selected: <span className="font-mono text-foreground">{model}</span></>
                    : "No models returned by backend. Type a model id manually."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="system-prompt">System prompt (optional)</Label>
              <Textarea
                id="system-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="You are a senior engineer reviewing code for clarity, correctness, and security."
                rows={6}
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label>MCP tools (optional)</Label>
              <p className="text-xs text-muted-foreground">
                Pick which MCP tools this agent can call. Expand a server to
                see its tools.
              </p>
              {loadingMeta ? (
                <p className="text-xs text-muted-foreground">
                  Loading MCP servers from backend…
                </p>
              ) : sortedMcps.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No MCP servers configured. Configure them under{" "}
                  <span className="font-mono">/v1/mcp/server</span>.
                </p>
              ) : (
                <div className="rounded-lg border bg-card">
                  <ul
                    aria-label="MCP servers and tools"
                    className="divide-y"
                  >
                    {sortedMcps.map((m) => {
                      const expanded = expandedServers.has(m.server_id);
                      const enabledSet = enabledTools.get(m.server_id);
                      const enabledCount = enabledSet?.size ?? 0;
                      const toolsState = serverTools.get(m.server_id);
                      const totalCount =
                        toolsState?.status === "ready"
                          ? toolsState.tools.length
                          : null;
                      return (
                        <li key={m.server_id}>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => toggleServerExpanded(m.server_id)}
                            disabled={submitting}
                            className={cn(
                              "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                              enabledCount > 0 && "bg-accent/30",
                            )}
                          >
                            <span
                              className="grid size-4 shrink-0 place-items-center text-muted-foreground"
                              aria-hidden
                            >
                              {expanded ? (
                                <ChevronDown className="size-3.5" />
                              ) : (
                                <ChevronRight className="size-3.5" />
                              )}
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-[13px] text-foreground">
                                {mcpLabel(m)}
                              </span>
                              {m.url ? (
                                <span className="truncate font-mono text-[11px] text-muted-foreground">
                                  {m.url}
                                </span>
                              ) : null}
                            </span>
                            {enabledCount > 0 ? (
                              <span className="shrink-0 rounded-md bg-foreground/90 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-background">
                                {totalCount !== null
                                  ? `${enabledCount}/${totalCount}`
                                  : `${enabledCount} on`}
                              </span>
                            ) : null}
                            {m.transport ? (
                              <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                                {m.transport}
                              </span>
                            ) : null}
                          </button>
                          {expanded ? (
                            <div className="border-t bg-muted/20 px-3 py-2">
                              {!toolsState || toolsState.status === "loading" ? (
                                <p className="py-1 text-xs text-muted-foreground">
                                  Loading tools…
                                </p>
                              ) : toolsState.status === "error" ? (
                                <div className="space-y-2">
                                  <p className="font-mono text-xs text-destructive">
                                    {toolsState.error ?? "Failed to load tools."}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void loadToolsForServer(m.server_id)
                                    }
                                    className="text-xs text-foreground underline underline-offset-2 hover:no-underline"
                                  >
                                    Retry
                                  </button>
                                </div>
                              ) : toolsState.tools.length === 0 ? (
                                <p className="py-1 text-xs text-muted-foreground">
                                  This server exposes no tools.
                                </p>
                              ) : (
                                <div className="space-y-2">
                                  <div className="flex items-center gap-3 text-[11px]">
                                    <button
                                      type="button"
                                      disabled={submitting}
                                      onClick={() =>
                                        setAllToolsForServer(m.server_id, true)
                                      }
                                      className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                                    >
                                      Select all
                                    </button>
                                    <span aria-hidden className="text-muted-foreground/60">
                                      ·
                                    </span>
                                    <button
                                      type="button"
                                      disabled={submitting}
                                      onClick={() =>
                                        setAllToolsForServer(m.server_id, false)
                                      }
                                      className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                                    >
                                      Clear
                                    </button>
                                  </div>
                                  <ul className="space-y-1">
                                    {toolsState.tools.map((t) => {
                                      const checked =
                                        enabledSet?.has(t.name) ?? false;
                                      return (
                                        <li key={t.name}>
                                          <label
                                            className={cn(
                                              "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/40",
                                              submitting &&
                                                "cursor-not-allowed opacity-60",
                                            )}
                                          >
                                            <span
                                              className={cn(
                                                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
                                                checked
                                                  ? "border-foreground bg-foreground text-background"
                                                  : "border-border bg-transparent",
                                              )}
                                              aria-hidden
                                            >
                                              {checked ? (
                                                <Check className="size-3" />
                                              ) : null}
                                            </span>
                                            <input
                                              type="checkbox"
                                              className="sr-only"
                                              checked={checked}
                                              disabled={submitting}
                                              onChange={() =>
                                                toggleTool(m.server_id, t.name)
                                              }
                                            />
                                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                              <span className="truncate font-mono text-[12px] text-foreground">
                                                {t.name}
                                              </span>
                                              {t.description ? (
                                                <span className="line-clamp-2 text-[11px] text-muted-foreground">
                                                  {t.description}
                                                </span>
                                              ) : null}
                                            </span>
                                          </label>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {totalEnabledTools > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {totalEnabledTools} tool{totalEnabledTools === 1 ? "" : "s"}{" "}
                  enabled.
                </p>
              ) : null}
            </div>

            {metaError ? (
              <p className="font-mono text-xs text-muted-foreground">
                Could not load model / MCP lists: {metaError}
              </p>
            ) : null}

            <div className="pt-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create agent"}
              </Button>
              {error ? (
                <p className="mt-3 font-mono text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
