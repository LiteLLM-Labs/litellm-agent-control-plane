"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { ArrowLeft, Check, Clipboard } from "lucide-react";
import { BrandIcon } from "@/components/brand-icons";
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
import { cn } from "@/lib/utils";
import { savePersonalVaultKey, updateAgent } from "@/lib/api";
import type { Agent } from "@/lib/types";

const GOOGLE_CHAT_VAULT_USER = "default";

export interface GoogleChatConfig {
  app_name?: string;
  status?: string;
  auth_audience?: string;
  service_account_json_key?: string;
}

function originForGoogleChat() {
  if (typeof window === "undefined") return "http://localhost:3210";
  return window.location.origin;
}

function endpointFor(agentId: string) {
  return `${originForGoogleChat()}/api/agents/${encodeURIComponent(agentId)}/google-chat/events`;
}

export function googleChatConfig(ag: Agent | null): GoogleChatConfig {
  const config = (ag?.config ?? {}) as { google_chat?: GoogleChatConfig };
  return config.google_chat ?? {};
}

export function googleChatActionLabel(config: GoogleChatConfig) {
  if (config.status === "connected") return "Google Chat ready";
  return "Add to Google Chat";
}

export function googleChatActionClass(config: GoogleChatConfig) {
  if (config.status === "connected")
    return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300";
  return "";
}

export function useGoogleChatAppFlow(setAgents: Dispatch<SetStateAction<Agent[] | null>>) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [appName, setAppName] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openGoogleChat = (ag: Agent) => {
    const existing = googleChatConfig(ag);
    setAgent(ag);
    setAppName(existing.app_name || ag.name || "Lite Agent");
    setServiceAccountJson("");
    setStep(existing.status === "connected" ? 2 : 1);
    setError(null);
    setOpen(true);
  };

  const saveConfig = async () => {
    if (!agent) return;
    setSaving(true);
    setError(null);
    try {
      if (!serviceAccountJson.trim()) throw new Error("Service account JSON is required");
      const endpoint = endpointFor(agent.id);
      const serviceAccountJsonKey = `GOOGLE_CHAT_${agent.id}_SERVICE_ACCOUNT_JSON`;
      await savePersonalVaultKey(
        GOOGLE_CHAT_VAULT_USER,
        serviceAccountJsonKey,
        serviceAccountJson.trim(),
      );
      const currentConfig = ((agent.config ?? {}) as Record<string, unknown>) || {};
      const updated = await updateAgent(agent.id, {
        config: {
          ...currentConfig,
          google_chat: {
            app_name: appName.trim(),
            status: "connected",
            auth_audience: endpoint,
            service_account_json_key: serviceAccountJsonKey,
          },
        },
      });
      setAgent(updated);
      setAgents((prev) => prev?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
      setServiceAccountJson("");
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const copyEndpoint = async () => {
    if (!agent) return;
    try {
      await navigator.clipboard.writeText(endpointFor(agent.id));
    } catch {
      setError("Could not copy the endpoint. Select and copy it from the field instead.");
    }
  };

  const copyAudience = async () => {
    if (!agent) return;
    try {
      await navigator.clipboard.writeText(endpointFor(agent.id));
    } catch {
      setError("Could not copy the audience. Select and copy it from the field instead.");
    }
  };

  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-[960px]">
        <div className="grid min-h-[560px] grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="border-b border-border bg-muted/30 p-7 md:border-b-0 md:border-r">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-lg border border-border bg-background">
                <BrandIcon id="google_chat" className="size-6" />
              </div>
              <div>
                <DialogTitle className="text-xl font-semibold tracking-tight">Add Google Chat App</DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">Custom app for one agent</p>
              </div>
            </div>

            <div className="mt-8 grid gap-3">
              {[
                ["1", "Configure app", "Add service account and endpoint"],
                ["2", "Connected", "Agent ready to receive messages"],
              ].map(([n, title, detail]) => {
                const active = step === Number(n);
                const done = step > Number(n);
                return (
                  <div
                    key={n}
                    className={cn(
                      "grid grid-cols-[32px_1fr] gap-3 rounded-lg border px-3 py-3",
                      active ? "border-foreground bg-background" : "border-transparent",
                    )}
                  >
                    <div
                      className={cn(
                        "flex size-8 items-center justify-center rounded-full border text-sm font-medium",
                        active || done
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-muted-foreground",
                      )}
                    >
                      {done ? <Check className="size-4" /> : n}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{title}</p>
                      <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <DialogHeader className="border-b border-border px-7 py-6">
              <p className="text-sm leading-6 text-muted-foreground">
                Create a Google Chat app in your Google Cloud Console, point it at this endpoint, and paste your service account credentials here.
              </p>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
              {step === 1 && agent && (
                <div className="grid gap-5">
                  <div className="grid gap-1.5">
                    <Label htmlFor="gchat-app-name">App name</Label>
                    <Input
                      id="gchat-app-name"
                      value={appName}
                      onChange={(e) => setAppName(e.target.value)}
                      placeholder={agent.name || "Lite Agent"}
                      className="h-10 text-base"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="gchat-endpoint">Event endpoint</Label>
                    <div className="flex gap-2">
                      <Input
                        id="gchat-endpoint"
                        value={endpointFor(agent.id)}
                        readOnly
                        className="font-mono text-xs"
                      />
                      <Button type="button" variant="outline" size="icon" onClick={copyEndpoint} aria-label="Copy Google Chat endpoint">
                        <Clipboard className="size-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Use this URL as the App URL in Google Cloud Console.
                    </p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="gchat-audience">Auth audience</Label>
                    <div className="flex gap-2">
                      <Input
                        id="gchat-audience"
                        value={endpointFor(agent.id)}
                        readOnly
                        className="font-mono text-xs"
                      />
                      <Button type="button" variant="outline" size="icon" onClick={copyAudience} aria-label="Copy auth audience">
                        <Clipboard className="size-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Set this as the audience in Google Cloud Console.
                    </p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="gchat-service-account">Service Account JSON</Label>
                    <textarea
                      id="gchat-service-account"
                      value={serviceAccountJson}
                      onChange={(e) => setServiceAccountJson(e.target.value)}
                      placeholder="Paste service account JSON key here"
                      rows={6}
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
                    />
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}

              {step === 2 && agent && (
                <div className="grid gap-6">
                  <div className="grid gap-1">
                    <h3 className="text-base font-semibold tracking-tight">Agent connected</h3>
                    <p className="text-sm leading-6 text-muted-foreground">
                      In Google Cloud Console, create a Chat app with this endpoint URL as the App URL, and set the auth audience to the same URL.
                    </p>
                  </div>
                  <div className="grid gap-4 rounded-lg border border-border bg-muted/20 p-5">
                    <div className="grid gap-1">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Event endpoint</p>
                      <p className="break-all font-mono text-xs">{endpointFor(agent.id)}</p>
                    </div>
                    <div className="grid gap-1">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Auth audience</p>
                      <p className="break-all font-mono text-xs">{endpointFor(agent.id)}</p>
                    </div>
                    <div className="grid gap-1">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Status</p>
                      <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">Connected</p>
                    </div>
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}
            </div>

            <DialogFooter className="m-0 border-t bg-background px-7 py-4">
              {step === 1 && (
                <Button onClick={saveConfig} disabled={saving}>
                  {saving ? "Saving…" : "Save Configuration"}
                </Button>
              )}
              {step === 2 && (
                <>
                  <Button variant="outline" onClick={() => setStep(1)} disabled={saving}>
                    <ArrowLeft className="size-3.5" />
                    Update credentials
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { dialog, openGoogleChat };
}
