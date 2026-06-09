"use client";

import { useState } from "react";
import { Settings as SettingsIcon, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { testLiteLLMConnection, type LiteLLMHealth } from "@/lib/api";

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<LiteLLMHealth | null>(null);

  const onTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await testLiteLLMConnection();
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Settings"
        className="size-7"
        onClick={() => setOpen(true)}
      >
        <SettingsIcon className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            LiteLLM gateway connection. Configure via env vars on the server.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">
              LiteLLM gateway
            </div>
            <div className="rounded border border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div className="text-sm font-mono truncate">
                    {result ? (
                      result.ok ? (
                        <span className="text-green-600 dark:text-green-400 inline-flex items-center gap-1">
                          <CheckCircle2 className="size-3.5" />
                          {result.modelCount ?? 0} models reachable
                        </span>
                      ) : (
                        <span className="text-destructive inline-flex items-center gap-1">
                          <XCircle className="size-3.5" />
                          {result.status ? `HTTP ${result.status}` : "unreachable"}
                        </span>
                      )
                    ) : (
                      <span className="text-muted-foreground">Not tested</span>
                    )}
                  </div>
                </div>
                <Button size="sm" onClick={onTest} disabled={testing}>
                  {testing ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Testing
                    </>
                  ) : (
                    "Test connection"
                  )}
                </Button>
              </div>

              {result?.base && (
                <div className="text-[11px] text-muted-foreground font-mono break-all">
                  {result.modelsUrl ?? result.base}
                </div>
              )}
              {result && !result.ok && result.error && (
                <div className="text-[11px] text-destructive font-mono break-all whitespace-pre-wrap">
                  {result.error}
                </div>
              )}
            </div>
          </div>

          <div className="text-[11px] text-muted-foreground">
            Set <code>LITELLM_MASTER_KEY</code> and provider API keys on the
            container before sending live requests.
          </div>
        </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
