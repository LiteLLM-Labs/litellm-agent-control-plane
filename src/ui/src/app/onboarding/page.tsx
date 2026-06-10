"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  getStoredMasterKey,
  setStoredMasterKey,
  clearStoredMasterKey,
  whoami,
  listProviders,
  saveProvider,
  type AvailableProvider,
} from "@/lib/api";

type Step = "checking" | "login" | "provider" | "done";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("checking");
  const [masterKey, setMasterKey] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [anthropic, setAnthropic] = useState<AvailableProvider | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = getStoredMasterKey();
    if (!stored) {
      setStep("login");
      return;
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 5000),
    );
    Promise.race([whoami().then(() => loadProviders()), timeout]).catch(() => {
      clearStoredMasterKey();
      setStep("login");
    });
  }, []);

  async function loadProviders() {
    try {
      const data = await listProviders();
      const alreadyConnected = data.connected_providers.some(
        (p) => p.id === "anthropic",
      );
      if (alreadyConnected) {
        router.replace("/sessions/");
        return;
      }
      const provider =
        data.available_providers.find((p) => p.id === "anthropic") ??
        data.available_providers[0] ??
        null;
      setAnthropic(provider);
      setStep("provider");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load providers.");
      setStep("provider");
    }
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      setStoredMasterKey(masterKey.trim());
      await whoami();
      await loadProviders();
    } catch (err) {
      clearStoredMasterKey();
      setError(
        err instanceof ApiError && err.status === 401
          ? "Invalid master key."
          : err instanceof Error
            ? err.message
            : "Sign-in failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onSaveProvider(e: FormEvent) {
    e.preventDefault();
    if (!apiKey.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await saveProvider({
        providerId: anthropic?.id ?? "anthropic",
        apiKey: apiKey.trim(),
        apiBase:
          anthropic?.default_base_url ?? "https://api.anthropic.com",
      });
      setStep("done");
      setTimeout(() => router.replace("/sessions/"), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save key.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 bg-background text-foreground">
      <div className="w-full max-w-sm flex flex-col gap-6">
        <div className="flex items-center gap-2">
          <span className="text-2xl leading-none">🚄</span>
          <span className="font-semibold text-lg">LiteLLM Agent Platform</span>
        </div>

        {step !== "checking" && <Steps current={step} />}

        {step === "checking" && (
          <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
            Checking…
          </div>
        )}

        {step === "login" && (
          <form
            onSubmit={onLogin}
            className="rounded-lg border border-border bg-card p-6 shadow-sm flex flex-col gap-5"
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">Sign in</h2>
              <p className="text-sm text-muted-foreground">
                Enter the master key. Default is{" "}
                <code className="font-mono text-xs">sk-local</code>.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="master-key">Master key</Label>
              <Input
                id="master-key"
                type="password"
                value={masterKey}
                onChange={(e) => setMasterKey(e.target.value)}
                placeholder="sk-local"
                autoFocus
                autoComplete="current-password"
                spellCheck={false}
                disabled={submitting}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={submitting || masterKey.trim().length === 0}
            >
              {submitting ? "Checking…" : "Continue"}
            </Button>
          </form>
        )}

        {step === "provider" && (
          <form
            onSubmit={onSaveProvider}
            className="rounded-lg border border-border bg-card p-6 shadow-sm flex flex-col gap-5"
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">Connect Anthropic</h2>
              <p className="text-sm text-muted-foreground">
                Paste your Anthropic API key to start running agents.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="anthropic-key">Anthropic API key</Label>
              <div className="relative">
                <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="anthropic-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  className="pl-8 font-mono text-xs"
                  disabled={submitting}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Get yours at{" "}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  console.anthropic.com
                </a>
              </p>
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={submitting || apiKey.trim().length === 0}
            >
              {submitting ? "Saving…" : "Save & continue"}
            </Button>
          </form>
        )}

        {step === "done" && (
          <div className="rounded-lg border border-border bg-card p-6 shadow-sm flex flex-col items-center gap-3 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400">
              <Check className="size-5" />
            </span>
            <p className="font-medium">All set! Redirecting…</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "login", label: "Sign in" },
    { id: "provider", label: "Connect provider" },
    { id: "done", label: "Ready" },
  ];
  const idx = steps.findIndex((s) => s.id === current);
  return (
    <div className="flex items-center gap-0">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-0 flex-1 last:flex-none">
          <div className="flex flex-col items-center gap-1">
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-medium border ${
                i < idx
                  ? "bg-primary border-primary text-primary-foreground"
                  : i === idx
                    ? "border-primary text-primary bg-background"
                    : "border-border text-muted-foreground bg-background"
              }`}
            >
              {i < idx ? <Check className="size-3" /> : i + 1}
            </span>
            <span
              className={`text-[11px] ${i === idx ? "text-foreground font-medium" : "text-muted-foreground"}`}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={`h-px flex-1 mb-4 mx-1 ${i < idx ? "bg-primary" : "bg-border"}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
