"use client";

import { useMemo, useState } from "react";
import { Check, Copy, RotateCcw, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingApproval } from "@/lib/api";

function toFieldLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function toStringValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

// Keep edited JSON-like values typed when the original argument was typed.
function fromStringValue(original: unknown, text: string): unknown {
  if (typeof original === "string" || original === null || original === undefined) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ToolApprovalPanelProps {
  approval: PendingApproval;
  onAccept: (id: string, args: Record<string, unknown>) => void;
  onReject: (id: string, feedback: string) => void;
  busy?: boolean;
}

export function ToolApprovalPanel({ approval, onAccept, onReject, busy }: ToolApprovalPanelProps) {
  const initial = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(approval.arguments ?? {})) out[k] = toStringValue(v);
    return out;
  }, [approval]);

  const [fields, setFields] = useState<Record<string, string>>(initial);
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);

  const keys = Object.keys(approval.arguments ?? {});
  const dirty = keys.some((k) => fields[k] !== initial[k]);

  const buildArgs = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = fromStringValue(approval.arguments[k], fields[k]);
    return out;
  };

  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(approval.tool);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
          <span className="size-2 rounded-full bg-amber-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">Approval required</div>
          <div className="mt-1 truncate text-base font-semibold">{approval.tool}</div>
        </div>
        <Button variant="outline" size="sm" onClick={copyName}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy tool"}
        </Button>
      </div>

      <div className="grid gap-4 p-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-md border border-border bg-background">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <div className="text-sm font-medium">Arguments</div>
              <div className="text-xs text-muted-foreground">Edit values before allowing the agent to continue.</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFields(initial)}
              disabled={busy || !dirty}
            >
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          </div>

          <div className="space-y-3 p-4">
            {keys.length === 0 ? (
              <div className="rounded-md border border-border bg-muted/20 px-3 py-8 text-center text-sm text-muted-foreground">
                This action takes no arguments.
              </div>
            ) : (
              keys.map((k) => (
                <div key={k} className="space-y-1.5">
                  <label className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-muted-foreground">{toFieldLabel(k)}</span>
                    <span className="truncate font-mono text-[10px] text-muted-foreground/70">{k}</span>
                  </label>
                  <textarea
                    value={fields[k]}
                    onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
                    rows={fields[k].includes("\n") ? Math.min(fields[k].split("\n").length, 10) : 2}
                    className="min-h-11 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    disabled={busy}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col rounded-md border border-border bg-background">
          <div className="border-b border-border px-4 py-3">
            <div className="text-sm font-medium">Decision</div>
            <div className="text-xs text-muted-foreground">Accept runs the edited call. Reject returns feedback.</div>
          </div>

          <div className="flex flex-1 flex-col gap-3 p-4">
            <Button onClick={() => onAccept(approval.id, buildArgs())} disabled={busy}>
              <Send className="size-3.5" />
              Accept and continue
            </Button>

            <div className="h-px bg-border" />

            <label className="text-xs font-medium text-muted-foreground" htmlFor={`reject-${approval.id}`}>
              Rejection feedback
            </label>
            <textarea
              id={`reject-${approval.id}`}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={5}
              placeholder="Tell the agent what to change before retrying..."
              className="min-h-28 w-full flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              disabled={busy}
            />

            <Button
              variant="destructive"
              onClick={() => onReject(approval.id, feedback.trim())}
              disabled={busy}
            >
              <XCircle className="size-3.5" />
              Reject
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
