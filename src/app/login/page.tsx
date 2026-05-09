"use client";

import { Suspense, useState, useEffect, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  api,
  ApiError,
  setStoredMasterKey,
  clearStoredMasterKey,
} from "@/lib/api";

// Next 16 (Turbopack) refuses to prerender pages that read useSearchParams
// without a Suspense boundary — it bails CSR for the inner component, and
// the outer page stays prerenderable. Splitting keeps `/login` static while
// the form reads `?next=…` on the client.
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
  const next = params.get("next") || "/agents";

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
      // Cheap whoami: a 2xx on any auth-gated endpoint means the key is good.
      await api<unknown>("GET", "/v1/managed_agents/dockerfiles");
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
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Paste the <code className="font-mono">MASTER_KEY</code> set in the
            server&rsquo;s <code className="font-mono">.env</code>.
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
