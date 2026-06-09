"use client";

import { useEffect, useState } from "react";
import { Check, KeyRound, ServerCog, X } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  clearHarnessServerKey,
  clearHarnessServerUrl,
  getHarnessServerKey,
  getHarnessServerUrl,
  normalizeHarnessServerUrl,
  setHarnessServerKey,
  setHarnessServerUrl,
  testHarnessServer,
} from "@/lib/api";

export default function SettingsPage() {
  const [harnessUrl, setHarnessUrl] = useState("");
  const [harnessKey, setHarnessKey] = useState("");
  const [savedHarnessUrl, setSavedHarnessUrl] = useState("");
  const [harnessTesting, setHarnessTesting] = useState(false);
  const [harnessStatus, setHarnessStatus] = useState<{
    tone: "success" | "error" | "muted";
    text: string;
  } | null>(null);

  useEffect(() => {
    const url = getHarnessServerUrl();
    setHarnessUrl(url);
    setSavedHarnessUrl(url);
    setHarnessKey(getHarnessServerKey());
  }, []);

  const testHarness = async () => {
    const normalized = normalizeHarnessServerUrl(harnessUrl);
    if (harnessUrl.trim() && !normalized) {
      setHarnessStatus({ tone: "error", text: "Enter a valid http:// or https:// URL." });
      return;
    }
    setHarnessTesting(true);
    setHarnessStatus(null);
    try {
      const result = await testHarnessServer(normalized, harnessKey);
      if (result.ok) {
        setHarnessStatus({
          tone: "success",
          text:
            result.mode === "remote"
              ? `Connected to ${result.base}.`
              : "Using LAP local harness routing.",
        });
      } else {
        setHarnessStatus({
          tone: "error",
          text: result.error ?? `Harness server returned HTTP ${result.status ?? "error"}.`,
        });
      }
    } finally {
      setHarnessTesting(false);
    }
  };

  const saveHarness = () => {
    const normalized = normalizeHarnessServerUrl(harnessUrl);
    if (harnessUrl.trim() && !normalized) {
      setHarnessStatus({ tone: "error", text: "Enter a valid http:// or https:// URL." });
      return;
    }
    const saved = setHarnessServerUrl(normalized);
    setHarnessServerKey(harnessKey);
    setHarnessUrl(saved);
    setSavedHarnessUrl(saved);
    setHarnessStatus({
      tone: "success",
      text: saved ? `Session calls now route through ${saved}.` : "Session calls now use LAP local routing.",
    });
  };

  const useLocalHarness = () => {
    clearHarnessServerUrl();
    clearHarnessServerKey();
    setHarnessUrl("");
    setHarnessKey("");
    setSavedHarnessUrl("");
    setHarnessStatus({ tone: "muted", text: "Session calls now use LAP local routing." });
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <ServerCog className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Settings</h1>
          </div>
          <ThemeToggle />
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6">
            <section className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold tracking-tight">Harness Server</h2>
                <Badge variant={savedHarnessUrl ? "secondary" : "outline"} className="text-[10px]">
                  {savedHarnessUrl ? "Lite-Harness remote" : "LAP local"}
                </Badge>
              </div>
              <Card className="p-4">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
                  <div className="grid gap-3">
                    <p className="text-sm text-muted-foreground">
                      Route chat sessions through a running Lite-Harness server.
                    </p>
                    <div className="grid gap-1.5">
                      <Label htmlFor="harness-server-url">Server URL</Label>
                      <Input
                        id="harness-server-url"
                        value={harnessUrl}
                        onChange={(event) => setHarnessUrl(event.target.value)}
                        placeholder="http://127.0.0.1:4096"
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="harness-server-key">Master key</Label>
                      <div className="relative">
                        <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="harness-server-key"
                          type="password"
                          value={harnessKey}
                          onChange={(event) => setHarnessKey(event.target.value)}
                          placeholder="Optional"
                          className="pl-8 font-mono text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid content-start gap-3 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
                    <div className="grid gap-2 text-xs">
                      <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
                        <span className="text-muted-foreground">Mode</span>
                        <span className="font-mono text-foreground">
                          {savedHarnessUrl ? "remote" : "local"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
                        <span className="text-muted-foreground">Sessions</span>
                        <span className="font-mono text-foreground">
                          {savedHarnessUrl ? "proxy" : "LAP"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">Events</span>
                        <span className="font-mono text-foreground">
                          {savedHarnessUrl ? "proxy SSE" : "LAP SSE"}
                        </span>
                      </div>
                    </div>
                    {savedHarnessUrl && (
                      <p className="break-all font-mono text-[11px] text-muted-foreground">
                        {savedHarnessUrl}
                      </p>
                    )}
                  </div>
                </div>

                {harnessStatus && (
                  <p
                    className={`mt-4 text-xs ${
                      harnessStatus.tone === "error"
                        ? "text-destructive"
                        : harnessStatus.tone === "success"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    {harnessStatus.text}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  {savedHarnessUrl && (
                    <Button variant="outline" size="sm" onClick={useLocalHarness}>
                      <X className="size-3.5" />
                      Use local LAP
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={testHarness}
                    disabled={harnessTesting}
                  >
                    <ServerCog className="size-3.5" />
                    {harnessTesting ? "Testing…" : "Test"}
                  </Button>
                  <Button size="sm" onClick={saveHarness}>
                    <Check className="size-3.5" />
                    Save
                  </Button>
                </div>
              </Card>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
