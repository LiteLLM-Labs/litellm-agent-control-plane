"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { ArrowLeft, Check, Clipboard, Download, Info } from "lucide-react";
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

const TEAMS_VAULT_USER = "default";
const TEAMS_SCHEMA =
  "https://developer.microsoft.com/json-schemas/teams/v1.22/MicrosoftTeams.schema.json";

export interface TeamsConfig {
  app_name?: string;
  app_id?: string;
  tenant_id?: string;
  status?: string;
  app_password_key?: string;
  oauth_error?: string | null;
}

interface TeamsCredentials {
  appId: string;
  appPassword: string;
  tenantId: string;
}

interface ZipFile {
  name: string;
  data: Uint8Array;
}

function originForTeams() {
  if (typeof window === "undefined") return "http://localhost:3210";
  return window.location.origin;
}

function endpointFor(agentId: string) {
  return `${originForTeams()}/api/agents/${encodeURIComponent(agentId)}/teams/messages`;
}

export function teamsConfig(ag: Agent | null): TeamsConfig {
  const config = (ag?.config ?? {}) as { teams?: TeamsConfig };
  return config.teams ?? {};
}

export function teamsActionLabel(config: TeamsConfig) {
  if (config.status === "package_ready") return "Teams ready";
  if (config.status === "oauth_failed") return "Teams failed";
  if (config.status === "credentials_saved" || config.app_id) return "Finish Teams";
  return "Add to Teams";
}

export function teamsActionClass(config: TeamsConfig) {
  if (config.status === "package_ready") return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300";
  if (config.status === "oauth_failed") return "border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/15";
  if (config.status === "credentials_saved") return "border-amber-500/35 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300";
  return "";
}

function packageName(agent: Agent, appName: string) {
  const base = (appName || agent.name || "lite-agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "lite-agent"}-teams.zip`;
}

function shortName(name: string) {
  return (name.trim() || "Lite Agent").slice(0, 30);
}

function fullName(name: string) {
  return (name.trim() || "Lite Agent").slice(0, 100);
}

function validDomain() {
  try {
    return new URL(originForTeams()).hostname;
  } catch {
    return "localhost";
  }
}

function buildTeamsManifest(agent: Agent, config: TeamsConfig, appName: string) {
  const appId = config.app_id?.trim();
  if (!appId) throw new Error("Microsoft App ID is required before downloading the package");
  const name = fullName(appName);
  return {
    $schema: TEAMS_SCHEMA,
    manifestVersion: "1.22",
    version: "1.0.0",
    id: appId,
    developer: {
      name: "Lite Agents",
      websiteUrl: originForTeams(),
      privacyUrl: originForTeams(),
      termsOfUseUrl: originForTeams(),
    },
    name: {
      short: shortName(name),
      full: name,
    },
    description: {
      short: "Run this Lite Agent from Microsoft Teams.",
      full: `${name} routes Microsoft Teams messages to the Lite Agents runtime and replies in the same conversation.`,
    },
    icons: {
      color: "color.png",
      outline: "outline.png",
    },
    accentColor: "#6264A7",
    bots: [
      {
        botId: appId,
        scopes: ["personal", "team", "groupChat"],
        supportsFiles: false,
        isNotificationOnly: false,
        commandLists: [
          {
            scopes: ["personal", "team", "groupChat"],
            commands: [
              {
                title: "help",
                description: "Ask what this agent can do.",
              },
            ],
          },
        ],
      },
    ],
    validDomains: [validDomain()],
  };
}

async function packageFiles(agent: Agent, config: TeamsConfig, appName: string): Promise<ZipFile[]> {
  const manifest = buildTeamsManifest(agent, config, appName);
  const encoder = new TextEncoder();
  return [
    {
      name: "manifest.json",
      data: encoder.encode(JSON.stringify(manifest, null, 2)),
    },
    { name: "color.png", data: await iconPng(192, false) },
    { name: "outline.png", data: await iconPng(32, true) },
  ];
}

async function iconPng(size: number, outline: boolean): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.clearRect(0, 0, size, size);
  const scale = size / 192;
  if (outline) {
    ctx.strokeStyle = "#6264A7";
    ctx.lineWidth = Math.max(2, 10 * scale);
    roundedRect(ctx, 24 * scale, 24 * scale, 144 * scale, 144 * scale, 28 * scale);
    ctx.stroke();
    ctx.fillStyle = "#6264A7";
  } else {
    ctx.fillStyle = "#6264A7";
    roundedRect(ctx, 0, 0, size, size, 28 * scale);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
  }
  ctx.font = `700 ${Math.round(86 * scale)}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("T", size / 2, size / 2 + 6 * scale);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error("Unable to render Teams icon"));
    }, "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = new Uint32Array(
  Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }),
);

function writeU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

function buildZip(files: ZipFile[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const file of files) {
    const name = encoder.encode(file.name);
    const checksum = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 10, time);
    writeU16(localView, 12, day);
    writeU32(localView, 14, checksum);
    writeU32(localView, 18, file.data.length);
    writeU32(localView, 22, file.data.length);
    writeU16(localView, 26, name.length);
    local.set(name, 30);
    localParts.push(local, file.data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 12, time);
    writeU16(centralView, 14, day);
    writeU32(centralView, 16, checksum);
    writeU32(centralView, 20, file.data.length);
    writeU32(centralView, 24, file.data.length);
    writeU16(centralView, 28, name.length);
    writeU32(centralView, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + file.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 8, files.length);
  writeU16(endView, 10, files.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, offset);

  return new Blob([...localParts, ...centralParts, end].map(blobPart), {
    type: "application/zip",
  });
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function useTeamsAppFlow(setAgents: Dispatch<SetStateAction<Agent[] | null>>) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState("");
  const [credentials, setCredentials] = useState<TeamsCredentials>({
    appId: "",
    appPassword: "",
    tenantId: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openTeams = (ag: Agent) => {
    const existing = teamsConfig(ag);
    setAgent(ag);
    setName(existing.app_name || ag.name || "Lite Agent");
    setCredentials({
      appId: existing.app_id || "",
      appPassword: "",
      tenantId: existing.tenant_id || "",
    });
    setStep(existing.app_id ? 2 : 1);
    setError(null);
    setOpen(true);
  };

  const saveCredentials = async () => {
    if (!agent) return;
    setSaving(true);
    setError(null);
    try {
      if (!credentials.appId.trim()) throw new Error("Microsoft App ID is required");
      if (!credentials.appPassword.trim()) throw new Error("App password is required");
      const appPasswordKey = `TEAMS_${agent.id}_APP_PASSWORD`;
      await savePersonalVaultKey(
        TEAMS_VAULT_USER,
        appPasswordKey,
        credentials.appPassword.trim(),
      );
      const currentConfig = ((agent.config ?? {}) as Record<string, unknown>) || {};
      const updated = await updateAgent(agent.id, {
        config: {
          ...currentConfig,
          teams: {
            app_name: name.trim(),
            app_id: credentials.appId.trim(),
            tenant_id: credentials.tenantId.trim() || undefined,
            status: "credentials_saved",
            app_password_key: appPasswordKey,
          },
        },
      });
      setAgent(updated);
      setAgents((prev) => prev?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
      setCredentials((c) => ({ ...c, appPassword: "" }));
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const downloadPackage = async () => {
    if (!agent) return;
    setSaving(true);
    setError(null);
    try {
      const config = teamsConfig(agent);
      const files = await packageFiles(agent, config, name);
      downloadBlob(buildZip(files), packageName(agent, name));
      const currentConfig = ((agent.config ?? {}) as Record<string, unknown>) || {};
      const updated = await updateAgent(agent.id, {
        config: {
          ...currentConfig,
          teams: { ...config, app_name: name.trim(), status: "package_ready" },
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

  const copyEndpoint = async () => {
    if (!agent) return;
    try {
      await navigator.clipboard.writeText(endpointFor(agent.id));
    } catch {
      setError("Could not copy the endpoint. Select and copy it from the field instead.");
    }
  };

  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-[960px]">
        <div className="grid min-h-[560px] grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)]">
          <div className="border-b border-border bg-muted/30 p-7 md:border-b-0 md:border-r">
            <div className="flex items-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-lg border border-border bg-background">
                <BrandIcon id="teams" className="size-6" />
              </div>
              <div>
                <DialogTitle className="text-xl font-semibold tracking-tight">Add Teams App</DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">Custom app for one agent</p>
              </div>
            </div>

            <div className="mt-8 grid gap-3">
              {[
                ["1", "Save bot", "Store Bot Framework credentials"],
                ["2", "Install app", "Download Teams app package"],
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
                Register an Azure Bot, point its messaging endpoint at this agent, then upload the generated app package in Microsoft Teams.
              </p>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
              {step === 1 && agent && (
                <div className="grid gap-5">
                  <div className="grid gap-1.5">
                    <Label htmlFor="teams-app-name">Teams app name</Label>
                    <Input
                      id="teams-app-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={agent.name || "Lite Agent"}
                      className="h-10 text-base"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="teams-endpoint">Messaging endpoint</Label>
                    <div className="flex gap-2">
                      <Input
                        id="teams-endpoint"
                        value={endpointFor(agent.id)}
                        readOnly
                        className="font-mono text-xs"
                      />
                      <Button type="button" variant="outline" size="icon" onClick={copyEndpoint} aria-label="Copy Teams endpoint">
                        <Clipboard className="size-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Use this URL as the Azure Bot messaging endpoint.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="teams-app-id">Microsoft App ID</Label>
                      <Input
                        id="teams-app-id"
                        value={credentials.appId}
                        onChange={(e) => setCredentials((c) => ({ ...c, appId: e.target.value }))}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="teams-tenant-id">Tenant ID</Label>
                      <Input
                        id="teams-tenant-id"
                        value={credentials.tenantId}
                        onChange={(e) => setCredentials((c) => ({ ...c, tenantId: e.target.value }))}
                        placeholder="Optional for multi-tenant bots"
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="teams-app-password">App password</Label>
                    <Input
                      id="teams-app-password"
                      type="password"
                      autoComplete="new-password"
                      value={credentials.appPassword}
                      onChange={(e) => setCredentials((c) => ({ ...c, appPassword: e.target.value }))}
                      placeholder="Client secret value"
                    />
                    <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      <Info className="size-3.5" />
                      Paste the secret value, not the secret ID.
                    </div>
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}

              {step === 2 && agent && (
                <div className="grid gap-6">
                  <div className="grid gap-1">
                    <h3 className="text-base font-semibold tracking-tight">Install in Teams</h3>
                    <p className="text-sm leading-6 text-muted-foreground">
                      The package contains the Teams manifest and icons for this agent. Upload it through Teams app management or Developer Portal.
                    </p>
                  </div>
                  <div className="grid gap-4 rounded-lg border border-border bg-muted/20 p-5">
                    <div className="grid gap-1">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Messaging endpoint</p>
                      <p className="break-all font-mono text-xs">{endpointFor(agent.id)}</p>
                    </div>
                    <div className="grid gap-1">
                      <p className="text-xs font-medium uppercase text-muted-foreground">Status</p>
                      <p className="text-sm font-medium">
                        {teamsConfig(agent).status === "package_ready"
                          ? "Package ready"
                          : "Credentials saved"}
                      </p>
                    </div>
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}
            </div>

            <DialogFooter className="m-0 border-t bg-background px-7 py-4">
              {step === 1 && (
                <Button onClick={saveCredentials} disabled={saving}>
                  {saving ? "Saving…" : "Save Bot Credentials"}
                </Button>
              )}
              {step === 2 && (
                <>
                  <Button variant="outline" onClick={() => setStep(1)} disabled={saving}>
                    <ArrowLeft className="size-3.5" />
                    Back
                  </Button>
                  <Button onClick={downloadPackage} disabled={saving}>
                    <Download className="size-3.5" />
                    {saving ? "Preparing…" : "Download Teams Package"}
                  </Button>
                </>
              )}
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  return { dialog, openTeams };
}
