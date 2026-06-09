"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Inbox as InboxIcon,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ToolApprovalPanel } from "@/components/tool-approval-panel";
import {
  acceptApproval,
  listInbox,
  rejectApproval,
  resolveInboxItem,
  type InboxFilter,
  type InboxItem,
} from "@/lib/api";

function timeAgo(ts?: number | null): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function formatDate(ts?: number | null): string {
  if (!ts) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

const TABS: { key: InboxFilter; label: string }[] = [
  { key: "attention", label: "Attention" },
  { key: "completed", label: "Completed" },
  { key: "all", label: "All" },
];

const statusStyles: Record<string, { label: string; cls: string }> = {
  pending: { label: "Needs approval", cls: "border-border bg-muted/50 text-foreground" },
  open: { label: "Open issue", cls: "border-border bg-muted/50 text-foreground" },
  accepted: {
    label: "Accepted",
    cls: "border-border bg-muted/40 text-muted-foreground",
  },
  rejected: {
    label: "Rejected",
    cls: "border-border bg-muted/40 text-muted-foreground",
  },
  resolved: {
    label: "Resolved",
    cls: "border-border bg-muted text-muted-foreground",
  },
};

function StatusTag({ item }: { item: InboxItem }) {
  const s =
    statusStyles[item.status] ?? {
      label: item.status,
      cls: "border-border bg-muted text-muted-foreground",
    };
  const Icon = item.status === "pending" || item.status === "open" ? AlertCircle : CheckCircle2;
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium ${s.cls}`}>
      <Icon className="size-3" />
      {s.label}
    </span>
  );
}

function preview(item: InboxItem): string {
  if (item.body) return item.body;
  if (item.args) {
    const v = Object.values(item.args)[0];
    if (typeof v === "string") return v;
    if (v != null) return JSON.stringify(v);
  }
  return "";
}

function itemTone(item: InboxItem): string {
  if (item.status === "pending" || item.status === "open") return "bg-card";
  return "bg-background";
}

function attentionDot(item: InboxItem): string {
  if (item.status === "pending") return "bg-amber-400";
  if (item.status === "open") return "bg-foreground";
  return "bg-muted-foreground/35";
}

function EmptyState({ tab }: { tab: InboxFilter }) {
  return (
    <div className="flex h-full min-h-[360px] items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-lg border border-border bg-muted/40">
          <ShieldCheck className="size-5 text-muted-foreground" />
        </div>
        <div className="mt-4 text-sm font-medium">
          {tab === "attention" ? "No blocked agents" : "No inbox items"}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {tab === "attention"
            ? "Approvals and agent-filed issues will appear here when work needs a human decision."
            : "Switch tabs or refresh when agents have more activity."}
        </p>
      </div>
    </div>
  );
}

export default function InboxPage() {
  const router = useRouter();
  const [tab, setTab] = useState<InboxFilter>("attention");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (t: InboxFilter) => {
    try {
      const list = await listInbox(t);
      setItems(list);
      setSelectedId((cur) => (cur && list.some((i) => i.id === cur) ? cur : list[0]?.id ?? null));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load(tab);
    const t = setInterval(() => load(tab), 4000);
    return () => clearInterval(t);
  }, [tab, load]);

  const selected = items?.find((i) => i.id === selectedId) ?? null;
  const counts = useMemo(() => {
    const list = items ?? [];
    return {
      approvals: list.filter((i) => i.kind === "approval").length,
      issues: list.filter((i) => i.kind === "issue").length,
      blocked: list.filter((i) => i.status === "pending" || i.status === "open").length,
    };
  }, [items]);

  const onAccept = useCallback(
    async (id: string, args: Record<string, unknown>) => {
      setBusy(true);
      const sessionId = items?.find((item) => item.id === id)?.sessionId ?? null;
      try {
        await acceptApproval(id, args);
        if (sessionId) {
          router.push(`/chat/?id=${encodeURIComponent(sessionId)}`);
          return;
        }
        await load(tab);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [items, load, router, tab],
  );

  const onReject = useCallback(
    async (id: string, feedback: string) => {
      setBusy(true);
      const sessionId = items?.find((item) => item.id === id)?.sessionId ?? null;
      try {
        await rejectApproval(id, feedback);
        if (sessionId) {
          router.push(`/chat/?id=${encodeURIComponent(sessionId)}`);
          return;
        }
        await load(tab);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [items, load, router, tab],
  );

  const onResolve = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await resolveInboxItem(id);
        await load(tab);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load, tab],
  );

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-4">
          <div className="flex items-center gap-2">
            <InboxIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Agent Inbox</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={() => load(tab)} aria-label="Refresh inbox">
              <RefreshCw className="size-3.5" />
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <section className="border-b border-border px-4 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <h1 className="text-xl font-semibold tracking-tight leading-tight">Human review queue</h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Review blocked tool calls, resolve agent-filed issues, and jump back into the originating session.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                <div>
                  <span className="font-semibold text-foreground">{items ? counts.blocked : "…"}</span>
                  <span className="ml-1.5 text-muted-foreground">needs action</span>
                </div>
                <div className="h-4 w-px bg-border" />
                <div>
                  <span className="font-semibold text-foreground">{items ? counts.approvals : "…"}</span>
                  <span className="ml-1.5 text-muted-foreground">approvals</span>
                </div>
                <div className="h-4 w-px bg-border" />
                <div>
                  <span className="font-semibold text-foreground">{items ? counts.issues : "…"}</span>
                  <span className="ml-1.5 text-muted-foreground">issues</span>
                </div>
                <div className="hidden h-4 w-px bg-border sm:block" />
                <div className="text-xs text-muted-foreground">refreshes every 4s</div>
              </div>
            </div>
          </section>

          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
            <div className="flex items-center gap-1 rounded-md border border-border bg-background p-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                    tab === t.key
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
              <Clock3 className="size-3.5" />
              <span>{items ? `${items.length} visible` : "Loading queue"}</span>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="flex max-h-[42vh] w-full min-w-0 flex-col border-b border-border md:max-h-none md:w-[42%] md:min-w-[340px] md:border-b-0 md:border-r xl:w-[480px]">
              <div className="flex-1 overflow-y-auto">
                {error && (
                  <div className="m-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
                {!items && !error && (
                  <div className="space-y-2 px-4 py-3" aria-label="Loading inbox">
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className="animate-pulse rounded-md border border-border/50 bg-muted/40 px-4 py-3">
                        <div className="flex items-start gap-2">
                          <div className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/20" />
                          <div className="min-w-0 flex-1 space-y-2">
                            <div className="h-3 w-2/3 rounded bg-muted-foreground/20" />
                            <div className="h-2.5 w-1/3 rounded bg-muted-foreground/15" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {items && items.length === 0 && <EmptyState tab={tab} />}
                {items?.map((item) => {
                  const active = item.id === selectedId;
                  const itemPreview = preview(item);
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={`flex w-full border-b border-border/70 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset ${itemTone(item)} ${
                        active ? "bg-muted/55" : "hover:bg-muted/25"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <div className="mt-2 flex size-3 shrink-0 items-center justify-center">
                            <span className={`size-1.5 rounded-full ${attentionDot(item)}`} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{item.title}</span>
                              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                                {timeAgo(item.createdAt)}
                              </span>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                              <span className="text-xs text-muted-foreground">
                                {statusStyles[item.status]?.label ?? item.status}
                              </span>
                              <span className="text-xs text-muted-foreground" aria-hidden="true">/</span>
                              <span className="truncate text-xs text-muted-foreground">
                                {item.agent ?? "Unassigned agent"}
                              </span>
                            </div>
                            {itemPreview && (
                              <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                {itemPreview}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="min-w-0 flex-1 overflow-y-auto">
              {!selected ? (
                <EmptyState tab={tab} />
              ) : (
                <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-5">
                  <div className="rounded-lg border border-border bg-card">
                    <div className="flex flex-col gap-4 border-b border-border px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusTag item={selected} />
                          <span className="text-xs text-muted-foreground">{selected.kind}</span>
                        </div>
                        <h2 className="mt-3 text-base font-semibold tracking-tight leading-snug">{selected.title}</h2>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{selected.agent ?? "Unassigned agent"}</span>
                          <span>{formatDate(selected.createdAt)}</span>
                          {selected.resolvedAt && <span>Resolved {formatDate(selected.resolvedAt)}</span>}
                        </div>
                      </div>
                      {selected.sessionId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => router.push(`/chat/?id=${encodeURIComponent(selected.sessionId!)}`)}
                        >
                          <ExternalLink className="size-3.5" />
                          Open session
                        </Button>
                      )}
                    </div>
                    {selected.body && (
                      <div className="border-b border-border px-4 py-3">
                        <div className="text-[11px] font-medium uppercase text-muted-foreground">Agent note</div>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{selected.body}</p>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-px bg-border text-xs md:grid-cols-4">
                      <div className="bg-card px-4 py-3">
                        <div className="text-muted-foreground">Item ID</div>
                        <div className="mt-1 truncate font-mono">{selected.id}</div>
                      </div>
                      <div className="bg-card px-4 py-3">
                        <div className="text-muted-foreground">Session</div>
                        <div className="mt-1 truncate font-mono">{selected.sessionId ?? "none"}</div>
                      </div>
                      <div className="bg-card px-4 py-3">
                        <div className="text-muted-foreground">Status</div>
                        <div className="mt-1">{statusStyles[selected.status]?.label ?? selected.status}</div>
                      </div>
                      <div className="bg-card px-4 py-3">
                        <div className="text-muted-foreground">Feedback</div>
                        <div className="mt-1 truncate">{selected.feedback ? "Provided" : "None"}</div>
                      </div>
                    </div>
                  </div>

                  {selected.kind === "approval" && selected.status === "pending" && (
                    <ToolApprovalPanel
                      approval={{
                        id: selected.id,
                        tool: selected.title,
                        arguments: selected.args ?? {},
                        createdAt: selected.createdAt,
                      }}
                      onAccept={onAccept}
                      onReject={onReject}
                      busy={busy}
                    />
                  )}

                  {selected.kind === "approval" && selected.status !== "pending" && (
                    <div className="rounded-lg border border-border bg-card p-4">
                      <div className="mb-3 text-sm font-medium">Approval record</div>
                      {selected.args && Object.keys(selected.args).length > 0 ? (
                        <div className="space-y-3">
                          {Object.entries(selected.args).map(([k, v]) => (
                            <div key={k}>
                              <div className="text-xs text-muted-foreground">{k}</div>
                              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                                {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">This action had no arguments.</p>
                      )}
                      {selected.feedback && (
                        <div className="mt-4 border-t border-border pt-4">
                          <div className="text-xs font-medium text-muted-foreground">Feedback to agent</div>
                          <p className="mt-1 whitespace-pre-wrap text-sm">{selected.feedback}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {selected.kind === "issue" && (
                    <div className="rounded-lg border border-border bg-card p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium">Issue details</div>
                          <div className="text-xs text-muted-foreground">Agent-filed note for a human operator.</div>
                        </div>
                        {selected.status === "open" && (
                          <Button size="sm" onClick={() => onResolve(selected.id)} disabled={busy}>
                            <CheckCircle2 className="size-3.5" />
                            Mark resolved
                          </Button>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-6">
                        {selected.body || "No details provided."}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
