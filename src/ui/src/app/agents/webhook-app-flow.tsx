"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { Check, Clipboard, Info, Webhook } from "lucide-react";

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
import { savePersonalVaultKey, updateAgent } from "@/lib/api";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";

const WEBHOOK_VAULT_USER = "default";

export interface WebhookConfig {
  status?: string;
  secret_key?: string;
  prompt_json_pointer?: string;
  title_json_pointer?: string;
}

interface WebhookForm {
  secret: string;
  secretKey: string;
  promptPointer: string;
  titlePointer: string;
}

function originForWebhook() {
  if (typeof window === "undefined") return "http://localhost:3210";
  return window.location.origin;
}

function endpointFor(agentId: string) {
  return `${originForWebhook()}/api/agents/${encodeURIComponent(agentId)}/webhook`;
}

function defaultSecretKey(agentId: string) {
  return `WEBHOOK_${agentId}_SECRET`;
}

export function webhookConfig(ag: Agent | null): WebhookConfig {
  const config = (ag?.config ?? {}) as { webhook?: WebhookConfig };
  return config.webhook ?? {};
}

export function webhookActionLabel(config: WebhookConfig) {
  if (config.status === "configured" || config.secret_key) return "Webhook ready";
  return "Add webhook";
}

export function webhookActionClass(config: WebhookConfig) {
  if (config.status === "configured" || config.secret_key) {
    return "border-cyan-500/35 bg-cyan-500/10 text-cyan-700 hover:bg-cyan-500/15 dark:text-cyan-300";
  }
  return "";
}

export function useWebhookAppFlow(setAgents: Dispatch<SetStateAction<Agent[] | null>>) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [form, setForm] = useState<WebhookForm>({
    secret: "",
    secretKey: "",
    promptPointer: "/ticket/description",
    titlePointer: "/ticket/id",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"endpoint" | "header" | null>(null);

  const openWebhook = (ag: Agent) => {
    const existing = webhookConfig(ag);
    setAgent(ag);
    setForm({
      secret: "",
      secretKey: existing.secret_key || defaultSecretKey(ag.id),
      promptPointer: existing.prompt_json_pointer || "/ticket/description",
      titlePointer: existing.title_json_pointer || "/ticket/id",
    });
    setError(null);
    setCopied(null);
    setOpen(true);
  };

  const copyText = async (kind: "endpoint" | "header", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setError("Could not copy. Select and copy the value from the field instead.");
    }
  };

  const saveWebhook = async () => {
    if (!agent) return;
    const secretKey = form.secretKey.trim() || defaultSecretKey(agent.id);
    setSaving(true);
    setError(null);
    try {
      if (form.secret.trim()) {
        await savePersonalVaultKey(WEBHOOK_VAULT_USER, secretKey, form.secret.trim());
      }
      const currentConfig = ((agent.config ?? {}) as Record<string, unknown>) || {};
      const updated = await updateAgent(agent.id, {
        config: {
          ...currentConfig,
          webhook: {
            status: "configured",
            secret_key: secretKey,
            prompt_json_pointer: form.promptPointer.trim() || undefined,
            title_json_pointer: form.titlePointer.trim() || undefined,
          },
        },
      });
      setAgent(updated);
      setAgents((prev) => prev?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
      setForm((current) => ({ ...current, secret: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const endpoint = agent ? endpointFor(agent.id) : "";
  const authExample = "Authorization: Bearer <webhook-token>";
  const configured = agent ? webhookConfig(agent).status === "configured" : false;

  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-[900px]">
        <div className="grid min-h-[520px] grid-cols-1 md:grid-cols-[250px_minmax(0,1fr)]">
          <div className="border-b border-border bg-muted/30 p-7 md:border-b-0 md:border-r">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-lg border border-border bg-background">
                <Webhook className="size-5 text-cyan-600 dark:text-cyan-300" />
              </div>
              <div>
                <DialogTitle className="text-xl font-semibold tracking-tight">Webhook</DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">Inbound HTTP trigger</p>
              </div>
            </div>

            <div className="mt-8 grid gap-3">
              {[
                ["1", "Endpoint", "Use the agent URL"],
                ["2", "Token", "Store bearer token"],
                ["3", "Payload", "Choose prompt fields"],
              ].map(([n, title, detail]) => (
                <div
                  key={n}
                  className="grid grid-cols-[32px_1fr] gap-3 rounded-lg border border-transparent px-3 py-3"
                >
                  <div
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full border text-sm font-medium",
                      configured
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground",
                    )}
                  >
                    {configured ? <Check className="size-4" /> : n}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{title}</p>
                    <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <DialogHeader className="border-b border-border px-7 py-6">
              <p className="text-sm leading-6 text-muted-foreground">
                Point Zendesk or any webhook sender at this endpoint. The sender authenticates with a bearer token, and the payload becomes a user message in a managed-agent session.
              </p>
            </DialogHeader>

            {agent && (
              <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
                <div className="grid gap-5">
                  <div className="grid gap-1.5">
                    <Label htmlFor="webhook-endpoint">Endpoint</Label>
                    <div className="flex gap-2">
                      <Input
                        id="webhook-endpoint"
                        value={endpoint}
                        readOnly
                        className="font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => copyText("endpoint", endpoint)}
                        aria-label="Copy webhook endpoint"
                      >
                        <Clipboard className="size-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="webhook-secret-key">Vault key</Label>
                    <Input
                      id="webhook-secret-key"
                      value={form.secretKey}
                      onChange={(e) => setForm((f) => ({ ...f, secretKey: e.target.value }))}
                      className="font-mono text-xs"
                    />
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="webhook-secret">Bearer token</Label>
                    <Input
                      id="webhook-secret"
                      type="password"
                      autoComplete="new-password"
                      value={form.secret}
                      onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                      placeholder={configured ? "Leave blank to keep the current token" : "Paste webhook token"}
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="webhook-prompt-pointer">Prompt JSON pointer</Label>
                      <Input
                        id="webhook-prompt-pointer"
                        value={form.promptPointer}
                        onChange={(e) => setForm((f) => ({ ...f, promptPointer: e.target.value }))}
                        placeholder="/ticket/description"
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="webhook-title-pointer">Title JSON pointer</Label>
                      <Input
                        id="webhook-title-pointer"
                        value={form.titlePointer}
                        onChange={(e) => setForm((f) => ({ ...f, titlePointer: e.target.value }))}
                        placeholder="/ticket/id"
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid gap-2 rounded-lg border border-border bg-muted/20 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Sender auth header</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => copyText("header", authExample)}
                      >
                        <Clipboard className="size-3.5" />
                        Copy
                      </Button>
                    </div>
                    <p className="break-all font-mono text-xs">{authExample}</p>
                  </div>

                  {(copied || error) && (
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
                        error
                          ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                      )}
                    >
                      <Info className="size-3.5" />
                      {error || (copied === "endpoint" ? "Endpoint copied" : "Header copied")}
                    </div>
                  )}
                </div>
              </div>
            )}

            <DialogFooter className="m-0 border-t bg-background px-7 py-4">
              <Button onClick={saveWebhook} disabled={saving || !agent}>
                {saving ? "Saving…" : "Save Webhook"}
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { dialog, openWebhook };
}
