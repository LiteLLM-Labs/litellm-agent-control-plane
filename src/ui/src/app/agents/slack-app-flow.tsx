"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { ArrowLeft, Check, ExternalLink, Info } from "lucide-react";
import { BrandIcon } from "@/components/brand-icons";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { createSlackOAuthState, saveIntegrationKey, updateAgent } from "@/lib/api";
import type { Agent } from "@/lib/types";

const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "team:read",
  "users:read",
  "app_mentions:read",
  "users:read.email",
  "reactions:write",
  "metadata.message:read",
];

export interface SlackConfig {
  app_name?: string;
  app_id?: string;
  client_id?: string;
  provider_id?: string;
  status?: string;
  app_config_token_key?: string;
  client_secret_key?: string;
  signing_secret_key?: string;
  bot_token_key?: string;
  slack_team_name?: string;
  bot_user_id?: string;
  oauth_error?: string | null;
}

interface SlackCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

function providerIdFor(agentId: string) {
  return agentId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function originForSlack() {
  if (typeof window === "undefined") return "http://localhost:3210";
  return window.location.origin;
}

export function slackConfig(ag: Agent | null): SlackConfig {
  const config = (ag?.config ?? {}) as { slack?: SlackConfig };
  return config.slack ?? {};
}

export function slackActionLabel(config: SlackConfig) {
  if (config.status === "connected") return "Slack connected";
  if (config.status === "oauth_failed") return "Slack failed";
  if (config.status === "approval_requested") return "Slack pending";
  if (config.status === "credentials_saved" || config.app_id || config.client_id || config.provider_id) return "Finish Slack";
  return "Connect to Slack";
}

export function slackActionClass(config: SlackConfig) {
  if (config.status === "connected") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300";
  if (config.status === "oauth_failed") return "border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/15";
  if (config.status === "approval_requested") return "border-amber-500/35 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300";
  return "";
}

function buildSlackManifest(ag: Agent, appName: string) {
  const origin = originForSlack();
  const providerId = providerIdFor(ag.id);
  return {
    display_information: {
      name: appName,
      description: "Enables Lite Agents to interact with your workspace",
      background_color: "#000000",
      long_description:
        "Lite Agents is a lightweight platform for building useful AI agents. Lite Agents has integrations with API services, including Slack. When connected to your Slack workspace, Lite Agents can power automations including summarizing and responding to messages.\n\nThis app uses large language models (LLMs) and may occasionally generate inaccurate, outdated, or incomplete responses. Always verify important information and avoid sharing sensitive data in prompts.",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: appName,
        always_online: false,
      },
    },
    oauth_config: {
      redirect_urls: [`${origin}/host-oauth-callback/${providerId}`],
      scopes: { bot: SLACK_BOT_SCOPES },
    },
    settings: {
      event_subscriptions: {
        request_url: `${origin}/api/agents/${encodeURIComponent(ag.id)}/slack/events`,
        bot_events: [
          "app_mention",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
        ],
      },
      interactivity: {
        is_enabled: true,
        request_url: `${origin}/api/agents/${encodeURIComponent(ag.id)}/slack/interactivity`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

function slackManifestUrl(ag: Agent, appName: string) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
    JSON.stringify(buildSlackManifest(ag, appName), null, 2),
  )}`;
}

function slackAuthorizeUrl(ag: Agent, clientId: string, state: string) {
  const origin = originForSlack();
  const providerId = providerIdFor(ag.id);
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_BOT_SCOPES.join(","),
    redirect_uri: `${origin}/host-oauth-callback/${providerId}`,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export function useSlackAppFlow(setAgents: Dispatch<SetStateAction<Agent[] | null>>) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState(false);
  const [credentials, setCredentials] = useState<SlackCredentials>({
    appId: "",
    clientId: "",
    clientSecret: "",
    signingSecret: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openSlack = (ag: Agent) => {
    const existing = slackConfig(ag);
    setAgent(ag);
    setName(existing.app_name || ag.name || "Lite Agent");
    setCredentials({
      appId: existing.app_id || "",
      clientId: existing.client_id || "",
      clientSecret: "",
      signingSecret: "",
    });
    setCreated(Boolean(existing.app_id || existing.client_id));
    setStep(existing.client_id ? 3 : existing.app_id ? 2 : 1);
    setError(null);
    setOpen(true);
  };

  const saveCredentials = async () => {
    if (!agent) return;
    setSaving(true);
    setError(null);
    try {
      if (!credentials.appId.trim()) throw new Error("App ID is required");
      if (!credentials.clientId.trim()) throw new Error("Client ID is required");
      if (!credentials.clientSecret.trim()) throw new Error("Client Secret is required");
      if (!credentials.signingSecret.trim()) throw new Error("Signing Secret is required");

      const clientSecretKey = `SLACK_${agent.id}_CLIENT_SECRET`;
      const signingSecretKey = `SLACK_${agent.id}_SIGNING_SECRET`;
      await saveIntegrationKey(clientSecretKey, credentials.clientSecret.trim());
      await saveIntegrationKey(signingSecretKey, credentials.signingSecret.trim());
      const currentConfig = ((agent.config ?? {}) as Record<string, unknown>) || {};
      const updated = await updateAgent(agent.id, {
        config: {
          ...currentConfig,
          slack: {
            app_name: name.trim(),
            app_id: credentials.appId.trim(),
            client_id: credentials.clientId.trim(),
            provider_id: providerIdFor(agent.id),
            status: "credentials_saved",
            client_secret_key: clientSecretKey,
            signing_secret_key: signingSecretKey,
          },
        },
      });
      setAgent(updated);
      setAgents((prev) => prev?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
      setCredentials((c) => ({ ...c, clientSecret: "", signingSecret: "" }));
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const markApprovalRequested = async () => {
    if (!agent) return;
    setSaving(true);
    setError(null);
    try {
      const currentConfig = ((agent.config ?? {}) as Record<string, unknown>) || {};
      const existing = slackConfig(agent);
      const updated = await updateAgent(agent.id, {
        config: {
          ...currentConfig,
          slack: { ...existing, status: "approval_requested" },
        },
      });
      setAgent(updated);
      setAgents((prev) => prev?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const connectOAuth = async () => {
    if (!agent) return;
    const clientId = slackConfig(agent).client_id || credentials.clientId;
    if (!clientId.trim()) {
      setError("Client ID is required");
      return;
    }
    setSaving(true);
    setError(null);
    const popup = window.open("about:blank", "_blank", "noopener,noreferrer");
    try {
      const state = await createSlackOAuthState(agent.id);
      const url = slackAuthorizeUrl(agent, clientId, state);
      if (popup) popup.location.href = url;
      else window.location.href = url;
    } catch (e) {
      popup?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-[1040px]">
        <div className="grid min-h-[620px] grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
          <div className="border-b border-border bg-muted/30 p-7 md:border-b-0 md:border-r">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-lg border border-border bg-background">
                <BrandIcon id="slack" className="size-6" />
              </div>
              <div>
                <DialogTitle className="text-xl">Add Slack App</DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">Custom app for one agent</p>
              </div>
            </div>

            <div className="mt-8 grid gap-3">
              {[
                ["1", "Create app", "Prefill Slack's manifest"],
                ["2", "Save credentials", "Store IDs and secrets"],
                ["3", "Connect OAuth", "Install into workspace"],
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
                Create a dedicated Slackbot app that responds to mentions and direct messages through this agent.
              </p>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
              {step === 1 && agent && (
                <div className="grid gap-6">
                  <div className="grid gap-1.5">
                    <Label htmlFor="slack-app-name">Slack app name</Label>
                    <Input
                      id="slack-app-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={agent.name || "Lite Agent"}
                      className="h-10 text-base"
                    />
                  </div>
                  <div className="grid gap-4 rounded-lg border border-border bg-muted/20 p-5">
                    <div>
                      <h3 className="text-base font-semibold">Create the Slack app</h3>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">
                        The button opens Slack with the Lite Agents manifest already filled in.
                      </p>
                    </div>
                    <ol className="grid gap-3 text-sm text-muted-foreground">
                      <li className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium text-foreground ring-1 ring-border">1</span>
                        <span>Choose your workspace in Slack and continue.</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium text-foreground ring-1 ring-border">2</span>
                        <span>Review the pre-filled manifest and create the app.</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-xs font-medium text-foreground ring-1 ring-border">3</span>
                        <span>Return here to paste the credentials from Slack's Basic Information page.</span>
                      </li>
                    </ol>
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}

              {step === 2 && (
                <div className="grid gap-5">
                  <div className="grid gap-1">
                    <h3 className="text-base font-semibold">Paste Slack app credentials</h3>
                    <p className="text-sm leading-6 text-muted-foreground">
                      Secrets are stored in the vault. Only the key names are saved on the agent.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="slack-app-id">App ID</Label>
                      <Input
                        id="slack-app-id"
                        value={credentials.appId}
                        onChange={(e) => setCredentials((c) => ({ ...c, appId: e.target.value }))}
                        placeholder="A0123456789"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="slack-client-id">Client ID</Label>
                      <Input
                        id="slack-client-id"
                        value={credentials.clientId}
                        onChange={(e) => setCredentials((c) => ({ ...c, clientId: e.target.value }))}
                        placeholder="1234567890.1234567890"
                      />
                    </div>
                  </div>
                  <div className="grid gap-4">
                    <div className="grid gap-1.5">
                      <Label htmlFor="slack-client-secret">Client Secret</Label>
                      <Input
                        id="slack-client-secret"
                        type="password"
                        value={credentials.clientSecret}
                        onChange={(e) => setCredentials((c) => ({ ...c, clientSecret: e.target.value }))}
                        placeholder="************"
                      />
                      <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30">
                        <Info className="size-3.5" />
                        Click "Show" in Slack and copy the whole secret.
                      </div>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="slack-signing-secret">Signing Secret</Label>
                      <Input
                        id="slack-signing-secret"
                        type="password"
                        value={credentials.signingSecret}
                        onChange={(e) => setCredentials((c) => ({ ...c, signingSecret: e.target.value }))}
                        placeholder="************"
                      />
                      <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30">
                        <Info className="size-3.5" />
                        Click "Show" in Slack and copy the whole secret.
                      </div>
                    </div>
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}

              {step === 3 && agent && (
                <div className="grid gap-6">
                  <div className="grid gap-1">
                    <h3 className="text-base font-semibold">Connect OAuth</h3>
                    <p className="text-sm leading-6 text-muted-foreground">
                      Slack redirects back to Lite Agents after OAuth. A successful callback stores the bot token in the vault.
                    </p>
                  </div>
                  <div className="grid gap-4 rounded-lg border border-border bg-muted/20 p-5">
                    <div className="grid gap-1">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Provider ID</p>
                      <p className="font-mono text-sm">{providerIdFor(agent.id)}</p>
                    </div>
                    <div className="grid gap-1">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Status</p>
                      <p className="text-sm font-medium">
                        {slackConfig(agent).status === "connected"
                          ? "Connected"
                          : slackConfig(agent).status === "approval_requested"
                            ? "Approval requested"
                            : slackConfig(agent).status === "oauth_failed"
                              ? "OAuth failed"
                              : "Not connected"}
                      </p>
                    </div>
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}
            </div>

            <DialogFooter className="m-0 border-t bg-background px-7 py-4">
              {step === 1 && agent && (
                <>
                  <a
                    className={cn(
                      buttonVariants({ variant: "default" }),
                      !name.trim() && "pointer-events-none opacity-50",
                    )}
                    href={agent && name.trim() ? slackManifestUrl(agent, name.trim()) : "#"}
                    target="_blank"
                    rel="noreferrer"
                    aria-disabled={!name.trim()}
                    onClick={() => setCreated(true)}
                  >
                    <BrandIcon id="slack" className="size-4" />
                    Create Slack App
                    <ExternalLink className="size-3.5" />
                  </a>
                  <Button variant="outline" onClick={() => setStep(2)} disabled={!created}>
                    Continue to Credentials
                  </Button>
                </>
              )}
              {step === 2 && (
                <>
                  <Button variant="outline" onClick={() => setStep(1)} disabled={saving}>
                    <ArrowLeft className="size-3.5" />
                    Back
                  </Button>
                  <Button onClick={saveCredentials} disabled={saving}>
                    {saving ? "Saving..." : "Save Credentials"}
                  </Button>
                </>
              )}
              {step === 3 && agent && (
                <>
                  <Button variant="outline" onClick={() => setStep(2)} disabled={saving}>
                    <ArrowLeft className="size-3.5" />
                    Back
                  </Button>
                  <Button variant="outline" onClick={markApprovalRequested} disabled={saving}>
                    <Check className="size-3.5" />
                    Save & Request Approval
                  </Button>
                  <Button onClick={connectOAuth} disabled={saving}>
                    Connect OAuth
                    <ExternalLink className="size-3.5" />
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { dialog, openSlack };
}
