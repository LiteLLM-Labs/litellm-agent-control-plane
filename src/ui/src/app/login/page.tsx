"use client";

import { Suspense, useState, useEffect, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  setStoredMasterKey,
  clearStoredMasterKey,
  whoami,
} from "@/lib/api";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/sessions/";

  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    clearStoredMasterKey();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      setStoredMasterKey(key.trim());
      await whoami();
      router.replace(next);
    } catch (e) {
      clearStoredMasterKey();
      const msg =
        e instanceof ApiError && e.status === 401
          ? "Invalid master key."
          : e instanceof Error
            ? e.message
            : "Sign-in failed.";
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm flex flex-col gap-5"
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl leading-none">🚄</span>
            <span className="font-semibold">LiteLLM</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Paste the <code className="font-mono">MASTER_KEY</code> set on the
            server.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="key">Master key</Label>
          <Input
            id="key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
            autoComplete="current-password"
            spellCheck={false}
            disabled={submitting}
          />
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={submitting || key.trim().length === 0}>
          {submitting ? "Checking…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
