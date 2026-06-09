"use client";

import { useEffect, useState } from "react";
import { KeyRound, Trash2, Pencil, Plus, Loader2, Eye, EyeOff, Globe, User } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  listVaultKeys,
  saveIntegrationKey,
  deleteIntegrationKey,
} from "@/lib/api";
import type { VaultKeyEntry } from "@/lib/types";

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

type EditorState =
  | { mode: "add"; defaultScope: "personal" | "global" }
  | { mode: "edit"; entry: VaultKeyEntry };

export default function VaultPage() {
  const [keys, setKeys] = useState<VaultKeyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showEnv, setShowEnv] = useState(false);

  const refresh = async () => {
    try {
      setKeys(await listVaultKeys());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onDelete = async (entry: VaultKeyEntry) => {
    setKeys((prev) => prev?.filter((k) => k.key !== entry.key || k.scope !== entry.scope) ?? null);
    await deleteIntegrationKey(entry.key, entry.scope);
    await refresh();
  };

  const globalKeys = keys?.filter((k) => k.scope === "global" && k.source !== "env") ?? [];
  const personalKeys = keys?.filter((k) => k.scope === "personal" && k.source !== "env") ?? [];
  const envKeys = keys?.filter((k) => k.source === "env") ?? [];
  const empty = globalKeys.length === 0 && personalKeys.length === 0 && envKeys.length === 0;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Vault</h1>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {keys === null && !error && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          )}

          {keys !== null && empty && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <KeyRound className="size-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No secrets stored yet.</p>
              <Button size="sm" onClick={() => setEditor({ mode: "add", defaultScope: "personal" })}>
                <Plus className="size-4" />
                Add your first secret
              </Button>
            </div>
          )}

          {keys !== null && !empty && (
            <div className="max-w-2xl space-y-6">
              {/* Global Keys */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Globe className="size-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Global Keys
                    </span>
                    <span className="text-xs text-muted-foreground">(admin-managed, visible to all users)</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setEditor({ mode: "add", defaultScope: "global" })}
                  >
                    <Plus className="size-3" />
                    Add global key
                  </Button>
                </div>
                {globalKeys.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
                    No global keys yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {globalKeys.map((entry) => (
                      <SecretRow
                        key={`global:${entry.key}`}
                        entry={entry}
                        onEdit={() => setEditor({ mode: "edit", entry })}
                        onDelete={() => onDelete(entry)}
                      />
                    ))}
                  </div>
                )}
              </section>

              {/* Personal Keys */}
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <User className="size-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      My Keys
                    </span>
                    <span className="text-xs text-muted-foreground">(only you can see these)</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setEditor({ mode: "add", defaultScope: "personal" })}
                  >
                    <Plus className="size-3" />
                    Add my key
                  </Button>
                </div>
                {personalKeys.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
                    No personal keys yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {personalKeys.map((entry) => (
                      <SecretRow
                        key={`personal:${entry.key}`}
                        entry={entry}
                        onEdit={() => setEditor({ mode: "edit", entry })}
                        onDelete={() => onDelete(entry)}
                      />
                    ))}
                  </div>
                )}
              </section>

              {/* Environment variables (read-only) */}
              {envKeys.length > 0 && (
                <section>
                  <button
                    onClick={() => setShowEnv((v) => !v)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <span>{showEnv ? "▾" : "▸"}</span>
                    <span>
                      {envKeys.length} environment variable{envKeys.length !== 1 ? "s" : ""} available as secrets
                    </span>
                  </button>
                  {showEnv && (
                    <div className="mt-2 space-y-1.5">
                      {envKeys.map((entry) => (
                        <SecretRow
                          key={`env:${entry.key}`}
                          entry={entry}
                          onEdit={() => setEditor({ mode: "edit", entry })}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </main>
      </div>

      <VaultEditor
        state={editor}
        onClose={() => setEditor(null)}
        onSaved={() => {
          setEditor(null);
          refresh();
        }}
      />
    </div>
  );
}

function SecretRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: VaultKeyEntry;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const isEnv = entry.source === "env";
  const hasTimestamp = (entry.updated_at ?? 0) > 0;

  return (
    <div
      className={`group flex items-center justify-between rounded-lg border px-4 py-3 ${
        isEnv ? "border-border/50 bg-muted/20" : "border-border bg-card"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className={`font-mono text-sm font-medium ${isEnv ? "text-muted-foreground" : ""}`}>
          {entry.key}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono tracking-widest">••••••••</span>
          {hasTimestamp && <span>· updated {timeAgo(entry.updated_at)}</span>}
          {isEnv && (
            <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide">
              env
            </span>
          )}
          {!isEnv && (
            <span
              className={`rounded px-1 py-0.5 text-[10px] uppercase tracking-wide ${
                entry.scope === "global"
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {entry.scope}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button
          size="sm"
          variant="ghost"
          onClick={onEdit}
          aria-label={`Edit ${entry.key}`}
          title={isEnv ? "Override with vault value" : "Edit"}
        >
          <Pencil className="size-3.5" />
        </Button>
        {!isEnv && onDelete && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label={`Delete ${entry.key}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function VaultEditor({
  state,
  onClose,
  onSaved,
}: {
  state: EditorState | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [keyName, setKeyName] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"personal" | "global">("personal");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = state?.mode === "edit";
  const open = state !== null;

  useEffect(() => {
    if (state?.mode === "edit") {
      setKeyName(state.entry.key);
      setScope(state.entry.scope);
    } else if (state?.mode === "add") {
      setKeyName("");
      setScope(state.defaultScope);
    }
    setValue("");
    setReveal(false);
    setError(null);
  }, [state]);

  const onSave = async () => {
    const k = keyName.trim();
    const v = value.trim();
    if (!k || !v) return;
    setSaving(true);
    setError(null);
    try {
      await saveIntegrationKey(k, v, scope);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Update secret" : "Add secret"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Enter a new value to overwrite the existing secret."
              : "Store a secret in the encrypted vault. The value is never displayed after saving."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Scope selector — only shown when adding */}
          {!isEdit && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Scope
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setScope("personal")}
                  className={`flex flex-1 items-center gap-1.5 rounded-md border px-3 py-2 text-xs transition-colors ${
                    scope === "personal"
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:border-foreground/30"
                  }`}
                >
                  <User className="size-3.5" />
                  My key
                </button>
                <button
                  type="button"
                  onClick={() => setScope("global")}
                  className={`flex flex-1 items-center gap-1.5 rounded-md border px-3 py-2 text-xs transition-colors ${
                    scope === "global"
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border text-muted-foreground hover:border-foreground/30"
                  }`}
                >
                  <Globe className="size-3.5" />
                  Global (admin)
                </button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Key name
            </label>
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="e.g. GMAIL_API_KEY"
              className="font-mono"
              disabled={isEdit}
              autoComplete="off"
              autoFocus={!isEdit}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Value
            </label>
            <div className="relative">
              <Input
                type={reveal ? "text" : "password"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={isEdit ? "Enter new value…" : "Enter secret value…"}
                className="pr-9 font-mono"
                autoComplete="off"
                autoFocus={isEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSave();
                }}
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={reveal ? "Hide value" : "Show value"}
              >
                {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {error && <div className="text-xs text-destructive">{error}</div>}

          <Button
            onClick={onSave}
            disabled={saving || !keyName.trim() || !value.trim()}
            className="w-full"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : isEdit ? (
              "Update"
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
