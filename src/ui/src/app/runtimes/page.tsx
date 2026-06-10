"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  KeyRound,
  Plus,
  ServerCog,
  Trash2,
  Unplug,
} from "lucide-react";

import { BrandIcon } from "@/components/brand-icons";
import { RuntimeTemplateCard } from "@/components/runtime-template-card";
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
  apiErrorMessage,
  createRuntimeHarness,
  deleteAgentRuntimeCredential,
  deleteRuntimeHarness,
  listRuntimeHarnesses,
  saveAgentRuntimeCredential,
  updateRuntimeHarness,
} from "@/lib/api";
import { runtimeBrandIconId } from "@/lib/runtime-branding";
import {
  fetchRuntimeTemplates,
  RUNTIME_TEMPLATES,
  runtimeTemplateById,
  runtimeTemplateIconId,
  type RuntimeTemplate,
} from "@/lib/runtime-templates";
import type { RuntimeHarness } from "@/lib/types";
import { cn } from "@/lib/utils";

const SPEC_DEFAULTS: Record<string, string> = {
  claude_managed_agents: "https://api.anthropic.com",
  cursor: "https://api.cursor.com",
  gemini_antigravity: "https://generativelanguage.googleapis.com",
};

const SPEC_LABELS: Record<string, string> = {
  claude_managed_agents: "Claude Managed Agents",
  cursor: "Cursor",
  gemini_antigravity: "Gemini Antigravity",
};

const RUNTIME_OPTIONS = [
  {
    value: "claude_managed_agents",
    label: "Claude Managed Agents",
    apiSpec: "claude_managed_agents",
    defaultApiBase: SPEC_DEFAULTS.claude_managed_agents,
  },
  {
    value: "cursor",
    label: "Cursor",
    apiSpec: "cursor",
    defaultApiBase: SPEC_DEFAULTS.cursor,
  },
  {
    value: "gemini_antigravity",
    label: "Gemini Antigravity",
    apiSpec: "gemini_antigravity",
    defaultApiBase: SPEC_DEFAULTS.gemini_antigravity,
  },
];

const FALLBACK_DEFAULT_RUNTIMES: RuntimeHarness[] = [
  {
    alias: "claude_managed_agents",
    api_spec: "claude_managed_agents",
    display_name: "Claude Agents",
    api_base: SPEC_DEFAULTS.claude_managed_agents,
    is_default: true,
    connected: false,
    tools: [],
  },
  {
    alias: "cursor",
    api_spec: "cursor",
    display_name: "Cursor",
    api_base: SPEC_DEFAULTS.cursor,
    is_default: true,
    connected: false,
    tools: [],
  },
  {
    alias: "gemini_antigravity",
    api_spec: "gemini_antigravity",
    display_name: "Gemini Antigravity",
    api_base: SPEC_DEFAULTS.gemini_antigravity,
    is_default: true,
    connected: false,
    tools: [],
  },
];

const RESERVED_ALIASES = new Set([
  "claude_managed_agents",
  "cursor",
  "gemini_antigravity",
]);

function preferredAlias(harnesses: RuntimeHarness[]): string | null {
  return harnesses.find((harness) => !harness.connected)?.alias ?? harnesses[0]?.alias ?? null;
}

function runtimeLoadError(error: unknown): string {
  const message = apiErrorMessage(error, "Failed to load runtimes.");
  if (message.length <= 240) return message;
  return "Failed to load runtimes. Check the gateway API connection and refresh.";
}

function RuntimeLogo({ harness }: { harness: RuntimeHarness }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground shadow-sm">
      <BrandIcon id={runtimeBrandIconId(harness.alias, harness.api_spec)} className="size-5" />
    </span>
  );
}

function StatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <Badge className="border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
        <CheckCircle2 className="size-3" />
        Connected
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="text-muted-foreground">
      <AlertCircle className="size-3" />
      Needs key
    </Badge>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "good" | "warn" | "neutral";
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "good" && "text-emerald-700 dark:text-emerald-300",
          tone === "warn" && "text-amber-700 dark:text-amber-300",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function AddHarnessModal({
  open,
  template,
  onClose,
  onCreated,
}: {
  open: boolean;
  template: RuntimeTemplate | null;
  onClose: () => void;
  onCreated: (harnesses: RuntimeHarness[]) => void;
}) {
  const [alias, setAlias] = useState("");
  const [runtimeOption, setRuntimeOption] = useState("claude_managed_agents");
  const [apiSpec, setApiSpec] = useState("claude_managed_agents");
  const [apiBase, setApiBase] = useState(SPEC_DEFAULTS.claude_managed_agents);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRuntimeOptionChange = (value: string | null) => {
    const option = RUNTIME_OPTIONS.find((candidate) => candidate.value === value);
    if (!option) return;
    setRuntimeOption(option.value);
    setApiSpec(option.apiSpec);
    setApiBase(option.defaultApiBase);
  };

  const reset = useCallback(() => {
    setAlias("");
    setApiKey("");
    setRuntimeOption("claude_managed_agents");
    setApiSpec("claude_managed_agents");
    setApiBase(SPEC_DEFAULTS.claude_managed_agents);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!template) {
      reset();
      return;
    }
    const matchingOption =
      RUNTIME_OPTIONS.find((option) => option.apiSpec === template.apiSpec)?.value ??
      "claude_managed_agents";
    setAlias(template.runtimeAlias);
    setApiKey("");
    setRuntimeOption(matchingOption);
    setApiSpec(template.apiSpec);
    setApiBase("");
    setError(null);
  }, [open, reset, template]);

  const handleCreate = async () => {
    const trimmedAlias = alias.trim();
    const trimmedKey = apiKey.trim();
    const trimmedBase = apiBase.trim();
    if (!trimmedAlias) {
      setError("Alias is required.");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedAlias)) {
      setError("Alias can use letters, numbers, hyphens, and underscores.");
      return;
    }
    if (RESERVED_ALIASES.has(trimmedAlias)) {
      setError(`"${trimmedAlias}" is reserved.`);
      return;
    }
    if (!trimmedKey) {
      setError("API key is required.");
      return;
    }
    if (!trimmedBase) {
      setError("API base is required.");
      return;
    }
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
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create runtime.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{template ? `Add ${template.name} Runtime` : "New Runtime"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 pt-2">
          {template && (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground shadow-sm">
                <BrandIcon id={runtimeTemplateIconId(template)} className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium leading-tight">{template.name}</p>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {template.repoPath}
                </p>
              </div>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="runtime-alias">Alias</Label>
            <Input
              id="runtime-alias"
              placeholder="anthropic-dev"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Runtime</Label>
            <Select value={runtimeOption} onValueChange={handleRuntimeOptionChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RUNTIME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="runtime-api-base">API base</Label>
            <Input
              id="runtime-api-base"
              value={apiBase}
              onChange={(event) => setApiBase(event.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="runtime-api-key">API key</Label>
            <div className="relative">
              <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="runtime-api-key"
                type="password"
                placeholder="Runtime API key"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="pl-8 font-mono text-xs"
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={saving}>
              <Plus className="size-3.5" />
              {saving ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RuntimeRow({
  harness,
  selected,
  onSelect,
}: {
  harness: RuntimeHarness;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "relative flex w-full min-w-0 items-start gap-3 px-4 py-3 pr-10 text-left transition-colors hover:bg-muted/50 sm:grid sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:pr-4",
        selected && "bg-muted/70",
      )}
      onClick={onSelect}
    >
      <RuntimeLogo harness={harness} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-col items-start gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
          <span className="min-w-0 font-medium leading-tight">{harness.display_name}</span>
          <div className="flex max-w-full flex-wrap gap-1.5">
            <Badge variant={harness.is_default ? "secondary" : "outline"} className="text-[10px]">
              {harness.is_default ? "Default" : "Custom"}
            </Badge>
            <Badge variant="outline" className="max-w-full text-[10px]">
              {SPEC_LABELS[harness.api_spec] ?? harness.api_spec}
            </Badge>
          </div>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{harness.alias}</span>
          <span className="max-w-full truncate font-mono">{harness.api_base}</span>
          {harness.masked_api_key && (
            <span className="font-mono">{harness.masked_api_key}</span>
          )}
        </div>
        <div className="mt-2 sm:hidden">
          <StatusBadge connected={harness.connected} />
        </div>
      </div>
      <div className="hidden items-center gap-2 sm:flex">
        <StatusBadge connected={harness.connected} />
        <ChevronRight
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            selected && "rotate-90 text-foreground",
          )}
        />
      </div>
      <ChevronRight
        className={cn(
          "absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-transform sm:hidden",
          selected && "rotate-90 text-foreground",
        )}
      />
    </button>
  );
}

function RuntimeSection({
  title,
  empty,
  harnesses,
  selectedAlias,
  onSelect,
  onUpdated,
}: {
  title: string;
  empty: string;
  harnesses: RuntimeHarness[];
  selectedAlias: string | null;
  onSelect: (alias: string) => void;
  onUpdated: (harnesses: RuntimeHarness[]) => void;
}) {
  return (
    <section className="grid gap-2">
      <h2 className="text-[13.5px] font-semibold tracking-tight">{title}</h2>
      <Card className="min-w-0 overflow-hidden rounded-lg p-0">
        {harnesses.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">{empty}</div>
        ) : (
          harnesses.map((harness) => {
            const selected = selectedAlias === harness.alias;
            return (
              <div key={harness.alias}>
                <RuntimeRow
                  harness={harness}
                  selected={selected}
                  onSelect={() => onSelect(harness.alias)}
                />
                {selected && <RuntimeDetails harness={harness} onUpdated={onUpdated} />}
              </div>
            );
          })
        )}
      </Card>
    </section>
  );
}

function RuntimeTemplatesSection({
  templates,
  loading,
  error,
  onUse,
}: {
  templates: RuntimeTemplate[];
  loading: boolean;
  error: string | null;
  onUse: (template: RuntimeTemplate) => void;
}) {
  return (
    <section className="grid gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="text-[13.5px] font-semibold tracking-tight">Runtime templates</h2>
        </div>
        {loading && (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Syncing manifest...
          </span>
        )}
      </div>
      {error && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
          {error}
        </div>
      )}
      {templates.length === 0 ? (
        <Card className="rounded-lg px-4 py-5 text-sm text-muted-foreground">
          No runtime templates.
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <RuntimeTemplateCard key={template.id} template={template} onUse={onUse} />
          ))}
        </div>
      )}
    </section>
  );
}

function RuntimeDetails({
  harness,
  onUpdated,
}: {
  harness: RuntimeHarness;
  onUpdated: (harnesses: RuntimeHarness[]) => void;
}) {
  const [key, setKey] = useState("");
  const [base, setBase] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKey("");
    setBase(harness.api_base);
    setError(null);
  }, [harness.alias, harness.api_base]);

  const trimmedKey = key.trim();
  const trimmedBase = base.trim();
  const baseChanged = trimmedBase !== harness.api_base;
  const canSave = Boolean(trimmedBase && (trimmedKey || (!harness.is_default && baseChanged)));

  const handleSave = async () => {
    if (!trimmedBase) {
      setError("API base cannot be empty.");
      return;
    }
    if (harness.is_default && !trimmedKey) {
      setError("Enter an API key to update this runtime.");
      return;
    }
    if (!trimmedKey && !baseChanged) return;
    setSaving(true);
    setError(null);
    try {
      let next: RuntimeHarness[];
      if (harness.is_default) {
        await saveAgentRuntimeCredential({
          runtime: harness.alias,
          apiKey: trimmedKey,
          apiBase: trimmedBase,
        });
        next = await listRuntimeHarnesses();
      } else {
        next = await updateRuntimeHarness(harness.alias, {
          ...(trimmedKey ? { api_key: trimmedKey } : {}),
          ...(baseChanged ? { api_base: trimmedBase } : {}),
        });
      }
      setKey("");
      onUpdated(next ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save runtime.");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    const message = harness.is_default
      ? `Remove saved credentials for "${harness.display_name}"?`
      : `Delete runtime "${harness.alias}"? This cannot be undone.`;
    if (!confirm(message)) return;
    setRemoving(true);
    setError(null);
    try {
      if (harness.is_default) {
        await deleteAgentRuntimeCredential(harness.alias);
      } else {
        await deleteRuntimeHarness(harness.alias);
      }
      const next = await listRuntimeHarnesses();
      onUpdated(next ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove runtime.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="border-t border-border bg-muted/20 px-4 py-4 sm:pl-[4.75rem]">
      <div className="grid gap-4">
        <div className="grid min-w-0 gap-3 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor={`runtime-key-${harness.alias}`}>API key</Label>
            <div className="relative">
              <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id={`runtime-key-${harness.alias}`}
                type="password"
                placeholder={harness.connected ? "New runtime API key" : "Runtime API key"}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className="pl-8 font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`runtime-base-${harness.alias}`}>API base</Label>
            <Input
              id={`runtime-base-${harness.alias}`}
              value={base}
              onChange={(event) => setBase(event.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex flex-wrap justify-end gap-2 md:col-span-2 lg:col-span-1">
            {(!harness.is_default || harness.connected) && (
              <Button
                variant={harness.is_default ? "outline" : "destructive"}
                size="sm"
                onClick={handleRemove}
                disabled={saving || removing}
              >
                {harness.is_default ? (
                  <Unplug className="size-3.5" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                {removing ? "Removing..." : harness.is_default ? "Remove key" : "Delete"}
              </Button>
            )}
            <Button size="sm" onClick={handleSave} disabled={saving || !canSave}>
              <Check className="size-3.5" />
              {saving ? "Saving..." : harness.connected ? "Update" : "Connect"}
            </Button>
          </div>
        </div>

        <div className="grid gap-2 rounded-lg border border-border bg-background/70 p-3 text-xs sm:grid-cols-3">
          <div className="flex items-center justify-between gap-3 sm:block">
            <span className="text-muted-foreground">Type</span>
            <div className="mt-0 font-medium sm:mt-1">
              {harness.is_default ? "Default" : "Custom"}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 sm:block">
            <span className="text-muted-foreground">Key</span>
            <div className="mt-0 font-mono text-foreground sm:mt-1">
              {harness.masked_api_key ?? "Missing"}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 sm:block">
            <span className="text-muted-foreground">Sessions</span>
            <div className="mt-0 font-medium sm:mt-1">
              {harness.connected ? "Ready" : "Blocked"}
            </div>
          </div>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
    </div>
  );
}

export default function RuntimesPage() {
  const [harnesses, setHarnesses] = useState<RuntimeHarness[]>([]);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<RuntimeTemplate | null>(null);
  const [runtimeTemplates, setRuntimeTemplates] = useState<RuntimeTemplate[]>(RUNTIME_TEMPLATES);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const hasLoadedHarnessesRef = useRef(false);

  const applyHarnesses = useCallback((next: RuntimeHarness[]) => {
    const resolved = next ?? [];
    setHarnesses(resolved);
    setSelectedAlias((current) =>
      current && resolved.some((harness) => harness.alias === current)
        ? current
        : preferredAlias(resolved),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    listRuntimeHarnesses()
      .then((next) => {
        if (cancelled) return;
        hasLoadedHarnessesRef.current = true;
        setError(null);
        applyHarnesses(next ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(runtimeLoadError(err));
        if (!hasLoadedHarnessesRef.current) {
          applyHarnesses(FALLBACK_DEFAULT_RUNTIMES);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyHarnesses]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const templateId = params.get("template");
    if (!templateId) return;
    setPendingTemplateId(templateId);
    params.delete("template");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTemplatesLoading(true);
    setTemplatesError(null);
    fetchRuntimeTemplates()
      .then((templates) => {
        if (cancelled) return;
        setRuntimeTemplates(templates);
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof Error && err.message.trim()
            ? err.message
            : "Remote runtime template manifest unavailable";
        setRuntimeTemplates(RUNTIME_TEMPLATES);
        setTemplatesError(`${message}. Using bundled templates.`);
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pendingTemplateId || templatesLoading) return;
    const template = runtimeTemplateById(pendingTemplateId, runtimeTemplates);
    if (!template) {
      const message = `Runtime template "${pendingTemplateId}" was not found. Showing available templates.`;
      setTemplatesError((current) => (current ? `${current} ${message}` : message));
      setPendingTemplateId(null);
      return;
    }
    setSelectedTemplate(template);
    setShowAdd(true);
    setPendingTemplateId(null);
  }, [pendingTemplateId, runtimeTemplates, templatesLoading]);

  const defaults = useMemo(() => harnesses.filter((harness) => harness.is_default), [harnesses]);
  const custom = useMemo(() => harnesses.filter((harness) => !harness.is_default), [harnesses]);
  const connectedCount = useMemo(
    () => harnesses.filter((harness) => harness.connected).length,
    [harnesses],
  );
  const missingCount = Math.max(harnesses.length - connectedCount, 0);
  const openAddRuntime = (template: RuntimeTemplate | null = null) => {
    setSelectedTemplate(template);
    setShowAdd(true);
  };
  const closeAddRuntime = () => {
    setShowAdd(false);
    setSelectedTemplate(null);
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <ServerCog className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Agent Runtimes</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => openAddRuntime()}>
              <Plus className="size-3.5" />
              New Runtime
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold tracking-tight">Runtime Credentials</h2>
              {loading && <p className="text-xs text-muted-foreground">Loading runtimes...</p>}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>

            {!loading && (
              <>
                <div className="grid gap-2 sm:grid-cols-3">
                  <SummaryTile label="Connected" value={connectedCount} tone="good" />
                  <SummaryTile label="Needs key" value={missingCount} tone="warn" />
                  <SummaryTile label="Custom" value={custom.length} tone="neutral" />
                </div>

                <div className="grid min-w-0 content-start gap-5">
                  <RuntimeSection
                    title="Default runtimes"
                    empty="No default runtimes."
                    harnesses={defaults}
                    selectedAlias={selectedAlias}
                    onSelect={setSelectedAlias}
                    onUpdated={applyHarnesses}
                  />
                  <RuntimeTemplatesSection
                    templates={runtimeTemplates}
                    loading={templatesLoading}
                    error={templatesError}
                    onUse={openAddRuntime}
                  />
                  <RuntimeSection
                    title="Custom runtimes"
                    empty="No custom runtimes."
                    harnesses={custom}
                    selectedAlias={selectedAlias}
                    onSelect={setSelectedAlias}
                    onUpdated={applyHarnesses}
                  />
                </div>
              </>
            )}
          </div>
        </main>
      </div>
      <AddHarnessModal
        open={showAdd}
        template={selectedTemplate}
        onClose={closeAddRuntime}
        onCreated={applyHarnesses}
      />
    </div>
  );
}
