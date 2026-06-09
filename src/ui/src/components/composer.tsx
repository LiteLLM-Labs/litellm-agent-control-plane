"use client";

import { useCallback, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { sendMessage } from "@/lib/api";

export function Composer({
  sessionId,
  model,
  onSent,
  onSend,
  onSendStart,
  onAbort,
  busy = false,
  disabled = false,
}: {
  sessionId: string;
  model: string;
  onSent?: () => void;
  onSend?: (text: string) => Promise<void>;
  onSendStart?: (text: string) => void;
  onAbort?: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = useCallback(async () => {
    const t = draft.trim();
    if (!t || sending || disabled) return;
    setSending(true);
    setError(null);
    onSendStart?.(t);
    try {
      await (onSend ? onSend(t) : sendMessage({ sessionId, text: t, model }));
      setDraft("");
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [draft, sending, disabled, sessionId, model, onSent, onSend, onSendStart]);

  // Plain Enter sends, Shift+Enter inserts a newline. Matches LAP.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const canSend = draft.trim().length > 0 && !sending && !disabled;
  const placeholder = sending
    ? "Sending…"
    : disabled
      ? "Waiting for the runtime…"
      : busy
        ? "Queue a follow up"
    : "Add a follow up";

  return (
    <div className="border-t border-border bg-background/95 backdrop-blur">
      <div className="mx-auto max-w-5xl px-6 py-4">
        <div className="relative">
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-all focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={sending || disabled}
              rows={1}
              className="min-h-14 w-full resize-none bg-transparent px-4 pt-4 text-[15px] outline-none focus-visible:outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center justify-between px-4 pb-3 text-xs text-muted-foreground">
              <span className="mono flex min-w-0 items-center gap-2 truncate">
                {error ? (
                  <span className="text-red-600 dark:text-red-400">{error}</span>
                ) : (
                  model || "Enter to send · Shift+Enter for newline"
                )}
              </span>
              <div className="flex items-center gap-2">
                {busy && onAbort && !draft.trim() ? (
                  <button
                    type="button"
                    onClick={onAbort}
                    className="rounded-full bg-red-600 p-1.5 text-white transition-colors hover:bg-red-700"
                    aria-label="Stop agent"
                    title="Stop (interrupt agent)"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleSend()}
                    disabled={!canSend}
                    className="rounded-full bg-foreground p-1.5 text-background transition-colors hover:bg-foreground/90 disabled:opacity-30 disabled:hover:bg-foreground"
                    aria-label="Send"
                    title="Send (Enter)"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
