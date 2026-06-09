"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, KeyRound, Plus, ServerCog, Trash2 } from "lucide-react";

import { BrandIcon } from "@/components/brand-icons";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createRuntimeHarness,
  deleteRuntimeHarness,
  listRuntimeHarnesses,
  saveAgentRuntimeCredential,
  updateRuntimeHarness,
} from "@/lib/api";
import type { RuntimeHarness } from "@/lib/types";

const SPEC_DEFAULTS: Record<string, string> = {
  claude_managed_agents: "https://api.anthropic.com",
  cursor: "https://api.cursor.com",
  gemini_antigravity: "https://generativelanguage.googleapis.com",
  opencode: "http://127.0.0.1:4096",
};

const SPEC_LABELS: Record<string, string> = {
  claude_managed_agents: "Claude Managed Agents",
  cursor: "Cursor",
  gemini_antigravity: "Gemini Antigravity",
  opencode: "OpenCode",
};

function harnessIconId(alias: string): string {
  if (alias === "claude_managed_agents") return "claude";
  if (alias === "cursor") return "cursor";
  if (alias === "gemini_antigravity") return "gemini";
  if (alias === "opencode") return "opencode";
  return alias;
}

function AddHarnessModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (harnesses: RuntimeHarness[]) => void;
}) {
  const [alias, setAlias] = useState("");
  const [apiSpec, setApiSpec] = useState("claude_managed_agents");
  const [apiBase, setApiBase] = useState(SPEC_DEFAULTS.claude_managed_agents);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSpecChange = (spec: string | null) => {
    if (!spec) return;
    setApiSpec(spec);
    setApiBase(SPEC_DEFAULTS[spec] ?? "");
  };

  const handleCreate = async () => {
    const trimmedAlias = alias.trim();
    const trimmedKey = apiKey.trim();
    const trimmedBase = apiBase.trim();
    if (!trimmedAlias) { setError("Alias is required"); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedAlias)) {
      setError("Alias must only contain letters, numbers, hyphens, and underscores");
      return;
    }
    if (["claude_managed_agents","cursor","gemini_antigravity","opencode","claude_agents"].includes(trimmedAlias)) {
      setError(`"${trimmedAlias}" is a reserved alias`);
      return;
    }
    if (!trimmedKey) { setError("API key is required"); return; }
    if (!trimmedBase) { setError("API base is required"); return; }
    setSaving(true);
    setError(null);
    try {
      const next = await createRuntimeHarness({
        alias: trimmedAlias,
        api_spec: apiSpec,
        api_base: trimmedBase,
        api_key: trimmedKey,
      });
      onCreated(next ?? []);
      setAlias("");
      setApiKey("");
      setApiSpec("claude_managed_agents");
      setApiBase(SPEC_DEFAULTS.claude_managed_agents);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create runtime");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Runtime</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1">
            <Label>Alias</Label>
            <Input
              placeholder="e.g. anthropic-dev"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Unique name users reference when building agents
            </p>
          </div>
          <div className="space-y-1">
            <Label>API Spec</Label>
            <Select value={apiSpec} onValueChange={handleSpecChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude_managed_agents">Claude Managed Agents</SelectItem>
                <SelectItem value="cursor">Cursor</SelectItem>
                <SelectItem value="gemini_antigravity">Gemini Antigravity</SelectItem>
                <SelectItem value="opencode">OpenCode</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>API Base</Label>
            <Input
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>API Key</Label>
            <Input
              type="password"
              placeholder="Runtime API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? "Creating…" : "Create Runtime"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HarnessCard({
  harness,
  onUpdated,
  onDeleted,
}: {
  harness: RuntimeHarness;
  onUpdated: (harnesses: RuntimeHarness[]) => void;
  onDeleted: (harnesses: RuntimeHarness[]) => void;
}) {
  const [key, setKey] = useState("");
  const [base, setBase] = useState(harness.api_base);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmedKey = key.trim();
    const trimmedBase = base.trim();
    if (!trimmedKey && trimmedBase === harness.api_base) return;
    if (!trimmedBase) { setError("API base cannot be empty"); return; }
    setSaving(true);
    setError(null);
    try {
      if (harness.is_default) {
        // Default runtimes use the existing /api/agent-runtimes endpoint (reserved aliases rejected by new endpoint)
        if (!trimmedKey) { setError("API key is required"); setSaving(false); return; }
        await saveAgentRuntimeCredential({ runtime: harness.alias, apiKey: trimmedKey, apiBase: trimmedBase });
        const next = await listRuntimeHarnesses();
        onUpdated(next ?? []);
      } else {
        const next = await updateRuntimeHarness(harness.alias, {
          ...(trimmedKey ? { api_key: trimmedKey } : {}),
          ...(trimmedBase !== harness.api_base ? { api_base: trimmedBase } : {}),
        });
        onUpdated(next ?? []);
      }
      setKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete runtime "${harness.alias}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteRuntimeHarness(harness.alias);
      const next = await listRuntimeHarnesses();
      onDeleted(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setDeleting(false);
    }
  };

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-sm">
            <BrandIcon id={harnessIconId(harness.alias)} className="size-5" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{harness.display_name}</span>
              <Badge variant="outline" className="text-xs">
                {SPEC_LABELS[harness.api_spec] ?? harness.api_spec}
              </Badge>
            </div>
            {harness.masked_api_key && (
              <p className="text-xs text-muted-foreground font-mono">{harness.masked_api_key}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={harness.connected ? "default" : "secondary"}
            className={
              harness.connected ? "bg-green-500/20 text-green-700 dark:text-green-400" : ""
            }
          >
            {harness.connected ? (
              <>
                <Check className="size-3 mr-1" />
                Connected
              </>
            ) : (
              "Missing"
            )}
          </Badge>
          {!harness.is_default && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive hover:text-destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-2">
        <div className="space-y-1">
          <Label className="text-xs flex items-center gap-1">
            <KeyRound className="size-3" /> API key
          </Label>
          <Input
            type="password"
            placeholder="Runtime API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">API base</Label>
          <Input value={base} onChange={(e) => setBase(e.target.value)} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || (!key.trim() && base === harness.api_base)}
        >
          {saving ? "Saving…" : <><Check className="size-3.5 mr-1" />Save</>}
        </Button>
      </div>
    </Card>
  );
}

export default function RuntimesPage() {
  const [harnesses, setHarnesses] = useState<RuntimeHarness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    const next = await listRuntimeHarnesses();
    setHarnesses(next ?? []);
  }, []);

  useEffect(() => {
    refresh()
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load runtimes"),
      )
      .finally(() => setLoading(false));
  }, [refresh]);

  const safeHarnesses = harnesses ?? [];
  const defaults = safeHarnesses.filter((h) => h.is_default);
  const custom = safeHarnesses.filter((h) => !h.is_default);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-auto">
        <header className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <ServerCog className="size-5" />
            <h1 className="font-semibold">Agent Runtimes</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="size-3.5 mr-1" />
              New Runtime
            </Button>
            <ThemeToggle />
          </div>
        </header>
        <main className="p-6 space-y-8 max-w-2xl">
          {loading && <p className="text-muted-foreground">Loading…</p>}
          {error && <p className="text-destructive">{error}</p>}
          {!loading && (
            <>
              <section className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                  Default Runtimes
                </h2>
                <p className="text-xs text-muted-foreground -mt-1">
                  Connect SDK agent runtimes before starting runtime sessions.
                </p>
                {defaults.map((h) => (
                  <HarnessCard
                    key={h.alias}
                    harness={h}
                    onUpdated={(next) => setHarnesses(next ?? [])}
                    onDeleted={(next) => setHarnesses(next ?? [])}
                  />
                ))}
              </section>
              {custom.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    Custom Runtimes
                  </h2>
                  {custom.map((h) => (
                    <HarnessCard
                      key={h.alias}
                      harness={h}
                      onUpdated={(next) => setHarnesses(next ?? [])}
                      onDeleted={(next) => setHarnesses(next ?? [])}
                    />
                  ))}
                </section>
              )}
            </>
          )}
        </main>
      </div>
      <AddHarnessModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onCreated={(next) => setHarnesses(next)}
      />
    </div>
  );
}
