"use client";

/**
 * Automation run log for the agent detail page.
 *
 * A read-only feed of the agent's scheduled runs, newest first: when each one
 * started, whether it succeeded / failed / is still running, how long it took,
 * and a link to the session it spawned. Polls so a run that fires while the
 * page is open shows up without a manual refresh.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AutomationRunRow, listAutomationRuns } from "@/lib/api";

interface Props {
  agentId: string;
}

const POLL_MS = 15_000;

/** Compact relative time, e.g. "3m ago". */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Run duration as a short string, or null while still running. */
function duration(run: AutomationRunRow): string | null {
  if (!run.finished_at) return null;
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function AutomationRunsSection({ agentId }: Props) {
  const [runs, setRuns] = useState<AutomationRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRuns(await listAutomationRuns(agentId, 50));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  // Don't render the section at all until the first load resolves with runs —
  // an agent with no automations shouldn't show an empty run log.
  if (runs !== null && runs.length === 0 && error === null) return null;

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Automation runs</h2>
        <button
          type="button"
          onClick={() => void reload()}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      {runs === null ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-card/40">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  if (status === "succeeded") {
    return (
      <Badge variant="default" className="font-normal">
        <CheckCircle2 className="h-3 w-3" />
        Succeeded
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="font-normal">
        <XCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-normal">
      <Loader2 className="h-3 w-3 animate-spin" />
      Running
    </Badge>
  );
}

function RunRow({ run }: { run: AutomationRunRow }) {
  const dur = duration(run);
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <RunStatusBadge status={run.status} />
          <span className="truncate text-sm font-medium">
            {run.automation_name || "Automation"}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Started {relativeTime(run.started_at)}
          {dur && <> · took {dur}</>}
          {run.session_id && (
            <>
              {" · "}
              <a
                href={`/sessions/${encodeURIComponent(run.session_id)}`}
                className="underline hover:text-foreground"
              >
                view session
              </a>
            </>
          )}
        </div>
        {run.status === "failed" && run.error && (
          <div className="mt-0.5 truncate font-mono text-xs text-destructive">
            {run.error}
          </div>
        )}
      </div>
    </li>
  );
}
