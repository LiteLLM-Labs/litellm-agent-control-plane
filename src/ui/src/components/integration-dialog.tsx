"use client";

import { useState, useEffect } from "react";
import { Eye, EyeOff, Info, Check, Loader2, Unplug, Zap, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { BrandIcon } from "@/components/brand-icons";
import {
  deleteMcpUserCredential,
  listMcpServerTools,
  storeMcpUserCredential,
  storeMcpVarCredential,
  testMcpServerTools,
} from "@/lib/api";
import type { McpServer } from "@/lib/types";

interface McpVariable {
  name: string;
  scope: string;
  description?: string;
}

export function IntegrationDialog({
  server,
  open,
  connected,
  onOpenChange,
  onChange,
}: {
  server: McpServer | null;
  open: boolean;
  connected: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  // Per-variable values: { [varName]: value }
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; tools: string[]; count: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [discoveredTools, setDiscoveredTools] = useState<string[]>([]);

  // Auto-fetch tools when dialog opens
  useEffect(() => {
    if (!open || !server) return;
    setDiscoveredTools([]);
    fetch(`/v1/mcp/server/${encodeURIComponent(server.server_id)}/tools`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((data: { tools?: { name?: string }[] } | null) => {
        if (data?.tools) {
          setDiscoveredTools(data.tools.map((t) => t.name ?? "").filter(Boolean));
        }
      })
      .catch(() => {});
  }, [open, server]);

  if (!server) return null;

  const displayName = server.server_name ?? server.alias ?? server.server_id;
  const keyLabel = server.byok_description?.[0] ?? "API Key";
  const adminTools: string[] = server.allowed_tools ?? [];
  const tools = discoveredTools.length > 0 ? discoveredTools : adminTools;

  // Derive per-user variables from mcp_info.variables
  const allVars = (server.mcp_info as { variables?: McpVariable[] } | undefined)?.variables ?? [];
  const perUserVars: McpVariable[] = allVars.filter((v) => v.scope === "per_user");
  const hasPerUserVars = perUserVars.length > 0;
  const needsCredentials = hasPerUserVars || server.is_byok;

  const reset = () => {
    setApiKey("");
    setVarValues({});
    setReveal(false);
    setError(null);
    setTestResult(null);
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const variables: Record<string, string> = {};
      let hasEnteredVariable = false;
      for (const variable of perUserVars) {
        const value = varValues[variable.name]?.trim() ?? "";
        variables[variable.name] = value;
        if (value) hasEnteredVariable = true;
      }

      if (hasEnteredVariable) {
        const missing = perUserVars.filter((variable) => !variables[variable.name]);
        if (missing.length > 0) {
          setError(`Please fill in all required fields: ${missing.map((v) => v.name).join(", ")}`);
          return;
        }
      }

      const rawTools = hasEnteredVariable
        ? await testMcpServerTools(server.server_id, variables)
        : await listMcpServerTools(server.server_id);
      const tools = rawTools.map((t) => t.name ?? "").filter(Boolean);
      setTestResult({ ok: true, tools: tools.slice(0, 8), count: tools.length });
    } catch {
      setTestResult({ ok: false, tools: [], count: 0 });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (hasPerUserVars) {
        // Require all per-user variables to be filled before saving.
        const missing = perUserVars.filter((v) => !varValues[v.name]?.trim());
        if (missing.length > 0) {
          setError(`Please fill in all required fields: ${missing.map((v) => v.name).join(", ")}`);
          return;
        }
        // Store each per-user variable separately in the vault.
        await Promise.all(
          perUserVars.map((v) =>
            storeMcpVarCredential(server.server_id, v.name, varValues[v.name].trim()),
          ),
        );
      } else {
        // Legacy: single API key credential.
        if (!apiKey.trim()) return;
        await storeMcpUserCredential(server.server_id, apiKey.trim());
      }
      onChange();
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDisconnect = async () => {
    setSaving(true);
    setError(null);
    try {
      await deleteMcpUserCredential(server.server_id);
      onChange();
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <div className="flex items-start gap-3 pr-6">
          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
            <BrandIcon id={server.server_id} className="size-6" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-medium leading-none">{displayName}</h2>
              {connected && (
                <Badge variant="secondary" className="gap-1">
                  <Check className="size-3" />
                  Connected
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {server.description ?? ""}
            </p>
          </div>
        </div>

        {tools.length > 0 && (
          <div>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Available tools ({tools.length})
            </div>
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
              {tools.map((t) => (
                <Badge key={t} variant="outline" className="font-mono">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onTest()}
              disabled={testing}
              className="w-full"
            >
              {testing ? (
                <><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Testing connection…</>
              ) : (
                <><Zap className="size-3.5" /> Test connection</>
              )}
            </Button>
            {testResult && (
              <div className={`rounded-lg border p-3 text-sm ${testResult.ok ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>
                {testResult.ok ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 font-medium">
                      <Check className="size-4" />
                      Connected — {testResult.count} tool{testResult.count !== 1 ? "s" : ""} available
                    </div>
                    {testResult.tools.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {testResult.tools.map((t) => (
                          <Badge key={t} variant="outline" className="font-mono text-[10px]">{t}</Badge>
                        ))}
                        {testResult.count > 8 && <span className="text-xs text-muted-foreground">+{testResult.count - 8} more</span>}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <XCircle className="size-4" />
                    Connection failed — check the server URL and your API key
                  </div>
                )}
              </div>
            )}
          </div>

        {needsCredentials && (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              To use this service, please provide your {keyLabel} below.
              {server.byok_api_key_help_url && (
                <>
                  {" "}
                  <a
                    href={server.byok_api_key_help_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  >
                    Get your {keyLabel}
                  </a>
                </>
              )}
            </span>
          </div>
        )}

        {needsCredentials ? (
          <div className="space-y-2">
            {hasPerUserVars ? (
              // Per-variable inputs
              perUserVars.map((v) => (
                <div key={v.name} className="space-y-1">
                  <Label htmlFor={`int-var-${v.name}`} className="font-mono text-xs text-muted-foreground font-normal">
                    {v.name}
                    {v.description && (
                      <span className="ml-1 font-sans normal-case text-muted-foreground/70">
                        — {v.description}
                      </span>
                    )}
                  </Label>
                  <div className="relative">
                    <Input
                      id={`int-var-${v.name}`}
                      type={reveal ? "text" : "password"}
                      value={varValues[v.name] ?? ""}
                      onChange={(e) =>
                        setVarValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                      }
                      placeholder={`Enter ${v.name}…`}
                      className="h-10 pr-9 font-mono"
                      autoComplete="off"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void onSave();
                      }}
                    />
                  </div>
                </div>
              ))
            ) : (
              // Legacy single key input
              <>
                <Label htmlFor="int-legacy-key" className="font-mono text-xs text-muted-foreground font-normal">
                  {keyLabel}
                </Label>
                <div className="relative">
                  <Input
                    id="int-legacy-key"
                    type={reveal ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter API key..."
                    className="h-10 pr-9 font-mono"
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void onSave();
                    }}
                  />
                </div>
              </>
            )}

            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              aria-label={reveal ? "Hide values" : "Show values"}
            >
              {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {reveal ? "Hide" : "Show"} values
            </button>

            {error && <div className="text-xs text-destructive">{error}</div>}

            <Button
              onClick={() => void onSave()}
              disabled={
                saving ||
                (hasPerUserVars
                  ? perUserVars.every((v) => !(varValues[v.name]?.trim()))
                  : !apiKey.trim())
              }
              className="w-full"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                  Saving
                </>
              ) : connected ? (
                "Update credentials"
              ) : (
                "Save"
              )}
            </Button>

            {connected && (
              <Button
                variant="ghost"
                onClick={() => void onDisconnect()}
                disabled={saving}
                className="w-full text-destructive hover:text-destructive"
              >
                <Unplug className="size-4" />
                Disconnect
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No credentials required — this server is available to all agents automatically.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
