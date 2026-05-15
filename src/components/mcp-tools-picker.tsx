"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import { ApiError, McpRow, McpToolRow, listMcpTools, listMcps } from "@/lib/api";
import { cn } from "@/lib/utils";

export type EnabledTools = Map<string, Set<string>>;
// Functional updater form — avoids stale-closure races in async callbacks.
export type EnabledToolsUpdater = (prev: EnabledTools) => EnabledTools;

interface ServerToolsState {
  status: "idle" | "loading" | "ready" | "error";
  tools: McpToolRow[];
  error?: string;
}

function mcpLabel(m: McpRow): string {
  return m.alias?.trim() || m.server_name?.trim() || m.server_id;
}

interface McpToolsPickerProps {
  value: EnabledTools;
  onChange: (v: EnabledTools | EnabledToolsUpdater) => void;
  /** Called with a map of serverId → total tool count whenever tool lists load. */
  onToolTotals?: (totals: Map<string, number>) => void;
  disabled?: boolean;
}

export function McpToolsPicker({ value, onChange, onToolTotals, disabled }: McpToolsPickerProps) {
  const [mcps, setMcps] = useState<McpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [serverTools, setServerTools] = useState<Map<string, ServerToolsState>>(new Map());

  useEffect(() => {
    listMcps()
      .catch(() => [] as McpRow[])
      .then(setMcps)
      .finally(() => setLoading(false));
  }, []);

  const sorted = useMemo(
    () => [...mcps].sort((a, b) => mcpLabel(a).localeCompare(mcpLabel(b))),
    [mcps],
  );

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
        // Notify parent of updated totals so it can distinguish "all selected"
        // from "subset selected" at submit time.
        if (onToolTotals) {
          const totals = new Map<string, number>();
          next.forEach((s, id) => { if (s.status === "ready") totals.set(id, s.tools.length); });
          onToolTotals(totals);
        }
        return next;
      });
      // Default: enable all tools if this server hasn't been touched yet.
      // Use functional updater to avoid stale-closure race when multiple
      // servers are expanded concurrently.
      onChange((prev) => {
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

  function toggleExpanded(serverId: string) {
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
    const next = new Map(value);
    const current = new Set(next.get(serverId) ?? []);
    if (current.has(toolName)) current.delete(toolName);
    else current.add(toolName);
    next.set(serverId, current);
    onChange(next);
  }

  function setAllForServer(serverId: string, enabled: boolean) {
    const state = serverTools.get(serverId);
    if (!state || state.status !== "ready") return;
    const next = new Map(value);
    next.set(serverId, enabled ? new Set(state.tools.map((t) => t.name)) : new Set());
    onChange(next);
  }

  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading MCP servers from backend…</p>;
  }

  if (sorted.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No MCP servers configured. Configure them under{" "}
        <span className="font-mono">/v1/mcp/server</span>.
      </p>
    );
  }

  return (
    <div className="rounded-lg border bg-card">
      <ul aria-label="MCP servers and tools" className="divide-y">
        {sorted.map((m) => {
          const expanded = expandedServers.has(m.server_id);
          const enabledSet = value.get(m.server_id);
          const enabledCount = enabledSet?.size ?? 0;
          const toolsState = serverTools.get(m.server_id);
          const totalCount = toolsState?.status === "ready" ? toolsState.tools.length : null;

          return (
            <li key={m.server_id}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggleExpanded(m.server_id)}
                disabled={disabled}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  enabledCount > 0 && "bg-accent/30",
                )}
              >
                <span className="grid size-4 shrink-0 place-items-center text-muted-foreground" aria-hidden>
                  {expanded
                    ? <ChevronDown className="size-3.5" />
                    : <ChevronRight className="size-3.5" />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-foreground">{mcpLabel(m)}</span>
                  {m.url ? (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{m.url}</span>
                  ) : null}
                </span>
                {enabledCount > 0 ? (
                  <span className="shrink-0 rounded-md bg-foreground/90 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-background">
                    {totalCount !== null ? `${enabledCount}/${totalCount}` : `${enabledCount} on`}
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
                    <p className="py-1 text-xs text-muted-foreground">Loading tools…</p>
                  ) : toolsState.status === "error" ? (
                    <div className="space-y-2">
                      <p className="font-mono text-xs text-destructive">
                        {toolsState.error ?? "Failed to load tools."}
                      </p>
                      <button
                        type="button"
                        onClick={() => void loadToolsForServer(m.server_id)}
                        className="text-xs text-foreground underline underline-offset-2 hover:no-underline"
                      >
                        Retry
                      </button>
                    </div>
                  ) : toolsState.tools.length === 0 ? (
                    <p className="py-1 text-xs text-muted-foreground">This server exposes no tools.</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-3 text-[11px]">
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => setAllForServer(m.server_id, true)}
                          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                        >
                          Select all
                        </button>
                        <span aria-hidden className="text-muted-foreground/60">·</span>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => setAllForServer(m.server_id, false)}
                          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
                        >
                          Clear
                        </button>
                      </div>
                      <ul className="space-y-1">
                        {toolsState.tools.map((t) => {
                          const checked = enabledSet?.has(t.name) ?? false;
                          return (
                            <li key={t.name}>
                              <label
                                className={cn(
                                  "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/40",
                                  disabled && "cursor-not-allowed opacity-60",
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
                                  {checked ? <Check className="size-3" /> : null}
                                </span>
                                <input
                                  type="checkbox"
                                  className="sr-only"
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={() => toggleTool(m.server_id, t.name)}
                                />
                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                  <span className="truncate font-mono text-[12px] text-foreground">{t.name}</span>
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
  );
}
