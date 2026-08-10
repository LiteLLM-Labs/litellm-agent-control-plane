"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  KeyRound,
  Plus,
  ServerCog,
  Trash2,
  Unplug,
} from "lucide-react";

import { BrandIcon } from "@/components/brand-icons";
import { RuntimeProviderLogo } from "@/components/runtime-provider-logo";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  apiErrorMessage,
  cancelCodexLogin,
  createCodexConnection,
  createRuntimeHarness,
  deleteCodexConnection,
  deleteAgentRuntimeCredential,
  deleteRuntimeHarness,
  listCodexConnections,
  listRuntimeHarnesses,
  logoutCodexConnection,
  readCodexAccount,
  saveAgentRuntimeCredential,
  startCodexLogin,
  updateRuntimeHarness,
} from "@/lib/api";
import {
  fetchRuntimeTemplates,
  RUNTIME_TEMPLATES,
  runtimeTemplateById,
  runtimeTemplateIconId,
  type RuntimeTemplate,
} from "@/lib/runtime-templates";
import type { CodexAccountState, CodexDeviceLogin, CodexProfile, RuntimeHarness } from "@/lib/types";
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
    value: "codex_api",
    label: "Codex — OpenAI API",
    apiSpec: "claude_managed_agents",
    defaultApiBase: "",
  },
  {
    value: "codex_chatgpt",
    label: "Codex — ChatGPT",
    apiSpec: "claude_managed_agents",
    defaultApiBase: "",
  },
  {
    value: "codex_remote_ssh",
    label: "Codex — Remote SSH",
    apiSpec: "claude_managed_agents",
    defaultApiBase: "",
  },
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
  return <RuntimeProviderLogo alias={harness.alias} apiSpec={harness.api_spec} />;
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
  controllers,
}: {
  open: boolean;
  template: RuntimeTemplate | null;
  onClose: () => void;
  onCreated: (harnesses: RuntimeHarness[]) => void;
  controllers: RuntimeHarness[];
}) {
  const [alias, setAlias] = useState("");
  const [runtimeOption, setRuntimeOption] = useState("claude_managed_agents");
  const [apiSpec, setApiSpec] = useState("claude_managed_agents");
  const [apiBase, setApiBase] = useState(SPEC_DEFAULTS.claude_managed_agents);
  const [apiKey, setApiKey] = useState("");
  const [controllerAlias, setControllerAlias] = useState("Codex-app-server");
  const [model, setModel] = useState("gpt-5.6-sol-high");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("");
  const [sshAuth, setSshAuth] = useState("private_key");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [sshWorkspace, setSshWorkspace] = useState(".");
  const [sshCodexBin, setSshCodexBin] = useState("codex");
  const [sshFingerprint, setSshFingerprint] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRuntimeOptionChange = (value: string | null) => {
    const option = RUNTIME_OPTIONS.find((candidate) => candidate.value === value);
    if (!option) return;
    setRuntimeOption(option.value);
    setApiSpec(option.apiSpec);
    setApiBase(option.defaultApiBase);
    if (option.value === "codex_api") setModel("gpt-5.6-sol-high");
    if (option.value === "codex_chatgpt" || option.value === "codex_remote_ssh") setModel("gpt-5.6-sol");
  };

  const reset = useCallback(() => {
    setAlias("");
    setApiKey("");
    setRuntimeOption("claude_managed_agents");
    setApiSpec("claude_managed_agents");
    setApiBase(SPEC_DEFAULTS.claude_managed_agents);
    setControllerAlias(controllers[0]?.alias ?? "Codex-app-server");
    setModel("gpt-5.6-sol-high");
    setSshHost("");
    setSshPort("22");
    setSshUsername("");
    setSshAuth("private_key");
    setSshPassword("");
    setSshPrivateKey("");
    setSshPassphrase("");
    setSshWorkspace(".");
    setSshCodexBin("codex");
    setSshFingerprint("");
    setError(null);
  }, [controllers]);

  useEffect(() => {
    if (!open) return;
    if (!template) {
      reset();
      return;
    }
    const matchingOption =
      (template.id === "codex" ? "codex_api" : RUNTIME_OPTIONS.find((option) => option.value === template.id)?.value) ??
      RUNTIME_OPTIONS.find((option) => option.apiSpec === template.apiSpec)?.value ??
      "claude_managed_agents";
    setAlias(template.runtimeAlias);
    setApiKey("");
    setRuntimeOption(matchingOption);
    setApiSpec(template.apiSpec);
    setApiBase("");
    setControllerAlias(controllers[0]?.alias ?? "Codex-app-server");
    setModel("gpt-5.6-sol-high");
    setError(null);
  }, [controllers, open, reset, template]);

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
    const isCodex = runtimeOption.startsWith("codex_");
    if (isCodex && !controllerAlias.trim()) return setError("Codex controller is required.");
    if (!isCodex && !trimmedKey) return setError("API key is required.");
    if (!isCodex && !trimmedBase) return setError("API base is required.");
    if (runtimeOption === "codex_api" && !trimmedKey) return setError("OpenAI API key is required.");
    if (runtimeOption === "codex_api" && !trimmedBase) return setError("OpenAI-compatible base URL is required.");
    if (runtimeOption === "codex_remote_ssh") {
      if (!sshHost.trim() || !sshUsername.trim()) return setError("SSH host and username are required.");
      if (sshAuth === "private_key" && !sshPrivateKey.trim()) return setError("SSH private key is required.");
      if (sshAuth === "password" && !sshPassword) return setError("SSH password is required.");
    }
    setSaving(true);
    setError(null);
    try {
      const next = isCodex
        ? await createCodexConnection({
            controller_alias: controllerAlias.trim(),
            alias: trimmedAlias,
            type: runtimeOption.replace("codex_", ""),
            model: model.trim(),
            ...(runtimeOption === "codex_api" ? { baseUrl: trimmedBase, apiKey: trimmedKey } : {}),
            ...(runtimeOption === "codex_remote_ssh" ? {
              ssh: {
                host: sshHost.trim(),
                port: Number(sshPort),
                username: sshUsername.trim(),
                ...(sshAuth === "password" ? { password: sshPassword } : {
                  privateKey: sshPrivateKey,
                  ...(sshPassphrase ? { passphrase: sshPassphrase } : {}),
                }),
                workspace: sshWorkspace.trim() || ".",
                codexBin: sshCodexBin.trim() || "codex",
                ...(sshFingerprint.trim() ? { hostFingerprint: sshFingerprint.trim() } : {}),
              },
            } : {}),
          })
        : await createRuntimeHarness({
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
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
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
          {runtimeOption.startsWith("codex_") && (
            <>
              <div className="grid gap-1.5">
                <Label>Codex app-server controller</Label>
                <Select value={controllerAlias} onValueChange={(value) => value && setControllerAlias(value)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {controllers.map((controller) => (
                      <SelectItem key={controller.alias} value={controller.alias}>{controller.alias}</SelectItem>
                    ))}
                    {controllers.length === 0 && <SelectItem value="Codex-app-server">Codex-app-server</SelectItem>}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">One bridge service can host multiple isolated Codex connections.</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="codex-model">Default model</Label>
                <Input id="codex-model" value={model} onChange={(event) => setModel(event.target.value)} className="font-mono text-xs" />
              </div>
            </>
          )}
          {(runtimeOption === "codex_api" || !runtimeOption.startsWith("codex_")) && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="runtime-api-base">{runtimeOption === "codex_api" ? "OpenAI-compatible base URL" : "API base"}</Label>
                <Input id="runtime-api-base" value={apiBase} onChange={(event) => setApiBase(event.target.value)} className="font-mono text-xs" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="runtime-api-key">{runtimeOption === "codex_api" ? "OpenAI API key" : "API key"}</Label>
                <div className="relative">
                  <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="runtime-api-key" type="password" placeholder={runtimeOption === "codex_api" ? "OpenAI API key" : "Runtime API key"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="pl-8 font-mono text-xs" />
                </div>
              </div>
            </>
          )}
          {runtimeOption === "codex_chatgpt" && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              After creation, expand the runtime and choose <span className="font-medium text-foreground">Sign in with ChatGPT</span>. The portal will show a device code; no OpenAI API key is needed.
            </div>
          )}
          {runtimeOption === "codex_remote_ssh" && (
            <div className="grid gap-3 rounded-lg border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
                <div className="grid gap-1.5"><Label htmlFor="ssh-host">Host or IP</Label><Input id="ssh-host" value={sshHost} onChange={(event) => setSshHost(event.target.value)} /></div>
                <div className="grid gap-1.5"><Label htmlFor="ssh-port">Port</Label><Input id="ssh-port" inputMode="numeric" value={sshPort} onChange={(event) => setSshPort(event.target.value)} /></div>
              </div>
              <div className="grid gap-1.5"><Label htmlFor="ssh-user">Username</Label><Input id="ssh-user" value={sshUsername} onChange={(event) => setSshUsername(event.target.value)} /></div>
              <div className="grid gap-1.5"><Label>Authentication</Label><Select value={sshAuth} onValueChange={(value) => value && setSshAuth(value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="private_key">SSH private key</SelectItem><SelectItem value="password">Password</SelectItem></SelectContent></Select></div>
              {sshAuth === "password" ? (
                <div className="grid gap-1.5"><Label htmlFor="ssh-password">Password</Label><Input id="ssh-password" type="password" value={sshPassword} onChange={(event) => setSshPassword(event.target.value)} /></div>
              ) : (
                <><div className="grid gap-1.5"><Label htmlFor="ssh-key">Private key</Label><Textarea id="ssh-key" rows={5} value={sshPrivateKey} onChange={(event) => setSshPrivateKey(event.target.value)} className="font-mono text-xs" /></div><div className="grid gap-1.5"><Label htmlFor="ssh-passphrase">Key passphrase (optional)</Label><Input id="ssh-passphrase" type="password" value={sshPassphrase} onChange={(event) => setSshPassphrase(event.target.value)} /></div></>
              )}
              <div className="grid gap-3 sm:grid-cols-2"><div className="grid gap-1.5"><Label htmlFor="ssh-workspace">Remote workspace</Label><Input id="ssh-workspace" value={sshWorkspace} onChange={(event) => setSshWorkspace(event.target.value)} className="font-mono text-xs" /></div><div className="grid gap-1.5"><Label htmlFor="ssh-codex">Codex executable</Label><Input id="ssh-codex" value={sshCodexBin} onChange={(event) => setSshCodexBin(event.target.value)} className="font-mono text-xs" /></div></div>
              <div className="grid gap-1.5"><Label htmlFor="ssh-fingerprint">Host key fingerprint (optional)</Label><Input id="ssh-fingerprint" placeholder="SHA256:..." value={sshFingerprint} onChange={(event) => setSshFingerprint(event.target.value)} className="font-mono text-xs" /><p className="text-xs text-muted-foreground">Pinning is recommended. Creation also verifies that the remote Codex app-server starts successfully.</p></div>
            </div>
          )}
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
  profiles,
}: {
  title: string;
  empty: string;
  harnesses: RuntimeHarness[];
  selectedAlias: string | null;
  onSelect: (alias: string) => void;
  onUpdated: (harnesses: RuntimeHarness[]) => void;
  profiles: Map<string, CodexProfile>;
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
                {selected && <RuntimeDetails harness={harness} onUpdated={onUpdated} profile={profiles.get(harness.alias)} />}
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
  profile,
}: {
  harness: RuntimeHarness;
  onUpdated: (harnesses: RuntimeHarness[]) => void;
  profile?: CodexProfile;
}) {
  if (harness.codex_profile_type && harness.codex_controller_alias) {
    return <CodexRuntimeDetails harness={harness} profile={profile} onUpdated={onUpdated} />;
  }
  return <StandardRuntimeDetails harness={harness} onUpdated={onUpdated} />;
}

function StandardRuntimeDetails({
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

function CodexRuntimeDetails({
  harness,
  profile,
  onUpdated,
}: {
  harness: RuntimeHarness;
  profile?: CodexProfile;
  onUpdated: (harnesses: RuntimeHarness[]) => void;
}) {
  const controller = harness.codex_controller_alias!;
  const isChatGpt = harness.codex_profile_type === "chatgpt";
  const [account, setAccount] = useState<CodexAccountState | null>(null);
  const [login, setLogin] = useState<CodexDeviceLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAccount = useCallback(async () => {
    if (!isChatGpt) return;
    try {
      const next = await readCodexAccount(controller, harness.alias);
      setAccount(next);
      if (next.account?.type === "chatgpt") setLogin(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to read ChatGPT sign-in status."));
    }
  }, [controller, harness.alias, isChatGpt]);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    if (!login) return;
    const timer = window.setInterval(() => void refreshAccount(), 2500);
    return () => window.clearInterval(timer);
  }, [login, refreshAccount]);

  const beginLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      setLogin(await startCodexLogin(controller, harness.alias));
    } catch (err) {
      setError(apiErrorMessage(err, "Could not start ChatGPT sign-in."));
    } finally {
      setBusy(false);
    }
  };

  const cancelLogin = async () => {
    if (!login) return;
    setBusy(true);
    try {
      await cancelCodexLogin(controller, harness.alias, login.loginId);
      setLogin(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not cancel ChatGPT sign-in."));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await logoutCodexConnection(controller, harness.alias);
      await refreshAccount();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not sign out."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete Codex runtime "${harness.alias}" and its stored sessions? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await deleteCodexConnection(controller, harness.alias);
      onUpdated(await listRuntimeHarnesses());
    } catch (err) {
      setError(apiErrorMessage(err, "Could not delete Codex runtime."));
    } finally {
      setBusy(false);
    }
  };

  const signedIn = account?.account?.type === "chatgpt";
  return (
    <div className="border-t border-border bg-muted/20 px-4 py-4 sm:pl-[4.75rem]">
      <div className="grid gap-4">
        <div className="grid gap-2 rounded-lg border border-border bg-background/70 p-3 text-sm sm:grid-cols-3">
          <div><span className="text-xs text-muted-foreground">Connection</span><div className="mt-1 font-medium">{profile?.type === "remote_ssh" ? "Remote SSH" : profile?.type === "api" ? "OpenAI API" : "ChatGPT"}</div></div>
          <div><span className="text-xs text-muted-foreground">Model</span><div className="mt-1 font-mono text-xs">{profile?.model ?? "Loading..."}</div></div>
          <div><span className="text-xs text-muted-foreground">Bridge</span><div className="mt-1 font-medium">{profile?.ready === false ? "Unavailable" : "Ready"}</div></div>
        </div>

        {profile?.type === "api" && <p className="text-sm text-muted-foreground">Model requests go through <span className="font-mono text-xs text-foreground">{profile.baseUrl}</span>. The upstream API key remains encrypted inside the Codex controller.</p>}
        {profile?.type === "remote_ssh" && profile.ssh && (
          <div className="grid gap-1 text-sm text-muted-foreground">
            <p>Codex runs on <span className="font-mono text-xs text-foreground">{profile.ssh.username}@{profile.ssh.host}:{profile.ssh.port}</span> in <span className="font-mono text-xs text-foreground">{profile.ssh.workspace}</span>.</p>
            {profile.ssh.hostFingerprint && <p>Host key: <span className="font-mono text-xs text-foreground">{profile.ssh.hostFingerprint}</span></p>}
          </div>
        )}

        {isChatGpt && (
          <div className="grid gap-3 rounded-lg border border-border bg-background p-3">
            {signedIn ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><p className="text-sm font-medium">Signed in to ChatGPT</p><p className="text-xs text-muted-foreground">{account?.account?.email ?? "ChatGPT account"}{account?.account?.planType ? ` · ${account.account.planType}` : ""}</p></div>
                <Button variant="outline" size="sm" onClick={logout} disabled={busy}>Sign out</Button>
              </div>
            ) : login ? (
              <div className="grid gap-3">
                <div><p className="text-sm font-medium">Finish signing in</p><p className="text-xs text-muted-foreground">Open the verification page and enter this one-time code. This page checks the result automatically.</p></div>
                <div className="flex flex-wrap items-center gap-2"><code className="rounded-md border border-border bg-muted px-3 py-2 text-base font-semibold tracking-wider">{login.userCode}</code><Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(login.userCode)}><Copy className="size-3.5" />Copy</Button><Button size="sm" onClick={() => window.open(login.verificationUrl, "_blank", "noopener,noreferrer")}><ExternalLink className="size-3.5" />Open sign-in</Button></div>
                <Button variant="ghost" size="sm" className="w-fit" onClick={cancelLogin} disabled={busy}>Cancel sign-in</Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">ChatGPT sign-in required</p><p className="text-xs text-muted-foreground">Uses Codex device authorization; no OpenAI API key is needed.</p></div><Button size="sm" onClick={beginLogin} disabled={busy}>{busy ? "Starting..." : "Sign in with ChatGPT"}</Button></div>
            )}
          </div>
        )}

        {profile?.error && <p className="text-sm text-destructive">{profile.error}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end"><Button variant="destructive" size="sm" onClick={remove} disabled={busy}><Trash2 className="size-3.5" />Delete runtime</Button></div>
      </div>
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
  const [codexProfiles, setCodexProfiles] = useState<Map<string, CodexProfile>>(new Map());
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
  const codexControllers = useMemo(() => {
    const explicit = custom.filter((harness) => !harness.codex_profile_type && harness.alias.toLowerCase().includes("codex"));
    return explicit.length > 0 ? explicit : custom.filter((harness) => !harness.codex_profile_type && harness.api_spec === "claude_managed_agents");
  }, [custom]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(codexControllers.map(async (controller) => {
      try { return await listCodexConnections(controller.alias); } catch { return []; }
    })).then((groups) => {
      if (cancelled) return;
      setCodexProfiles(new Map(groups.flat().map((profile) => [profile.alias, profile])));
    });
    return () => { cancelled = true; };
  }, [codexControllers]);
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
                    profiles={codexProfiles}
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
                    profiles={codexProfiles}
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
        controllers={codexControllers}
      />
    </div>
  );
}
