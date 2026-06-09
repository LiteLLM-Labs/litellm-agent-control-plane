"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  Check,
  Copy,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
} from "lucide-react";

import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { getSpendLog, listSpendLogs } from "@/lib/api";
import type { SpendLog } from "@/lib/types";

const PAGE_SIZE = 50;
const TABLE_COLUMNS =
  "grid-cols-[150px_96px_104px_136px_190px_104px_108px_92px_132px_150px_132px_180px_132px]";
const LOG_URL_PARAM = "request_id";
const MAX_PROMPT_JSON_CHARS = 12000;

function formatCost(value: number | null | undefined): string {
  return `$${(value ?? 0).toFixed(8)}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "-";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(3)} s`;
}

function prettyJson(value: unknown): string {
  if (value == null) return "{}";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function truncateForPrompt(value: string): string {
  if (value.length <= MAX_PROMPT_JSON_CHARS) return value;
  return `${value.slice(0, MAX_PROMPT_JSON_CHARS)}\n\n[truncated]`;
}

function currentLogUrl(requestId: string): string {
  if (typeof window === "undefined") return `/observability/logs/?${LOG_URL_PARAM}=${encodeURIComponent(requestId)}`;
  const url = new URL("/observability/logs/", window.location.origin);
  url.searchParams.set(LOG_URL_PARAM, requestId);
  return url.toString();
}

function setCurrentLogUrl(requestId: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.pathname = "/observability/logs/";
  url.search = "";
  url.searchParams.set(LOG_URL_PARAM, requestId);
  window.history.replaceState(null, "", url.toString());
}

function shortValue(value: string | null | undefined, size = 14): string {
  if (!value) return "-";
  return value.length > size ? `${value.slice(0, size)}...` : value;
}

function metadataString(log: SpendLog | null, key: string): string | null {
  const value = log?.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function isStreaming(log: SpendLog): boolean {
  if (!log.messages || typeof log.messages !== "object" || Array.isArray(log.messages)) {
    return false;
  }
  return (log.messages as Record<string, unknown>).stream === true;
}

function typeLabel(log: SpendLog): string {
  return log.call_type === "messages" ? "LLM" : log.call_type;
}

function timeToFirstToken(log: SpendLog): string {
  return isStreaming(log) ? formatDuration(log.request_duration_ms) : "-";
}

function errorInfo(log: SpendLog | null): Record<string, unknown> | null {
  const info = log?.metadata?.error_information;
  return info && typeof info === "object" && !Array.isArray(info)
    ? (info as Record<string, unknown>)
    : null;
}

function buildDebugPrompt(log: SpendLog, error: Record<string, unknown> | null): string {
  const lines = [
    "Debug this LiteLLM gateway request log and identify the likely root cause.",
    "",
    `Log URL: ${currentLogUrl(log.request_id)}`,
    `Request ID: ${log.request_id}`,
    `Status: ${log.status ?? "unknown"}`,
    `Call type: ${log.call_type}`,
    `Provider: ${log.custom_llm_provider ?? "-"}`,
    `Model: ${log.model_group || log.model}`,
    `API base: ${log.api_base ?? "-"}`,
    `Started: ${log.start_time}`,
    `Duration: ${formatDuration(log.request_duration_ms)}`,
    `Input tokens: ${log.prompt_tokens}`,
    `Output tokens: ${log.completion_tokens}`,
    `Cost: ${formatCost(log.spend)}`,
  ];

  if (error) {
    lines.push(
      "",
      "Captured error:",
      "```json",
      truncateForPrompt(prettyJson(error)),
      "```",
    );
  }

  lines.push(
    "",
    "Request payload:",
    "```json",
    truncateForPrompt(prettyJson(log.messages)),
    "```",
    "",
    "Response payload:",
    "```json",
    truncateForPrompt(prettyJson(log.response)),
    "```",
    "",
    "Explain what failed, where to look in the codebase, and propose the smallest safe fix. If you have repository access, implement the fix and run the relevant checks.",
  );

  return lines.join("\n");
}

export default function ObservabilityLogsPage() {
  const [logs, setLogs] = useState<SpendLog[]>([]);
  const [selected, setSelected] = useState<SpendLog | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
  const [liveTail, setLiveTail] = useState(true);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await listSpendLogs({ limit: 250 });
      setLogs(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initialRequestId = new URLSearchParams(window.location.search).get(LOG_URL_PARAM);
    if (initialRequestId) setSelectedRequestId(initialRequestId);
    load();
  }, [load]);

  useEffect(() => {
    if (!liveTail) return undefined;
    const timer = setInterval(() => load(true), 15_000);
    return () => clearInterval(timer);
  }, [liveTail, load]);

  useEffect(() => {
    setPage(1);
  }, [logs.length]);

  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = logs.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(currentPage * PAGE_SIZE, logs.length);
  const visibleLogs = logs.slice(pageStart === 0 ? 0 : pageStart - 1, pageEnd);

  const selectRequest = useCallback(async (requestId: string, updateUrl = true) => {
    const log = await getSpendLog(requestId);
    setSelected(log);
    setSelectedRequestId(log.request_id);
    setDetailOpen(true);
    if (updateUrl) setCurrentLogUrl(log.request_id);
  }, []);

  useEffect(() => {
    if (logs.length === 0 && !selectedRequestId) {
      setSelected(null);
      setDetailOpen(false);
      return;
    }
    const requestId = selectedRequestId ?? logs[0]?.request_id;
    if (!requestId || selected?.request_id === requestId) return;

    let cancelled = false;
    getSpendLog(requestId)
      .then((log) => {
        if (!cancelled) {
          setSelected(log);
          setSelectedRequestId(log.request_id);
          setDetailOpen(true);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [logs, selected?.request_id, selectedRequestId]);

  const selectedError = errorInfo(selected);

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BarChart3 className="size-4 text-muted-foreground" />
              <h1 className="truncate text-xl font-semibold tracking-tight">Request Logs</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-border bg-card text-xs"
              onClick={() => load(true)}
            >
              <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Fetch
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content" className="relative min-h-0 flex-1 overflow-hidden">
          <section className="flex h-full min-h-0 min-w-0 flex-col bg-card">
            <div className="border-b border-border px-4 py-3">
              <div className="flex flex-wrap items-center justify-end gap-4 text-sm text-muted-foreground">
                <span>Showing {pageStart} - {pageEnd} of {logs.length} results</span>
                <span>Page {currentPage} of {totalPages}</span>
                <Button
                  variant="outline"
                  className="h-8 border-border bg-card text-sm"
                  disabled={currentPage <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  className="h-8 border-border bg-card text-sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                >
                  Next
                </Button>
              </div>
            </div>

            <div className={`border-b px-4 py-2 text-sm font-medium ${
              liveTail ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-border bg-muted text-muted-foreground"
            }`}>
              {liveTail ? "Auto-refreshing every 15 seconds" : "Live tail paused"}
              <Button variant="ghost" size="sm" className="float-right h-6 px-2 text-xs" onClick={() => setLiveTail(v => !v)} aria-label={liveTail ? "Stop auto-refresh" : "Start auto-refresh"}>
                {liveTail ? "Stop" : "Start"}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {error && (
                <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
              {loading && <div className="p-4 text-sm text-muted-foreground">Loading logs…</div>}
              {!loading && logs.length === 0 && !error && (
                <div className="p-4 text-sm text-muted-foreground">No spend logs found.</div>
              )}
              <div className="min-w-[1660px]">
                <TableHeader />
                {visibleLogs.map((log) => (
                  <LogRow
                    key={log.request_id}
                    log={log}
                    active={selected?.request_id === log.request_id}
                    onSelect={() => void selectRequest(log.request_id)}
                  />
                ))}
              </div>
            </div>
          </section>

          {selected && !detailOpen && (
            <button
              type="button"
              className="absolute right-3 top-1/2 z-20 flex -translate-y-1/2 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground shadow-lg focus-visible:ring-2 focus-visible:ring-ring/50"
              title="Open request details"
              onClick={() => setDetailOpen(true)}
            >
              <PanelRightOpen className="size-4 text-muted-foreground" />
              Details
            </button>
          )}

          {selected && (
            <aside
              className={`absolute inset-y-0 right-0 z-30 w-[min(760px,calc(100vw-320px))] min-w-[520px] overflow-y-auto border-l border-border bg-background shadow-[-18px_0_45px_rgba(15,23,42,0.12)] transition-transform duration-200 ease-out ${
                detailOpen ? "translate-x-0" : "pointer-events-none translate-x-full"
              }`}
            >
              <LogDetail log={selected} error={selectedError} onClose={() => setDetailOpen(false)} />
            </aside>
          )}
        </main>
      </div>
    </div>
  );
}

function TableHeader() {
  return (
    <div className={`grid ${TABLE_COLUMNS} border-b border-border bg-card px-4 py-2.5 text-[12px] font-semibold text-foreground`}>
      <div>Time</div>
      <div>Type</div>
      <div>Status</div>
      <div>Session ID</div>
      <div>Request ID</div>
      <div>Cost</div>
      <div>Duration (s)</div>
      <div>TTFT (s)</div>
      <div>Team Name</div>
      <div>Key Hash</div>
      <div>Key Name</div>
      <div>Model</div>
      <div>Tokens</div>
    </div>
  );
}

function LogRow({
  log,
  active,
  onSelect,
}: {
  log: SpendLog;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`grid w-full ${TABLE_COLUMNS} items-center border-b border-border px-4 py-2.5 text-left text-[13px] transition ${
        active ? "bg-primary/10 border-l-2 border-primary" : "hover:bg-muted"
      }`}
      onClick={onSelect}
    >
      <div className="font-mono text-muted-foreground">{formatDate(log.start_time)}</div>
      <div><TypePill value={typeLabel(log)} /></div>
      <div><StatusBadge status={log.status} compact /></div>
      <div className="truncate font-mono text-primary">{shortValue(log.session_id, 13)}</div>
      <div className="truncate font-mono text-muted-foreground">{shortValue(log.request_id, 18)}</div>
      <div className="font-mono text-muted-foreground">{log.status === "error" ? "-" : formatCost(log.spend)}</div>
      <div className="font-mono text-muted-foreground">{((log.request_duration_ms ?? 0) / 1000).toFixed(2)}</div>
      <div className="font-mono text-muted-foreground">{timeToFirstToken(log)}</div>
      <div className="truncate text-muted-foreground">{metadataString(log, "team_name") ?? "-"}</div>
      <div className="truncate font-mono text-muted-foreground">{shortValue(log.api_key, 14)}</div>
      <div className="truncate text-muted-foreground">{log.user || "-"}</div>
      <div className="truncate text-muted-foreground">{log.model_group || log.model}</div>
      <div className="font-mono text-muted-foreground">
        {log.total_tokens.toLocaleString()}{" "}
        <span className="text-muted-foreground">
          ({log.prompt_tokens}+{log.completion_tokens})
        </span>
      </div>
    </button>
  );
}

function TypePill({ value }: { value: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-1 text-xs font-semibold text-sky-600 dark:text-sky-400">
      {value}
    </span>
  );
}

function StatusBadge({ status, compact = false }: { status: string | null; compact?: boolean }) {
  const ok = status !== "error";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold ${
      ok ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
         : "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400"
    }`}>
      {!compact && (ok ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />)}
      {ok ? "Success" : "Failure"}
    </span>
  );
}

function LogDetail({
  log,
  error,
  onClose,
}: {
  log: SpendLog;
  error: Record<string, unknown> | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const logUrl = currentLogUrl(log.request_id);
  const debugPrompt = buildDebugPrompt(log, error);
  const copy = async (key: string, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="space-y-5 px-6 py-5">
      <div className="border-b border-border pb-4">
        <div className="space-y-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-foreground">{log.model_group || log.model}</span>
              <span className="text-sm text-muted-foreground">{log.custom_llm_provider || "-"}</span>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto h-8 w-8 text-muted-foreground"
                title="Collapse request details"
                onClick={onClose}
              >
                <PanelRightClose className="size-4" />
              </Button>
            </div>
            <div className="mt-4 flex min-w-0 items-center gap-2">
              <h2 className="truncate font-mono text-[22px] font-semibold leading-tight text-foreground">
                {log.request_id}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-primary"
                title="Copy request ID"
                onClick={() => void copy("request", log.request_id)}
              >
                {copied === "request" ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <StatusBadge status={log.status} />
              <span className="rounded-md border border-border bg-card px-3 py-1 text-sm">
                Env: {metadataString(log, "environment") ?? "default"}
              </span>
              <span className="text-sm text-muted-foreground">{formatDate(log.start_time)}</span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 border-border bg-card text-xs"
                onClick={() => void copy("url", logUrl)}
              >
                {copied === "url" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                Copy URL
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 border-border bg-card text-xs"
                onClick={() => void copy("prompt", debugPrompt)}
              >
                {copied === "prompt" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                Debug Prompt
              </Button>
            </div>
          </div>
          <div className="grid overflow-hidden rounded-md border border-border bg-card sm:grid-cols-4">
            <DetailStat label="Cost" value={formatCost(log.spend)} />
            <DetailStat label="Tokens" value={log.total_tokens.toLocaleString()} />
            <DetailStat label="Latency" value={formatDuration(log.request_duration_ms)} />
            <DetailStat label="TTFT" value={timeToFirstToken(log)} />
          </div>
        </div>
      </div>

      <InfoCard title="Tags">
        <TagList log={log} />
      </InfoCard>

      <InfoCard title="Request Details">
        <TwoColumnFields
          left={[
            ["Model", log.model],
            ["Call Type", log.call_type],
            ["API Base", log.api_base],
          ]}
          right={[
            ["Provider", log.custom_llm_provider],
            ["Model ID", log.model_id],
            ["IP Address", log.requester_ip_address],
          ]}
        />
      </InfoCard>

      <InfoCard title="Metrics">
        <TwoColumnFields
          left={[
            ["Input Tokens", log.prompt_tokens.toLocaleString()],
            ["Cost", formatCost(log.spend)],
            ["Time to First Token", timeToFirstToken(log)],
            ["Cache Read Tokens", metadataString(log, "cache_read_tokens") ?? "-"],
            ["Retries", "None"],
            ["End Time", log.end_time],
          ]}
          right={[
            ["Output Tokens", log.completion_tokens.toLocaleString()],
            ["Duration", formatDuration(log.request_duration_ms)],
            ["Cache Hit", log.cache_hit ?? "false"],
            ["Cache Creation Tokens", metadataString(log, "cache_creation_tokens") ?? "-"],
            ["Start Time", log.start_time],
          ]}
        />
      </InfoCard>

      {error && (
        <InfoCard title="Error Trace" tone="error">
          <div className="space-y-3">
            <ErrorField label="Type" value={String(error.error_type ?? "-")} />
            <ErrorField label="Message" value={String(error.message ?? "-")} />
            <CodeBlock value={String(error.trace ?? "")} tone="error" />
          </div>
        </InfoCard>
      )}

      <InfoCard title="Cost Breakdown">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Total</span>
          <span className="font-mono text-base font-semibold text-foreground">{formatCost(log.spend)}</span>
        </div>
      </InfoCard>

      <InfoCard title="Request & Response">
        <div className="space-y-3">
          <PayloadBlock title="Input" tokens={log.prompt_tokens} value={prettyJson(log.messages)} />
          <PayloadBlock title="Output" tokens={log.completion_tokens} value={prettyJson(log.response)} />
        </div>
      </InfoCard>
    </div>
  );
}

function TagList({ log }: { log: SpendLog }) {
  const rawTags = Array.isArray(log.request_tags) ? log.request_tags : [];
  const tags = rawTags.length > 0 ? rawTags : [`call_type: ${log.call_type}`, `provider: ${log.custom_llm_provider ?? "-"}`];
  return (
    <div className="flex flex-wrap gap-2">
      {tags.map((tag, index) => (
        <span
          key={`${String(tag)}-${index}`}
          className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
        >
          {index}: {String(tag)}
        </span>
      ))}
    </div>
  );
}

function PayloadBlock({
  title,
  tokens,
  value,
}: {
  title: string;
  tokens: number;
  value: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border bg-muted px-3 py-2 text-sm">
        <span className="font-semibold text-foreground">{title}</span>
        <span className="text-muted-foreground">Tokens: {tokens.toLocaleString()}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-7 w-7 text-muted-foreground"
          title={`Copy ${title.toLowerCase()}`}
          onClick={() => navigator.clipboard?.writeText(value)}
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
      <CodeBlock value={value} />
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-r border-border px-3 py-2 last:border-r-0">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-[13px] font-semibold text-foreground">
        {value}
      </div>
    </div>
  );
}

function InfoCard({
  title,
  children,
  tone,
}: {
  title: string;
  children: ReactNode;
  tone?: "error";
}) {
  return (
    <section className={`overflow-hidden rounded-lg border bg-card shadow-sm ${
      tone === "error" ? "border-destructive/40" : "border-border"
    }`}>
      <div className="flex h-12 items-center gap-2 border-b border-border px-5">
        <h3 className="text-[13.5px] font-semibold tracking-tight text-foreground">{title}</h3>
        {tone === "error" && (
          <span className="ml-auto rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
            Captured on error
          </span>
        )}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function TwoColumnFields({
  left,
  right,
}: {
  left: Array<[string, string | null | undefined]>;
  right: Array<[string, string | null | undefined]>;
}) {
  return (
    <div className="grid gap-x-14 gap-y-3 md:grid-cols-2">
      <div className="space-y-3">
        {left.map(([label, value]) => (
          <InlineMetric key={label} label={label} value={value} />
        ))}
      </div>
      <div className="space-y-3">
        {right.map(([label, value]) => (
          <InlineMetric key={label} label={label} value={value} />
        ))}
      </div>
    </div>
  );
}

function InlineMetric({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[15px]">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className="min-w-0 break-words font-medium text-foreground">{value || "-"}</span>
    </div>
  );
}

function ErrorField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-destructive/20 bg-card px-3 py-2">
      <div className="text-[11px] font-semibold uppercase text-destructive">{label}</div>
      <div className="mt-1 break-words text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function CodeBlock({
  value,
  compact = false,
  tone,
}: {
  value: string;
  compact?: boolean;
  tone?: "error";
}) {
  return (
    <pre
      className={`overflow-auto rounded-md border p-4 font-mono text-xs leading-5 ${
        compact ? "max-h-[260px]" : "max-h-[540px]"
      } ${
        tone === "error"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-muted text-foreground"
      }`}
    >
      {value}
    </pre>
  );
}
