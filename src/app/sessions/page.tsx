"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentAvatar } from "@/components/agent-avatar";
import {
  AgentRow,
  ApiError,
  SessionRow,
  deleteSession,
  listAgents,
  listSessions,
} from "@/lib/api";

const POLL_INTERVAL_MS = 5000;
const ALL_FILTER = "__all__";

function statusDotClass(status: string): string {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "creating":
      return "bg-amber-500";
    case "failed":
      return "bg-red-500";
    case "dead":
      return "bg-muted-foreground";
    default:
      return "bg-muted-foreground";
  }
}

function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function SessionsListPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>(ALL_FILTER);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTargetId || deleting) return;
    setDeleting(true);
    try {
      await deleteSession(deleteTargetId);
      setDeleteTargetId(null);
      void load();
    } catch (e) {
      setDeleteTargetId(null);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sessionsRes, agentsRes] = await Promise.all([
        listSessions(),
        listAgents(),
      ]);
      setSessions(sessionsRes);
      setAgents(agentsRes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const agentById = useMemo(() => {
    const m = new Map<string, AgentRow>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name?.trim() || a.id);
    return m;
  }, [agents]);

  const agentChips = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of sessions) {
      if (seen.has(s.agent_id)) continue;
      const name = agentNameById.get(s.agent_id) ?? s.agent_id;
      seen.set(s.agent_id, name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [sessions, agentNameById]);

  const filteredSessions = useMemo(() => {
    if (activeFilter === ALL_FILTER) return sessions;
    return sessions.filter((s) => s.agent_id === activeFilter);
  }, [sessions, activeFilter]);

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight leading-none">
            Sessions
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Refresh"
          className="h-8 px-2 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </header>

      {agentChips.length > 0 ? (
        <div className="mt-6 flex flex-wrap items-center gap-1">
          <FilterChip
            label="All"
            count={sessions.length}
            active={activeFilter === ALL_FILTER}
            onClick={() => setActiveFilter(ALL_FILTER)}
          />
          {agentChips.map((chip) => (
            <FilterChip
              key={chip.id}
              label={chip.name}
              count={sessions.filter((s) => s.agent_id === chip.id).length}
              active={activeFilter === chip.id}
              onClick={() => setActiveFilter(chip.id)}
            />
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="mt-6 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {filteredSessions.length === 0 && !loading ? (
        <div className="mt-10 rounded-lg border border-dashed bg-card/40 px-6 py-16 text-center text-sm text-muted-foreground">
          {sessions.length === 0
            ? "No sessions yet. Open an agent and click Spawn session."
            : "No sessions match this filter."}
        </div>
      ) : (
        <ul className="group mt-8 overflow-hidden rounded-lg border bg-card">
          {filteredSessions.map((s, i) => {
            const agent = agentById.get(s.agent_id);
            const agentName = agentNameById.get(s.agent_id) ?? s.agent_id;
            return (
              <li
                key={s.id}
                onClick={() => router.push(`/sessions/${s.id}`)}
                className={
                  "flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 " +
                  (i > 0 ? "border-t" : "")
                }
              >
                <div className="relative shrink-0">
                  <AgentAvatar
                    name={agentName}
                    pfpUrl={agent?.pfp_url ?? null}
                    size={32}
                  />
                  <span
                    aria-label={`status ${s.status}`}
                    title={s.status}
                    className={`absolute -right-0.5 -bottom-0.5 inline-block size-2.5 rounded-full ring-2 ring-card ${statusDotClass(s.status)}`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/agents/${s.agent_id}`);
                    }}
                    className="rounded-sm text-[14px] font-medium text-foreground transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {agentName}
                  </button>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {s.id}
                  </div>
                </div>
                <span
                  className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline"
                  title={s.sandbox_url ?? undefined}
                >
                  {s.sandbox_url
                    ? s.sandbox_url.replace(/^https?:\/\//, "")
                    : "—"}
                </span>
                <span className="shrink-0 tabular-nums text-[12px] text-muted-foreground">
                  {formatRelative(s.created_at)}
                </span>
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      type="button"
                      className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label="Actions"
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => setDeleteTargetId(s.id)}
                      >
                        <Trash2 className="mr-2 size-3.5" />
                        Delete session
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!deleteTargetId} onOpenChange={(open) => { if (!open && !deleting) setDeleteTargetId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete session</DialogTitle>
            <DialogDescription>
              Delete this session? The conversation history will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTargetId(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface FilterChipProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}

function FilterChip({ label, count, active, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
        (active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground")
      }
    >
      <span className="font-medium">{label}</span>
      <span
        className={
          "tabular-nums text-[11px] " +
          (active ? "text-muted-foreground" : "text-muted-foreground/70")
        }
      >
        {count}
      </span>
    </button>
  );
}
