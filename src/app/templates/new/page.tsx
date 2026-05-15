"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LocalTemplate } from "../page";
import { SANDBOX_TEMPLATES_STORAGE_KEY } from "@/lib/constants";

function loadLocalTemplates(): LocalTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SANDBOX_TEMPLATES_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LocalTemplate[]) : [];
  } catch { return []; }
}

function saveLocalTemplates(ts: LocalTemplate[]): void {
  try { window.localStorage.setItem(SANDBOX_TEMPLATES_STORAGE_KEY, JSON.stringify(ts)); } catch { /* ignore */ }
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function NewTemplatePage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [envVars, setEnvVars] = useState<[string, string][]>([["", ""]]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addRow() { setEnvVars((p) => [...p, ["", ""]]); }
  function removeRow(i: number) {
    setEnvVars((p) => { const n = p.filter((_, j) => j !== i); return n.length ? n : [["", ""]]; });
  }
  function setKey(i: number, k: string) { setEnvVars((p) => p.map((r, j) => j === i ? [k, r[1]] : r)); }
  function setVal(i: number, v: string) { setEnvVars((p) => p.map((r, j) => j === i ? [r[0], v] : r)); }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Name is required."); return; }
    setSubmitting(true);

    const envVarsRecord: Record<string, string> = {};
    for (const [k, v] of envVars) { if (k.trim()) envVarsRecord[k.trim()] = v; }

    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const template: LocalTemplate = {
      id: `${slug}-${generateId()}`,
      name: name.trim(),
      description: "",
      icon: "🤖",
      tags: [],
      harness_id: "opencode",
      model: "",
      repo_url: repoUrl.trim() || undefined,
      env_vars: envVarsRecord,
      prompt: "",
      skill_name: "",
      skill: "",
      tools: [],
      requirements: null,
      source: "local",
    };

    saveLocalTemplates([...loadLocalTemplates(), template]);
    router.push("/templates");
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-6 border-b pb-4">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">New Template</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Sandbox config — repo and environment variables.</p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-950">
          <p className="font-mono text-xs text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-6">

        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="security-pr-scan" disabled={submitting} required />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="repo-url">GitHub Repo URL</Label>
          <Input id="repo-url" type="url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" disabled={submitting} className="font-mono text-xs" />
        </div>

        <div className="space-y-2">
          <Label>Environment Variables</Label>
          <div className="rounded-lg border bg-card">
            <ul className="divide-y">
              {envVars.map(([k, v], i) => (
                <li key={i} className="flex items-center gap-2 px-3 py-2">
                  <Input
                    value={k}
                    onChange={(e) => setKey(i, e.target.value)}
                    placeholder="KEY"
                    disabled={submitting}
                    className="h-7 font-mono text-xs uppercase"
                    aria-label={`Key ${i + 1}`}
                  />
                  <span className="shrink-0 text-[11px] text-muted-foreground">=</span>
                  <Input
                    value={v}
                    onChange={(e) => setVal(i, e.target.value)}
                    placeholder="value"
                    disabled={submitting}
                    className="h-7 font-mono text-xs"
                    aria-label={`Value ${i + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    disabled={submitting}
                    aria-label="Remove row"
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t px-3 py-2">
              <button type="button" onClick={addRow} disabled={submitting} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40">
                <Plus className="size-3" aria-hidden />
                Add variable
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t pt-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? <><Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden />Creating…</> : <>Create Template</>}
          </Button>
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => router.push("/templates")}>
            Cancel
          </Button>
        </div>

      </form>
    </div>
  );
}
