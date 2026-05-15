"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, Loader2, Plus, Trash2, X } from "lucide-react";
import { Tooltip } from "@base-ui/react/tooltip";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LocalTemplate, SandboxFile } from "../page";
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

interface FileDraft {
  id: string;
  name: string;
  sandbox_path: string;
  content: string;
  content_type: string;
  size: number;
}

function TagInput({
  id, value, onChange, placeholder, disabled,
}: {
  id: string; value: string[]; onChange: (v: string[]) => void;
  placeholder?: string; disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  function commit() {
    const t = draft.trim();
    if (!t || value.includes(t)) { setDraft(""); return; }
    onChange([...value, t]); setDraft("");
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    if (e.key === "Backspace" && draft === "" && value.length > 0) onChange(value.slice(0, -1));
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-3 py-1.5 shadow-sm focus-within:ring-1 focus-within:ring-ring">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {v}
          {!disabled && (
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))} className="text-muted-foreground hover:text-foreground focus-visible:outline-none">
              <X className="size-2.5" aria-hidden />
            </button>
          )}
        </span>
      ))}
      <input
        id={id} type="text" value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown} onBlur={commit}
        placeholder={value.length === 0 ? placeholder : ""}
        disabled={disabled}
        className="min-w-[140px] flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
    </div>
  );
}

export default function NewTemplatePage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [envVars, setEnvVars] = useState<[string, string][]>([["", ""]]);
  const [allowOut, setAllowOut] = useState<string[]>([]);
  const [denyOut, setDenyOut] = useState<string[]>([]);
  const [fileDrafts, setFileDrafts] = useState<FileDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addFileDraft() {
    setFileDrafts(p => [...p, { id: generateId(), name: "", sandbox_path: "", content: "", content_type: "", size: 0 }]);
  }
  function removeFileDraft(i: number) {
    setFileDrafts(p => p.filter((_, j) => j !== i));
  }
  function updateFileDraft(i: number, patch: Partial<FileDraft>) {
    setFileDrafts(p => p.map((fd, j) => j === i ? { ...fd, ...patch } : fd));
  }
  function handleFileChange(i: number, file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      setFileDrafts(p => p.map((fd, j) => j === i ? {
        ...fd,
        content: base64,
        content_type: file.type || "application/octet-stream",
        size: file.size,
        name: fd.name || file.name,
      } : fd));
    };
    reader.readAsDataURL(file);
  }

  function handleEnvImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const pairs: [string, string][] = [];
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        // Strip leading `export ` (bash-style env files)
        const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
        let val = trimmed.slice(eq + 1).trim();
        // Quoted value: extract content between first pair of matching quotes
        if (val.startsWith('"')) {
          const end = val.indexOf('"', 1);
          val = end !== -1 ? val.slice(1, end) : val.slice(1);
        } else if (val.startsWith("'")) {
          const end = val.indexOf("'", 1);
          val = end !== -1 ? val.slice(1, end) : val.slice(1);
        } else {
          // Unquoted: strip inline comments (must be preceded by whitespace)
          val = val.replace(/\s+#.*$/, "");
        }
        if (key) pairs.push([key, val]);
      }
      if (pairs.length > 0) {
        setEnvVars((prev) => {
          const existing = prev.filter(([k]) => k.trim());
          return [...existing, ...pairs];
        });
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  }

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

    const files: SandboxFile[] = fileDrafts
      .filter(fd => fd.content)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ id: _id, ...fd }) => fd);

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
      allow_out: allowOut.length > 0 ? allowOut : undefined,
      deny_out: denyOut.length > 0 ? denyOut : undefined,
      files: files.length > 0 ? files : undefined,
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
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <div className="mb-6 border-b pb-4">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">New Template</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Sandbox config — repo, env vars, and network egress.</p>
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
          <div className="flex items-center justify-between">
            <Label>Environment Variables</Label>
            <label className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground focus-within:underline">
              Import .env
              <input
                type="file"
                accept=".env,text/plain"
                className="sr-only"
                onChange={handleEnvImport}
                disabled={submitting}
              />
            </label>
          </div>
          <div className="rounded-lg border bg-card">
            <ul className="divide-y">
              {envVars.map(([k, v], i) => (
                <li key={i} className="flex items-center gap-2 px-3 py-2">
                  <Input value={k} onChange={(e) => setKey(i, e.target.value)} placeholder="KEY" disabled={submitting} className="h-7 font-mono text-xs uppercase" aria-label={`Key ${i + 1}`} />
                  <span className="shrink-0 text-[11px] text-muted-foreground">=</span>
                  <Input value={v} onChange={(e) => setVal(i, e.target.value)} placeholder="value" disabled={submitting} className="h-7 font-mono text-xs" aria-label={`Value ${i + 1}`} />
                  <button type="button" onClick={() => removeRow(i)} disabled={submitting} aria-label="Remove row" className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-40">
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

        <div className="space-y-3">
          <div>
            <Label>Network Egress</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Domains, wildcards (<span className="font-mono">*.example.com</span>), IPs, CIDRs for allow; IPs/CIDRs only for deny. Allow takes precedence.
            </p>
          </div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="allow-out" className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                <span className="rounded-sm bg-emerald-100 px-1 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider dark:bg-emerald-900">Allow</span>
                Outbound
              </label>
              <TagInput id="allow-out" value={allowOut} onChange={setAllowOut} placeholder="github.com, *.amazonaws.com, 8.8.8.8/32…" disabled={submitting} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="deny-out" className="flex items-center gap-1.5 text-[11px] font-medium text-red-700 dark:text-red-400">
                <span className="rounded-sm bg-red-100 px-1 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider dark:bg-red-900">Deny</span>
                Outbound (IPs/CIDRs only)
              </label>
              <TagInput id="deny-out" value={denyOut} onChange={setDenyOut} placeholder="10.0.0.0/8, 192.168.0.0/16…" disabled={submitting} />
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <Label>Sandbox Files</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Files placed in the sandbox at session start. Useful for config files like{" "}
              <span className="font-mono">.claude/settings.json</span>.
            </p>
          </div>
          <div className="rounded-lg border bg-card">
            {fileDrafts.length > 0 && (
              <ul className="divide-y">
                {fileDrafts.map((fd, i) => (
                  <li key={fd.id} className="space-y-2 px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 truncate font-mono text-[11px] text-foreground">
                        {fd.content
                          ? <>{fd.name || "(unnamed)"} <span className="text-muted-foreground">({formatBytes(fd.size)})</span></>
                          : <span className="text-muted-foreground">No file chosen</span>
                        }
                      </span>
                      <label className="shrink-0 cursor-pointer rounded border border-input bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-muted focus-within:ring-1 focus-within:ring-ring">
                        {fd.content ? "Replace" : "Choose file"}
                        <input
                          type="file"
                          className="sr-only"
                          onChange={(e) => handleFileChange(i, e.target.files?.[0] ?? null)}
                          disabled={submitting}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => removeFileDraft(i)}
                        disabled={submitting}
                        aria-label="Remove file"
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </div>
                    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
                      <span className="text-[11px] text-muted-foreground">Name</span>
                      <Input
                        value={fd.name}
                        onChange={(e) => updateFileDraft(i, { name: e.target.value })}
                        placeholder="settings.json"
                        disabled={submitting}
                        className="h-7 font-mono text-xs"
                        aria-label={`File name ${i + 1}`}
                      />
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        Sandbox path
                        <Tooltip.Root>
                          <Tooltip.Trigger className="inline-flex cursor-default focus-visible:outline-none">
                            <Info className="size-3 text-muted-foreground/60" aria-hidden />
                            <span className="sr-only">About sandbox path</span>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Positioner sideOffset={6}>
                              <Tooltip.Popup className="z-50 max-w-[220px] rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-md">
                                Absolute path where this file will be written inside the sandbox container at session start. Use <span className="font-mono">~</span> for the home directory, e.g. <span className="font-mono">~/.claude/settings.json</span>.
                              </Tooltip.Popup>
                            </Tooltip.Positioner>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      </span>
                      <Input
                        value={fd.sandbox_path}
                        onChange={(e) => updateFileDraft(i, { sandbox_path: e.target.value })}
                        placeholder="~/.claude/settings.json"
                        disabled={submitting}
                        className="h-7 font-mono text-xs"
                        aria-label={`Sandbox path ${i + 1}`}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className={fileDrafts.length > 0 ? "border-t px-3 py-2" : "px-3 py-2"}>
              <button
                type="button"
                onClick={addFileDraft}
                disabled={submitting}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <Plus className="size-3" aria-hidden />
                Add file
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
