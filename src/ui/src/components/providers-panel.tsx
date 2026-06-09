"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Check, KeyRound, Plus, X } from "lucide-react";

import { BrandIcon } from "@/components/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteProvider,
  listProviders,
  saveProvider,
  type AvailableProvider,
  type ConnectedProvider,
} from "@/lib/api";

type Step = "catalog" | "configure" | "connected";

export function ProvidersPanel() {
  const [step, setStep] = useState<Step>("catalog");
  const [availableProviders, setAvailableProviders] = useState<AvailableProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = useMemo(
    () => availableProviders.find((provider) => provider.id === selectedProviderId),
    [availableProviders, selectedProviderId],
  );
  const selectedConnectedProvider = useMemo(
    () => connectedProviders.find((provider) => provider.id === selectedProviderId) ?? null,
    [connectedProviders, selectedProviderId],
  );
  const connected = Boolean(selectedConnectedProvider);

  const refreshProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listProviders();
      const requestedProviderId = providerIdFromLocation();
      const availableModelProviders = data.available_providers.filter(isModelProvider);
      const connectedModelProviders = data.connected_providers.filter(isModelProvider);
      setAvailableProviders(availableModelProviders);
      const requestedProvider =
        availableModelProviders.find((provider) => provider.id === requestedProviderId) ?? null;
      const connectedProvider = requestedProvider
        ? connectedModelProviders.find((provider) => provider.id === requestedProvider.id) ?? null
        : connectedModelProviders[0] ?? null;
      const provider =
        requestedProvider ??
        availableModelProviders.find((provider) => provider.id === connectedProvider?.id) ??
        availableModelProviders[0];
      if (provider) {
        setSelectedProviderId(provider.id);
        const matchingConnected =
          connectedProvider?.id === provider.id
            ? connectedProvider
            : connectedModelProviders.find((entry) => entry.id === provider.id) ?? null;
        setBaseUrl(matchingConnected?.api_base ?? provider.default_base_url);
        setStep(matchingConnected ? "connected" : requestedProvider ? "configure" : "catalog");
      }
      setConnectedProviders(connectedModelProviders);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const connect = async () => {
    if (!selectedProvider || !apiKey.trim() || !baseUrl.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const data = await saveProvider({
        providerId: selectedProvider.id,
        apiKey,
        apiBase: baseUrl,
      });
      const connected = data.connected_providers.find(
        (provider) => provider.id === selectedProvider.id,
      );
      setConnectedProviders(data.connected_providers);
      setApiKey("");
      setStep(connected ? "connected" : "catalog");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (providerId: string) => {
    const provider = availableProviders.find((entry) => entry.id === providerId);
    setSaving(true);
    setError(null);
    try {
      await deleteProvider(providerId);
      setConnectedProviders((providers) =>
        providers.filter((connectedProvider) => connectedProvider.id !== providerId),
      );
      if (selectedProviderId === providerId) {
        setApiKey("");
        setBaseUrl(provider?.default_base_url ?? "");
        setStep("catalog");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect provider");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">LLM Providers</h2>
        <p className="text-sm text-muted-foreground">
          Connect provider credentials before assigning models to agents.
        </p>
        {loading && <p className="text-xs text-muted-foreground">Loading providers…</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {connectedProviders.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-[13.5px] font-semibold tracking-tight">Connected LLM providers</h3>
          <Card className="grid min-w-0 gap-3 p-4">
            {connectedProviders.map((provider) => (
              <div
                key={provider.id}
                className="flex min-w-0 flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderLogo providerId={provider.id} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{provider.name}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        API key
                      </Badge>
                      <Badge variant="outline" className="max-w-full truncate text-[10px]">
                        {provider.api_base}
                      </Badge>
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {provider.masked_api_key}
                    </p>
                  </div>
                </div>
                <Button
                  className="self-end sm:self-auto"
                  variant="outline"
                  size="sm"
                  onClick={() => disconnect(provider.id)}
                  disabled={saving}
                >
                  <X className="size-3.5" />
                  Disconnect
                </Button>
              </div>
            ))}
          </Card>
        </section>
      )}

      <section className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[13.5px] font-semibold tracking-tight">Available LLM providers</h3>
          <Badge variant="outline" className="text-[10px]">
            Model routing
          </Badge>
        </div>
        <Card className="min-w-0 overflow-hidden p-0">
          {availableProviders.map((provider) => {
            const connectedProvider = connectedProviders.find(
              (connected) => connected.id === provider.id,
            );
            return (
              <button
                key={provider.id}
                type="button"
                className="flex w-full min-w-0 flex-col items-start gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                onClick={() => {
                  setSelectedProviderId(provider.id);
                  setBaseUrl(connectedProvider?.api_base ?? provider.default_base_url);
                  setStep(connectedProvider ? "connected" : "configure");
                }}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderLogo providerId={provider.id} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{provider.name}</span>
                      <Badge
                        variant={connectedProvider ? "secondary" : "outline"}
                        className="text-[10px]"
                      >
                        {connectedProvider ? "Connected" : "Available"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{provider.description}</p>
                  </div>
                </div>
                <span className="inline-flex h-7 shrink-0 items-center justify-center gap-1 self-end rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium shadow-sm sm:self-auto">
                  <Plus className="size-3.5" />
                  {connectedProvider ? "Manage" : "Connect"}
                </span>
              </button>
            );
          })}
        </Card>
      </section>

      {step !== "catalog" && selectedProvider && (
        <section className="grid gap-2">
          <h3 className="text-[13.5px] font-semibold tracking-tight">{selectedConnectedProvider ? "Provider details" : `Connect ${selectedProvider.name}`}</h3>
          <Card className="min-w-0 p-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="grid min-w-0 gap-4">
                <div className="flex items-center gap-3">
                  <ProviderLogo providerId={selectedProvider.id} large />
                  <div className="min-w-0">
                    <div className="font-medium">{selectedProvider.name}</div>
                    <p className="text-sm text-muted-foreground">
                      Add your provider API key and base URL.
                    </p>
                  </div>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="provider-key">{selectedProvider.name} API key</Label>
                  <div className="relative">
                    <KeyRound className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="provider-key"
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="Provider API key"
                      className="pl-8 font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="provider-base-url">{selectedProvider.name} base URL</Label>
                  <Input
                    id="provider-base-url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder={selectedProvider.default_base_url}
                    className="font-mono text-xs"
                  />
                </div>
              </div>

              <div className="min-w-0 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Bot className="size-4" />
                  Model routing
                </div>
                <div className="mt-3 space-y-3 text-xs text-muted-foreground">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-border pb-2">
                    <span>Provider</span>
                    <span className="truncate text-right text-foreground">{selectedProvider.name}</span>
                  </div>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-border pb-2">
                    <span>Models</span>
                    <span className="truncate text-right font-mono text-foreground">
                      {`${selectedProvider.id}/*`}
                    </span>
                  </div>
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                    <span>Status</span>
                    <span className="inline-flex min-w-0 items-center justify-end gap-1 text-foreground">
                      {connected && <Check className="size-3" />}
                      {connected ? "Connected" : "Ready"}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep("catalog")}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={connect}
                disabled={saving || !selectedProvider || !apiKey.trim() || !baseUrl.trim()}
              >
                <Check className="size-3.5" />
                {saving ? "Saving…" : "Save provider"}
              </Button>
            </div>
          </Card>
        </section>
      )}
    </>
  );
}

function ProviderLogo({ providerId, large = false }: { providerId: string; large?: boolean }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-sm ${
        large ? "size-11" : "size-9"
      }`}
    >
      <BrandIcon id={providerId} className={large ? "size-7" : "size-5"} />
    </span>
  );
}

function providerIdFromLocation() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("provider") ?? "";
}

function isModelProvider(provider: { category?: string }) {
  return provider.category !== "runtime";
}
