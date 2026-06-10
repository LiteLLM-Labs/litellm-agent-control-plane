"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RuntimeProviderLogo } from "@/components/runtime-provider-logo";
import {
  discoverProviderAgents,
  importProviderAgents,
  listRuntimeHarnesses,
  type ExternalAgent,
} from "@/lib/api";
import type { Agent, RuntimeHarness } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ImportAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (agents: Agent[]) => void;
}

export function ImportAgentDialog({ open, onOpenChange, onImported }: ImportAgentDialogProps) {
  const [providers, setProviders] = useState<RuntimeHarness[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialMode, setCredentialMode] = useState<"shared" | "byo">("shared");
  const [externalAgents, setExternalAgents] = useState<ExternalAgent[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvidersLoading(true);
    listRuntimeHarnesses()
      .then((values) => {
        setProviders(values);
        const first = values[0];
        setProviderId(first?.alias ?? "");
      })
      .catch(() => {
        setProviders([]);
        setProviderId("");
      })
      .finally(() => setProvidersLoading(false));
  }, [open]);

  const selectedProvider = providers.find((provider) => provider.alias === providerId);
  const providerName = selectedProvider?.display_name ?? providerId;
  const filteredAgents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return externalAgents;
    return externalAgents.filter((agent) =>
      `${agent.name} ${agent.description ?? ""} ${agent.id}`.toLowerCase().includes(normalized),
    );
  }, [externalAgents, query]);

  const reset = () => {
    setEndpoint("");
    setApiKey("");
    setCredentialMode("shared");
    setExternalAgents([]);
    setSelectedIds([]);
    setQuery("");
    setError(null);
  };

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) reset();
  };

  const discover = async () => {
    setLoading(true);
    setError(null);
    try {
      const discovered = await discoverProviderAgents({ providerId, endpoint, apiKey });
      setExternalAgents(discovered);
      setSelectedIds(discovered.map((agent) => agent.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const importSelected = async () => {
    const selected = externalAgents.filter((agent) => selectedIds.includes(agent.id));
    if (selected.length === 0) {
      setError("Select at least one agent.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const imported = await importProviderAgents({
        providerId,
        endpoint,
        apiKey: credentialMode === "shared" ? apiKey : undefined,
        credentialMode,
        agents: selected.map((agent) => ({
          externalId: agent.id,
          name: agent.name,
          description: agent.description,
          model: agent.model,
          raw: agent.raw,
        })),
      });
      onImported(imported);
      close(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleAgent = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="w-[94vw] sm:max-w-3xl max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border">
          <DialogTitle>Import agents</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-4 overflow-y-auto">
          <div className="grid gap-1.5">
            <Label>Platform</Label>
            <div className="grid gap-2">
              {providers.map((provider) => {
                const selected = provider.alias === providerId;
                return (
                  <button
                    key={provider.alias}
                    type="button"
                    onClick={() => setProviderId(provider.alias)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-muted/50",
                      selected && "border-ring bg-muted/60 ring-2 ring-ring/20",
                    )}
                  >
                    <RuntimeProviderLogo alias={provider.alias} apiSpec={provider.api_spec} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium leading-tight">
                        {provider.display_name}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                        {provider.alias}
                      </span>
                    </span>
                  </button>
                );
              })}
              {providersLoading && (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  Loading runtime providers...
                </div>
              )}
              {!providersLoading && providers.length === 0 && (
                <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No runtime providers are available.
                </div>
              )}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="import-endpoint">{providerName} endpoint</Label>
            <Input
              id="import-endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://deployment.kb.us-central1.gcp.cloud.es.io"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="import-key">{providerName} API key</Label>
            <Input
              id="import-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API key"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Credential policy</Label>
            <div className="grid grid-cols-2 rounded-lg border border-border bg-muted/30 p-1">
              {[
                { value: "shared" as const, label: "Shared key" },
                { value: "byo" as const, label: "BYO key" },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setCredentialMode(option.value)}
                  className={cn(
                    "h-8 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors",
                    credentialMode === option.value
                      ? "bg-background text-foreground shadow-sm"
                      : "hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={discover}
              disabled={loading || !providerId || !endpoint.trim() || !apiKey.trim()}
            >
              {loading ? "Connecting..." : "Connect"}
            </Button>
            {externalAgents.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {externalAgents.length} agent{externalAgents.length === 1 ? "" : "s"} found
              </span>
            )}
          </div>
          {externalAgents.length > 0 && (
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-2 size-4 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search agents"
                    className="pl-8"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedIds(filteredAgents.map((agent) => agent.id))}
                >
                  Select all
                </Button>
              </div>
              <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {filteredAgents.map((agent) => (
                  <label
                    key={agent.id}
                    className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selectedIds.includes(agent.id)}
                      onChange={() => toggleAgent(agent.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{agent.name}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {agent.id}
                      </span>
                      {agent.description && (
                        <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                          {agent.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                {filteredAgents.length === 0 && (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No agents match the search.
                  </p>
                )}
              </div>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="m-0 rounded-b-xl px-6 py-4">
          <Button variant="outline" onClick={() => close(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={importSelected} disabled={saving || selectedIds.length === 0}>
            {saving ? "Importing..." : `Import ${selectedIds.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
