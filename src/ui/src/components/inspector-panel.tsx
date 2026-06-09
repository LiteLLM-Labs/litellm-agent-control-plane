"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, ChevronRight, X } from "lucide-react";
import { runtimeEventSourceUrl } from "@/lib/api";

interface OcEvent {
  type: string;
  [key: string]: unknown;
}

export interface Frame {
  ts: number;
  ev: OcEvent;
}

function summarize(ev: OcEvent): string {
  const text =
    typeof ev.text === "string"
      ? ev.text
      : typeof ev.delta === "string"
        ? ev.delta
        : "";
  switch (ev.type) {
    case "session.status_idle":
      return "agent loop returned control";
    case "session.error":
      return String(
        typeof ev.error === "object" && ev.error
          ? ((ev.error as { message?: unknown }).message ?? "error")
          : (ev.error ?? "error"),
      );
    case "assistant_response":
    case "thinking_back":
    case "agent.message":
    case "agent.thinking":
    case "agent.reasoning":
      return text ? `text: ${text.slice(0, 80)}` : "";
    case "session.status": {
      const s = ev.status as { type?: string } | string | undefined;
      return typeof s === "string" ? s : (s?.type ?? "");
    }
    default:
      return JSON.stringify(ev).slice(0, 80);
  }
}

const TYPE_COLOR: Record<string, string> = {
  "session.status_idle": "text-amber-600 dark:text-amber-400",
  "session.error": "text-red-600 dark:text-red-400",
  "session.status": "text-violet-600 dark:text-violet-400",
  "assistant_response": "text-sky-600 dark:text-sky-400",
  "thinking_back": "text-violet-600 dark:text-violet-400",
  "agent.message": "text-sky-600 dark:text-sky-400",
  "agent.thinking": "text-violet-600 dark:text-violet-400",
  "agent.reasoning": "text-violet-600 dark:text-violet-400",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleTimeString([], { hour12: false }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function EventRow({ frame }: { frame: Frame }) {
  const [open, setOpen] = useState(false);
  const color = TYPE_COLOR[frame.ev.type] ?? "text-muted-foreground";
  return (
    <div className="border-b border-border text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-accent/50"
      >
        <ChevronRight
          className={`mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="font-mono text-muted-foreground shrink-0">
          {fmtTime(frame.ts)}
        </span>
        <span className={`font-mono font-medium shrink-0 ${color}`}>
          {frame.ev.type}
        </span>
        <span className="font-mono text-muted-foreground truncate">
          {summarize(frame.ev)}
        </span>
      </button>
      {open && (
        <pre className="px-3 pb-2 pl-8 font-mono text-[10.5px] text-muted-foreground whitespace-pre-wrap break-words max-h-80 overflow-auto">
          {JSON.stringify(frame.ev, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function InspectorPanel({
  open,
  onClose,
  sessionId,
  initialFrames = [],
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  initialFrames?: Frame[];
}) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [hideHeartbeat, setHideHeartbeat] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Seed with buffered events from before the panel opened
    setFrames(initialFrames.slice(-500));
    let es: EventSource | null = null;
    try {
      es = new EventSource(runtimeEventSourceUrl(sessionId));
    } catch {
      return;
    }
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as OcEvent;
        setFrames((prev) => [...prev.slice(-999), { ts: Date.now(), ev }]);
      } catch {
        /* noop */
      }
    };
    return () => {
      try {
        es?.close();
      } catch {
        /* noop */
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]); // intentionally omit initialFrames — snapshot on open only

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frames]);

  if (!open) return null;

  const shown = hideHeartbeat
    ? frames.filter((f) => f.ev.type !== "server.heartbeat")
    : frames;

  return (
    <aside className="flex flex-col h-screen min-h-0 border-l border-border bg-background w-[480px] shrink-0">
      <header className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
        <Activity className="size-3.5 text-muted-foreground" />
        <span className="text-[13px] font-medium">runtime events</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {sessionId.slice(0, 8)}…
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto p-1 hover:bg-accent rounded focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          title="Close inspector"
          aria-label="Close inspector"
        >
          <X className="size-4 text-muted-foreground" />
        </button>
      </header>

      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-border bg-muted/30 text-[11px]">
        <label className="inline-flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={hideHeartbeat}
            onChange={(e) => setHideHeartbeat(e.target.checked)}
            className="size-3"
          />
          hide heartbeats
        </label>
        <button
          type="button"
          onClick={() => setFrames([])}
          className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          clear
        </button>
        <span className="ml-auto text-muted-foreground font-mono">
          {shown.length} events
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {shown.map((f, i) => (
          <EventRow key={i} frame={f} />
        ))}
        {shown.length === 0 && (
          <div className="p-3 text-[11px] text-muted-foreground text-center leading-relaxed">
            subscribed to runtime events
            <br />
            provider SDK events appear as the agent emits them
          </div>
        )}
      </div>

      <footer className="px-4 py-1.5 border-t border-border text-[10px] text-muted-foreground font-mono">
        GET /session/{sessionId}/runtime_events
      </footer>
    </aside>
  );
}
