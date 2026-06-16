"use client";

import { useEffect, useState } from "react";
import {
  Server,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Search,
  Info,
  X,
  Zap,
  Save,
  RotateCcw,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  KeyRound,
  LockKeyhole,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { BrandIcon } from "@/components/brand-icons";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  listMcpServerTools,
  testMcpServerTools,
  discoverMcpToolsFromUrl,
  getMcpProxyBaseUrl,
  saveMcpProxyBaseUrl,
} from "@/lib/api";
import type { McpProxyBaseUrlSetting, McpToolDef } from "@/lib/api";
import type { McpServer } from "@/lib/types";
import { cn } from "@/lib/utils";

// ── Variable / header types ────────────────────────────────────────────────────

type VariableScope = "instance" | "per_user";

interface VariableDef {
  name: string;
  description: string;
  scope: VariableScope;
  /** Only meaningful for scope=instance — stored as plaintext for now (encryption is a follow-up). */
  value: string;
}

// ── Form state ────────────────────────────────────────────────────────────────

interface FormState {
  server_name: string;
  alias: string;
  description: string;
  url: string;
  transport: string;
  /** Variables table: defines the credential/config contract for this server */
  variables: VariableDef[];
  /** Static headers sent to the MCP server; values may reference ${VAR_NAME} */
  static_headers: { name: string; value: string }[];
  /** Array of selected tool names. Empty = allow all. */
  allowed_tools: string[];
  /** Fallback raw text when discovery hasn't been attempted or failed. */
  allowed_tools_text: string;
  available_on_public_internet: boolean;
}

const EMPTY_FORM: FormState = {
  server_name: "",
  alias: "",
  description: "",
  url: "",
  transport: "sse",
  variables: [],
  static_headers: [],
  allowed_tools: [],
  allowed_tools_text: "",
  available_on_public_internet: true,
};

const GMAIL_TEMPLATE_TOOLS = [
  "search_threads",
  "get_thread",
  "create_draft",
  "list_drafts",
  "list_labels",
];

const GMAIL_TEMPLATE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

const GMAIL_TEMPLATE_RESOURCE = "https://gmailmcp.googleapis.com/mcp";

type McpServersTab = "servers" | "templates";

const MCP_SERVERS_TABS: { id: McpServersTab; label: string }[] = [
  { id: "servers", label: "Servers" },
  { id: "templates", label: "Templates" },
];

const GMAIL_TEMPLATE_STEPS: {
  title: string;
  eyebrow: string;
  icon: LucideIcon;
  body: string;
  details: string[];
  code: string;
  link?: { label: string; href: string };
}[] = [
  {
    title: "Google project",
    eyebrow: "Cloud APIs",
    icon: Server,
    body:
      "Create or select the Google Cloud project that owns the OAuth client, then enable both Gmail services.",
    details: [
      "Run gcloud auth login --update-adc if the CLI is not authenticated.",
      "Run gcloud services enable gmail.googleapis.com gmailmcp.googleapis.com --project=PROJECT_ID.",
      "Use this same project for Google Auth Platform, the Web OAuth client, and quota/debugging.",
    ],
    code:
      "gcloud services enable gmail.googleapis.com gmailmcp.googleapis.com --project=PROJECT_ID",
  },
  {
    title: "OAuth consent",
    eyebrow: "Google Auth Platform",
    icon: LockKeyhole,
    body:
      "Configure the consent screen that users see before they grant Gmail access to agents.",
    details: [
      "Use an internal audience for your Workspace, or external if users are outside the Workspace.",
      "Add Gmail readonly and compose scopes for search/read/draft-only access.",
      "Add gmail.modify only if you intentionally expose label mutation tools.",
      "Do not add Gmail send tools until the agent runtime has explicit human approval.",
    ],
    code: GMAIL_TEMPLATE_SCOPES.join("\n"),
    link: {
      label: "Open Google Auth Platform",
      href: "https://console.cloud.google.com/auth/overview",
    },
  },
  {
    title: "OAuth client",
    eyebrow: "Web application",
    icon: KeyRound,
    body:
      "Create a Web application OAuth client. Do not use the Desktop client type for this flow.",
    details: [
      "Application type: Web application.",
      "Redirect URI must exactly match the LAP origin users open: https://YOUR_LAP_PUBLIC_URL/v1/mcp/oauth/callback.",
      "For local backend-served LAP, use http://localhost:4000/v1/mcp/oauth/callback.",
      "For the separate Next dev server proxy, use http://localhost:3213/v1/mcp/oauth/callback.",
      "Save the client ID and client secret on the Gmail MCP server record.",
    ],
    code:
      "Application type: Web application\nAuthorized redirect URI: https://YOUR_LAP_PUBLIC_URL/v1/mcp/oauth/callback",
  },
  {
    title: "LAP connector",
    eyebrow: "Implementation",
    icon: Check,
    body:
      "Register the Gmail MCP server once, then send users to Integrations to click Connect Gmail.",
    details: [
      "Set auth_type to oauth2 with Google's auth and token URLs.",
      "Store oauth_client_id and oauth_client_secret in the server credentials.",
      "Store the Gmail MCP resource value in mcp_info.oauth.resource so OAuth requests include the protected resource.",
      "Store mcp_info.oauth.scopes with Gmail readonly and compose so LAP can start the OAuth flow.",
      "Expose only read and draft tools: search_threads, get_thread, create_draft, list_drafts, list_labels.",
    ],
    code:
      `url=https://gmailmcp.googleapis.com/mcp/v1
transport=streamable_http
auth_type=oauth2
authorization_url=https://accounts.google.com/o/oauth2/v2/auth
token_url=https://oauth2.googleapis.com/token
mcp_info.oauth.resource=${GMAIL_TEMPLATE_RESOURCE}
${GMAIL_TEMPLATE_SCOPES.map((scope) => `mcp_info.oauth.scopes[]=${scope}`).join("\n")}`,
  },
  {
    title: "Verification",
    eyebrow: "Google MCP",
    icon: Zap,
    body:
      "After a user connects Gmail, verify OAuth separately from Google's hosted MCP execution.",
    details: [
      "The Integrations page should show Gmail as Connected after Google redirects back to LAP.",
      "A direct Gmail API call with the stored token should succeed before testing Gmail MCP tools.",
      "tools/list can succeed even when tools/call is blocked by Google, so test search_threads too.",
      "If direct Gmail API works but tools/call returns 'The caller does not have permission', check Google Workspace Developer Preview or project entitlement for hosted Gmail MCP.",
    ],
    code:
      `GET /v1/mcp/user-credentials
POST /gmail/mcp {"method":"tools/list"}
POST /gmail/mcp {"method":"tools/call","params":{"name":"search_threads","arguments":{"query":"in:inbox newer_than:7d","pageSize":1}}}`,
  },
];

function serverToForm(s: McpServer): FormState {
  const tools = s.allowed_tools ?? [];

  // Reconstruct variables from mcp_info.variables (new shape) or fall back to
  // legacy byok_description for servers saved with the old form.
  const rawVars = (s as Record<string, unknown>)["mcp_info"] as
    | { variables?: Array<{ name: string; description?: string; scope?: string }> }
    | undefined;
  const rawCreds = (s as Record<string, unknown>)["credentials"] as
    | Record<string, string>
    | undefined;
  const rawHeaders = (s as Record<string, unknown>)["static_headers"] as
    | Record<string, string>
    | undefined;

  let variables: VariableDef[] = [];
  if (rawVars?.variables && rawVars.variables.length > 0) {
    variables = rawVars.variables.map((v) => ({
      name: v.name ?? "",
      description: v.description ?? "",
      scope: (v.scope === "per_user" ? "per_user" : "instance") as VariableScope,
      value: rawCreds?.[v.name] ?? "",
    }));
  } else if (s.is_byok && s.byok_description && s.byok_description.length > 0) {
    // Migrate legacy BYOK key names to per_user variables.
    variables = s.byok_description.map((name) => ({
      name,
      description: "",
      scope: "per_user" as VariableScope,
      value: "",
    }));
  }

  const static_headers: { name: string; value: string }[] = rawHeaders
    ? Object.entries(rawHeaders).map(([name, value]) => ({ name, value }))
    : [];

  return {
    server_name: s.server_name ?? "",
    alias: s.alias ?? "",
    description: s.description ?? "",
    url: s.url ?? "",
    transport: s.transport ?? "sse",
    variables,
    static_headers,
    allowed_tools: tools,
    allowed_tools_text: tools.join(", "),
    available_on_public_internet: s.available_on_public_internet ?? true,
  };
}

function formToPayload(f: FormState, discoveredTools: McpToolDef[] | null): Partial<McpServer> {
  // If we have discovery results, use the checkbox selection; otherwise parse the text field.
  const tools =
    discoveredTools !== null
      ? f.allowed_tools
      : f.allowed_tools_text
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

  const hasPerUserVars = f.variables.some((v) => v.scope === "per_user");
  const perUserVarNames = f.variables
    .filter((v) => v.scope === "per_user")
    .map((v) => v.name);

  // Instance variable values go into credentials (plaintext for now — encryption is a follow-up).
  const credentials: Record<string, string> = {};
  for (const v of f.variables) {
    if (v.scope === "instance" && v.value.trim()) {
      credentials[v.name] = v.value.trim();
    }
  }

  // Static headers as a flat record.
  const static_headers: Record<string, string> = {};
  for (const h of f.static_headers) {
    if (h.name.trim()) {
      static_headers[h.name.trim()] = h.value;
    }
  }

  // Variable definitions (no values) stored in mcp_info.
  const mcp_info = {
    variables: f.variables.map((v) => ({
      name: v.name,
      description: v.description,
      scope: v.scope,
    })),
  };

  return {
    server_name: f.server_name.trim() || undefined,
    alias: f.alias.trim() || undefined,
    description: f.description.trim() || undefined,
    url: f.url.trim(),
    transport: f.transport,
    // BYOK backwards-compat: true if any per-user variable exists.
    is_byok: hasPerUserVars,
    byok_description: perUserVarNames.length ? perUserVarNames : undefined,
    // New fields.
    mcp_info,
    credentials: Object.keys(credentials).length ? credentials : undefined,
    static_headers: Object.keys(static_headers).length ? static_headers : undefined,
    allowed_tools: tools,
    available_on_public_internet: f.available_on_public_internet,
  } as Partial<McpServer>;
}

function normalizeProxyBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function McpServersPage() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proxySetting, setProxySetting] = useState<McpProxyBaseUrlSetting | null>(null);
  const [proxyDraft, setProxyDraft] = useState("");
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [editorServer, setEditorServer] = useState<McpServer | null | "new">(null);
  const [confirmDelete, setConfirmDelete] = useState<McpServer | null>(null);
  const [activeTab, setActiveTab] = useState<McpServersTab>("servers");
  const [gmailTemplateOpen, setGmailTemplateOpen] = useState(false);
  const [gmailTemplateStep, setGmailTemplateStep] = useState(0);

  const refresh = async () => {
    try {
      setServers(await listMcpServers());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshProxySetting = async () => {
    try {
      const setting = await getMcpProxyBaseUrl();
      setProxySetting(setting);
      setProxyDraft(setting.proxy_base_url ?? "");
      setProxyError(null);
    } catch (e) {
      setProxyError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    refresh();
    refreshProxySetting();
  }, []);

  const onSaveProxyBaseUrl = async () => {
    const trimmed = proxyDraft.trim();
    const normalized = trimmed ? normalizeProxyBaseUrl(trimmed) : null;
    if (trimmed && !normalized) {
      setProxyError("Enter an absolute http(s) URL.");
      return;
    }

    setProxySaving(true);
    setProxyError(null);
    try {
      const setting = await saveMcpProxyBaseUrl(normalized);
      setProxySetting(setting);
      setProxyDraft(setting.proxy_base_url ?? "");
    } catch (e) {
      setProxyError(e instanceof Error ? e.message : String(e));
    } finally {
      setProxySaving(false);
    }
  };

  const onUseConfigProxyBaseUrl = async () => {
    setProxySaving(true);
    setProxyError(null);
    try {
      const setting = await saveMcpProxyBaseUrl(null);
      setProxySetting(setting);
      setProxyDraft(setting.proxy_base_url ?? "");
    } catch (e) {
      setProxyError(e instanceof Error ? e.message : String(e));
    } finally {
      setProxySaving(false);
    }
  };

  const onDelete = async (s: McpServer) => {
    setConfirmDelete(s);
  };

  const onOpenGmailTemplate = () => {
    setGmailTemplateStep(0);
    setGmailTemplateOpen(true);
  };

  const onAddServer = () => {
    setActiveTab("servers");
    setEditorServer("new");
  };

  const onConfirmDelete = async () => {
    if (!confirmDelete) return;
    const s = confirmDelete;
    setConfirmDelete(null);
    setServers((prev) => prev?.filter((x) => x.server_id !== s.server_id) ?? null);
    try {
      await deleteMcpServer(s.server_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Server className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold tracking-tight">MCP Servers</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onAddServer}>
              <Plus className="size-4" />
              Add Server
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-5xl space-y-4">
            <McpServersTabs activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === "templates" && (
              <div id="mcp-tabpanel-templates" role="tabpanel" aria-labelledby="mcp-tab-templates">
                <McpTemplatesPanel onOpenGmail={onOpenGmailTemplate} />
              </div>
            )}

            {activeTab === "servers" && (
              <div
                id="mcp-tabpanel-servers"
                role="tabpanel"
                aria-labelledby="mcp-tab-servers"
                className="space-y-4"
              >
                {error && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <ProxyBaseUrlPanel
                  setting={proxySetting}
                  draft={proxyDraft}
                  error={proxyError}
                  saving={proxySaving}
                  onDraftChange={setProxyDraft}
                  onSave={() => void onSaveProxyBaseUrl()}
                  onUseConfig={() => void onUseConfigProxyBaseUrl()}
                />

                {servers === null && !error && (
                  <div className="space-y-2">
                    {[...Array(4)].map((_, i) => (
                      <div
                        key={i}
                        className="h-12 rounded-lg border border-border bg-muted/30 animate-pulse motion-reduce:animate-none"
                      />
                    ))}
                  </div>
                )}

                {servers !== null && servers.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                    <Server className="size-10 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No MCP servers registered yet.</p>
                    <Button size="sm" onClick={onAddServer}>
                      <Plus className="size-4" />
                      Add your first server
                    </Button>
                  </div>
                )}

                {servers !== null && servers.length > 0 && (
                  <div className="rounded-lg border border-border overflow-x-auto">
                    <table className="min-w-[640px] w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40">
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Name
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            URL
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Transport
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Flags
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Status
                          </th>
                          <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {servers.map((s) => (
                          <ServerRow
                            key={s.server_id}
                            server={s}
                            onEdit={() => setEditorServer(s)}
                            onDelete={() => onDelete(s)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      <McpServerEditor
        serverOrNew={editorServer}
        onClose={() => setEditorServer(null)}
        onSaved={() => {
          setEditorServer(null);
          refresh();
        }}
      />

      <GmailTemplateDialog
        open={gmailTemplateOpen}
        step={gmailTemplateStep}
        onOpenChange={setGmailTemplateOpen}
        onStepChange={setGmailTemplateStep}
      />

      {/* Confirm delete dialog */}
      <Dialog open={confirmDelete !== null} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete MCP server?</DialogTitle>
            <DialogDescription>
              This will permanently remove &ldquo;
              {confirmDelete?.alias ?? confirmDelete?.server_name ?? confirmDelete?.server_id}
              &rdquo;. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void onConfirmDelete()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Table row ─────────────────────────────────────────────────────────────────

function McpServersTabs({
  activeTab,
  onChange,
}: {
  activeTab: McpServersTab;
  onChange: (tab: McpServersTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="MCP server sections"
      className="inline-flex rounded-lg border border-border bg-muted/30 p-1"
    >
      {MCP_SERVERS_TABS.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            id={`mcp-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`mcp-tabpanel-${tab.id}`}
            onClick={() => onChange(tab.id)}
            className={cn(
              "min-w-24 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              active && "bg-background font-semibold text-foreground shadow-sm ring-1 ring-border",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function ServerRow({
  server,
  onEdit,
  onDelete,
}: {
  server: McpServer;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const displayName = server.alias ?? server.server_name ?? server.server_id;
  const status = server.status ?? "unknown";

  return (
    <tr className="group bg-card hover:bg-muted/30 transition-colors">
      <td className="px-4 py-3">
        <div className="font-medium text-sm">{displayName}</div>
        {server.description && (
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
            {server.description}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-muted-foreground truncate max-w-xs block">
          {server.url ?? "—"}
        </span>
      </td>
      <td className="px-4 py-3">
        <Badge variant="outline" className="text-[10px] uppercase font-mono">
          {server.transport}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {server.is_byok && (
            <Badge className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
              BYOK
            </Badge>
          )}
          {server.available_on_public_internet && (
            <Badge className="text-[10px] bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30">
              Public
            </Badge>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge
          variant={status === "active" ? "secondary" : "outline"}
          className={`text-[10px] ${
            status === "active"
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
              : "text-muted-foreground"
          }`}
        >
          {status}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            aria-label="Edit server"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete server"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

function McpTemplatesPanel({ onOpenGmail }: { onOpenGmail: () => void }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold tracking-tight">Templates</h2>
        <p className="text-sm text-muted-foreground">
          Start from known MCP integrations that need setup before users can connect them.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <button
          type="button"
          onClick={onOpenGmail}
          className="group min-h-52 rounded-lg border border-border bg-muted/30 p-4 text-left opacity-75 grayscale transition-all hover:border-foreground/20 hover:bg-muted/45 hover:opacity-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-background/70">
              <BrandIcon id="gmail" className="size-6" />
            </div>
            <Badge variant="outline" className="border-border bg-background/60 text-muted-foreground">
              Not set up
            </Badge>
          </div>
          <div className="mt-5">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold tracking-tight">Gmail</h3>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                OAuth
              </span>
            </div>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              OAuth setup checklist for Google&apos;s hosted Gmail MCP server.
            </p>
          </div>
          <div className="mt-5 flex flex-wrap gap-1.5">
            {GMAIL_TEMPLATE_TOOLS.slice(0, 4).map((tool) => (
              <span
                key={tool}
                className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {tool}
              </span>
            ))}
          </div>
        </button>
      </div>
    </section>
  );
}

function GmailTemplateDialog({
  open,
  step,
  onOpenChange,
  onStepChange,
}: {
  open: boolean;
  step: number;
  onOpenChange: (open: boolean) => void;
  onStepChange: (step: number) => void;
}) {
  const current = GMAIL_TEMPLATE_STEPS[step] ?? GMAIL_TEMPLATE_STEPS[0];
  const Icon = current.icon;
  const isFirst = step === 0;
  const isLast = step === GMAIL_TEMPLATE_STEPS.length - 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[92vw] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border px-6 py-5">
          <div className="flex items-start gap-3 pr-8">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 grayscale">
              <BrandIcon id="gmail" className="size-7" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-xl">Gmail Template</DialogTitle>
                <Badge variant="outline" className="text-muted-foreground">
                  Setup required
                </Badge>
              </div>
              <DialogDescription className="mt-1">
                Prepare Google OAuth once so users can connect Gmail from Integrations.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[220px_1fr]">
          <aside className="border-b border-border bg-muted/25 px-4 py-4 md:border-b-0 md:border-r">
            <div className="grid gap-2">
              {GMAIL_TEMPLATE_STEPS.map((item, index) => {
                const StepIcon = item.icon;
                const active = index === step;
                const done = index < step;
                return (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() => onStepChange(index)}
                    className={cn(
                      "flex items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      active && "bg-background shadow-sm ring-1 ring-border",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground",
                        active && "bg-foreground text-background",
                        done && "bg-emerald-500/10 text-emerald-600",
                      )}
                    >
                      {done ? <Check className="size-3.5" /> : <StepIcon className="size-3.5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">{item.title}</span>
                      <span className="block text-xs text-muted-foreground">{item.eyebrow}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Step {step + 1} of {GMAIL_TEMPLATE_STEPS.length}
                </div>
                <h3 className="mt-1 text-lg font-semibold tracking-tight">{current.title}</h3>
              </div>
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                <Icon className="size-4 text-muted-foreground" />
              </div>
            </div>

            <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
              {current.body}
            </p>

            <div className="mt-5 rounded-lg border border-border bg-muted/20 p-4">
              <ol className="grid gap-3">
                {current.details.map((detail, index) => (
                  <li key={detail} className="flex gap-3 text-sm leading-5">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-background text-[11px] font-medium ring-1 ring-border">
                      {index + 1}
                    </span>
                    <span>{detail}</span>
                  </li>
                ))}
              </ol>
            </div>

            <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-background p-3 text-xs leading-5 text-muted-foreground">
              <code>{current.code}</code>
            </pre>

            {current.link && (
              <a
                href={current.link.href}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                {current.link.label}
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        </div>

        <DialogFooter className="items-center justify-between gap-3 sm:justify-between">
          <div className="hidden text-xs text-muted-foreground sm:block">
            Gmail stays unavailable until OAuth is configured end to end.
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isFirst}
              onClick={() => onStepChange(Math.max(0, step - 1))}
            >
              <ChevronLeft className="size-4" />
              Back
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (isLast) onOpenChange(false);
                else onStepChange(Math.min(GMAIL_TEMPLATE_STEPS.length - 1, step + 1));
              }}
            >
              {isLast ? "Done" : "Next"}
              {!isLast && <ChevronRight className="size-4" />}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProxyBaseUrlPanel({
  setting,
  draft,
  error,
  saving,
  onDraftChange,
  onSave,
  onUseConfig,
}: {
  setting: McpProxyBaseUrlSetting | null;
  draft: string;
  error: string | null;
  saving: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onUseConfig: () => void;
}) {
  const sourceLabel =
    setting === null
      ? error
        ? "Unavailable"
        : "Loading"
      : setting.source === "database"
        ? "Saved"
        : setting.source === "config"
          ? "Config"
          : "Unset";

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="mcp-proxy-base-url">Gateway public URL</Label>
            <Badge variant="outline" className="text-[10px] uppercase">
              {sourceLabel}
            </Badge>
          </div>
          <Input
            id="mcp-proxy-base-url"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="https://gateway.example.com"
            className="font-mono text-sm"
            autoComplete="off"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          {setting?.source === "database" && (
            <Button
              type="button"
              variant="outline"
              onClick={onUseConfig}
              disabled={saving}
              className="gap-2"
            >
              <RotateCcw className="size-4" />
              Use Config
            </Button>
          )}
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || setting === null}
            className="gap-2"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Save className="size-4" />
            )}
            Save URL
          </Button>
        </div>
      </div>
    </section>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function SectionHeader({ label, tooltip }: { label: string; tooltip: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-start gap-1.5">
      <span className="text-[13.5px] font-semibold tracking-tight">{label}</span>
      <div className="relative">
        <button
          type="button"
          aria-label={tooltip}
          onMouseEnter={() => setShow(true)}
          onMouseLeave={() => setShow(false)}
          onFocus={() => setShow(true)}
          onBlur={() => setShow(false)}
          className="cursor-help text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <Info className="size-3.5" />
        </button>
        {show && (
          <div className="absolute left-0 top-5 z-50 w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
            {tooltip}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Variables table ───────────────────────────────────────────────────────────

function VariablesTable({
  variables,
  onChange,
}: {
  variables: VariableDef[];
  onChange: (vars: VariableDef[]) => void;
}) {
  const addRow = () =>
    onChange([
      ...variables,
      { name: "", description: "", scope: "per_user", value: "" },
    ]);

  const removeRow = (idx: number) =>
    onChange(variables.filter((_, i) => i !== idx));

  const patchRow = <K extends keyof VariableDef>(
    idx: number,
    key: K,
    value: VariableDef[K],
  ) => {
    const next = variables.map((v, i) => (i === idx ? { ...v, [key]: value } : v));
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <SectionHeader
          label="Variables"
          tooltip="Reference variables in the URL and headers using ${VAR_NAME}. Per-user: each user provides their own value (e.g. their API key). Instance: admin sets one value shared for all users."
        />
      </div>

      {variables.length > 0 && (
        <div className="rounded-md border border-border overflow-hidden">
          {/* header */}
          <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-0 border-b border-border bg-muted/40">
            <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Variable name
            </div>
            <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Description
            </div>
            <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Scope
            </div>
            <div className="w-8" />
          </div>

          {variables.map((v, idx) => (
            <div key={idx} className="border-b border-border last:border-b-0">
              <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-0 items-center">
                <div className="px-3 py-2 border-r border-border">
                  <input
                    id={`var-name-${idx}`}
                    value={v.name}
                    onChange={(e) => patchRow(idx, "name", e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                    placeholder="VAR_NAME"
                    autoComplete="off"
                    className="w-full bg-transparent font-mono text-xs outline-none focus:ring-1 focus:ring-ring rounded placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="px-3 py-2 border-r border-border">
                  <input
                    id={`var-desc-${idx}`}
                    value={v.description}
                    onChange={(e) => patchRow(idx, "description", e.target.value)}
                    placeholder="Short description"
                    className="w-full bg-transparent text-xs outline-none focus:ring-1 focus:ring-ring rounded placeholder:text-muted-foreground/60"
                  />
                </div>
                <div className="px-2 py-1.5 border-r border-border">
                  <Select
                    value={v.scope}
                    onValueChange={(val) => patchRow(idx, "scope", val as VariableScope)}
                  >
                    <SelectTrigger size="sm" className="h-6 text-xs border-0 shadow-none bg-transparent px-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="per_user">Per-user</SelectItem>
                      <SelectItem value="instance">Instance</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-center w-8">
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    className="p-1 text-muted-foreground hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
                    aria-label="Remove variable"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>

              {/* Inline value input for instance-scoped variables */}
              {v.scope === "instance" && (
                <div className="px-3 pb-2 pt-0 bg-muted/20 border-t border-dashed border-border">
                  <Label
                    htmlFor={`var-value-${idx}`}
                    className="block text-[10px] text-muted-foreground mb-1 mt-1 font-normal"
                  >
                    Value
                    <button
                      type="button"
                      title="Admin-set value shared across all users. Encryption support is coming soon."
                      aria-label="Admin-set value shared across all users. Encryption support is coming soon."
                      className="ml-1 cursor-help text-muted-foreground/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded align-middle"
                    >
                      <Info className="inline size-3" />
                    </button>
                  </Label>
                  <input
                    id={`var-value-${idx}`}
                    type="password"
                    value={v.value}
                    onChange={(e) => patchRow(idx, "value", e.target.value)}
                    placeholder="Enter value…"
                    autoComplete="off"
                    className="w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={addRow}
        className="h-7 gap-1.5 text-xs"
      >
        <Plus className="size-3" />
        Add Variable
      </Button>
    </div>
  );
}

// ── Static headers table ──────────────────────────────────────────────────────

function StaticHeadersTable({
  headers,
  onChange,
}: {
  headers: { name: string; value: string }[];
  onChange: (h: { name: string; value: string }[]) => void;
}) {
  const addRow = () => onChange([...headers, { name: "", value: "" }]);
  const removeRow = (idx: number) => onChange(headers.filter((_, i) => i !== idx));
  const patchRow = (idx: number, key: "name" | "value", value: string) => {
    const next = headers.map((h, i) => (i === idx ? { ...h, [key]: value } : h));
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <SectionHeader
          label="Static Headers"
          tooltip="Headers sent to the MCP server on every request. Use ${VAR_NAME} to reference variables defined above."
        />
      </div>

      {headers.length > 0 && (
        <div className="rounded-md border border-border overflow-hidden">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-0 border-b border-border bg-muted/40">
            <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Header name
            </div>
            <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Value
            </div>
            <div className="w-8" />
          </div>

          {headers.map((h, idx) => (
            <div
              key={idx}
              className="grid grid-cols-[1fr_1fr_auto] gap-0 items-center border-b border-border last:border-b-0"
            >
              <div className="px-3 py-2 border-r border-border">
                <input
                  id={`hdr-name-${idx}`}
                  value={h.name}
                  onChange={(e) => patchRow(idx, "name", e.target.value)}
                  placeholder="x-api-key"
                  className="w-full bg-transparent font-mono text-xs outline-none focus:ring-1 focus:ring-ring rounded placeholder:text-muted-foreground/60"
                />
              </div>
              <div className="px-3 py-2 border-r border-border">
                <input
                  id={`hdr-value-${idx}`}
                  value={h.value}
                  onChange={(e) => patchRow(idx, "value", e.target.value)}
                  placeholder="${VAR_NAME}"
                  autoComplete="off"
                  className="w-full bg-transparent font-mono text-xs outline-none focus:ring-1 focus:ring-ring rounded placeholder:text-muted-foreground/60"
                />
              </div>
              <div className="flex items-center justify-center w-8">
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  className="p-1 text-muted-foreground hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
                  aria-label="Remove header"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={addRow}
        className="h-7 gap-1.5 text-xs"
      >
        <Plus className="size-3" />
        Add Header
      </Button>
    </div>
  );
}

// ── Test connection panel ─────────────────────────────────────────────────────

function TestConnectionPanel({
  serverId,
  variables,
}: {
  serverId: string;
  variables: VariableDef[];
}) {
  const [open, setOpen] = useState(false);
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<
    { tools: McpToolDef[] } | { error: string } | null
  >(null);

  const perUserVars = variables.filter((v) => v.scope === "per_user");
  const instanceVars = variables.filter((v) => v.scope === "instance");

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      // Use POST with test values so per-user vars are substituted without vault lookup
      const tools = await testMcpServerTools(serverId, testValues);
      setResult({ tools });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-7 gap-1.5 text-xs"
      >
        <Zap className="size-3" />
        Test connection
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Test connection</span>
        <button
          type="button"
          onClick={() => { setOpen(false); setResult(null); }}
          aria-label="Close test panel"
          className="text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {(perUserVars.length > 0 || instanceVars.length > 0) && (
        <div className="space-y-2">
          {instanceVars.map((v) => (
            <div key={v.name} className="space-y-1">
              <Label htmlFor={`test-instance-${v.name}`} className="text-[10px] text-muted-foreground font-mono font-normal">
                {v.name}{" "}
                <span className="text-muted-foreground/60">(instance — pre-filled)</span>
              </Label>
              <Input
                id={`test-instance-${v.name}`}
                value={v.value}
                disabled
                className="h-7 text-xs font-mono"
                placeholder="(set in form)"
              />
            </div>
          ))}
          {perUserVars.map((v) => (
            <div key={v.name} className="space-y-1">
              <Label htmlFor={`test-user-${v.name}`} className="text-[10px] font-mono font-normal">
                Test value for{" "}
                <span className="font-semibold">{v.name}</span>
                {v.description && (
                  <span className="text-muted-foreground ml-1">— {v.description}</span>
                )}
              </Label>
              <Input
                id={`test-user-${v.name}`}
                value={testValues[v.name] ?? ""}
                onChange={(e) =>
                  setTestValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                }
                placeholder={`Enter ${v.name}…`}
                autoComplete="off"
                className="h-7 text-xs font-mono"
              />
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        size="sm"
        onClick={run}
        disabled={loading}
        className="h-7 gap-1.5 text-xs"
      >
        {loading ? (
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
        ) : (
          <Zap className="size-3" />
        )}
        {loading ? "Testing…" : "Run test"}
      </Button>

      {result && "error" in result && (
        <p className="text-xs text-destructive">{result.error}</p>
      )}

      {result && "tools" in result && (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
            Tools returned ({result.tools.length})
          </p>
          {result.tools.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No tools found.</p>
          ) : (
            <div className="rounded border border-border divide-y divide-border max-h-32 overflow-y-auto">
              {result.tools.map((t) => (
                <div key={t.name} className="px-2 py-1.5">
                  <span className="font-mono text-xs font-medium">{t.name}</span>
                  {t.description && (
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {t.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Add/Edit modal ────────────────────────────────────────────────────────────

function McpServerEditor({
  serverOrNew,
  onClose,
  onSaved,
}: {
  serverOrNew: McpServer | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = serverOrNew !== null && serverOrNew !== "new";
  const open = serverOrNew !== null;

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tool discovery state
  const [discoveredTools, setDiscoveredTools] = useState<McpToolDef[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  // Per-user test values entered inline before discovering
  const [testVarValues, setTestVarValues] = useState<Record<string, string>>({});

  const perUserVars = form.variables.filter((v) => v.scope === "per_user");

  useEffect(() => {
    if (serverOrNew === "new") {
      setForm(EMPTY_FORM);
    } else if (serverOrNew !== null) {
      setForm(serverToForm(serverOrNew));
    }
    setError(null);
    setDiscoveredTools(null);
    setDiscoverError(null);
    setTestVarValues({});
  }, [serverOrNew]);

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onDiscoverTools = async () => {
    setDiscoverError(null);
    setDiscovering(true);
    try {
      let tools: McpToolDef[];
      if (isEdit) {
        // Use test variable values if any per_user vars defined
        const serverId = (serverOrNew as McpServer).server_id;
        tools = Object.keys(testVarValues).length > 0
          ? await testMcpServerTools(serverId, testVarValues)
          : await listMcpServerTools(serverId);
      } else {
        const url = form.url.trim();
        if (!url) {
          setDiscoverError("Enter a URL before discovering tools.");
          return;
        }
        // Build static_headers record from the form
        const staticHeaders: Record<string, string> = {};
        for (const h of form.static_headers) {
          if (h.name.trim()) staticHeaders[h.name.trim()] = h.value;
        }
        // Merge instance variable values + any per-user test values as variables
        const variables: Record<string, string> = {};
        for (const v of form.variables) {
          if (v.scope === "instance" && v.value.trim()) {
            variables[v.name] = v.value.trim();
          }
        }
        Object.assign(variables, testVarValues);
        tools = await discoverMcpToolsFromUrl(url, staticHeaders, variables);
      }
      setDiscoveredTools(tools);
      // Pre-select tools that were already in allowed_tools
      const alreadySelected = new Set(form.allowed_tools);
      if (alreadySelected.size === 0) {
        // No prior selection: select all by default so the admin can uncheck unwanted ones.
        setForm((f) => ({ ...f, allowed_tools: tools.map((t) => t.name) }));
      }
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : String(e));
      setDiscoveredTools(null);
    } finally {
      setDiscovering(false);
    }
  };

  const toggleTool = (name: string, checked: boolean) => {
    setForm((f) => ({
      ...f,
      allowed_tools: checked
        ? [...f.allowed_tools, name]
        : f.allowed_tools.filter((t) => t !== name),
    }));
  };

  const onSave = async () => {
    const url = form.url.trim();
    if (!url) {
      setError("URL is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = formToPayload(form, discoveredTools);
      if (isEdit) {
        await updateMcpServer((serverOrNew as McpServer).server_id, payload);
      } else {
        await createMcpServer(payload);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[92vw] sm:max-w-2xl max-h-[88vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle>{isEdit ? "Edit MCP Server" : "Add MCP Server"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the registration for this MCP server."
              : "Register a new MCP server that agents can connect to."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* server_name */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-server-name">Server name</Label>
            <Input
              id="mcp-server-name"
              value={form.server_name}
              onChange={(e) => patch("server_name", e.target.value)}
              placeholder="my-mcp-server"
            />
          </div>

          {/* alias */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-alias">Alias</Label>
            <Input
              id="mcp-alias"
              value={form.alias}
              onChange={(e) => patch("alias", e.target.value)}
              placeholder="Human-readable shortname"
            />
          </div>

          {/* description */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-description">Description</Label>
            <textarea
              id="mcp-description"
              value={form.description}
              onChange={(e) => patch("description", e.target.value)}
              placeholder="What this MCP server provides…"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
            />
          </div>

          {/* divider */}
          <div className="border-t border-border" />

          {/* Variables — above URL so ${VAR_NAME} can be referenced in the URL field */}
          <VariablesTable
            variables={form.variables}
            onChange={(vars) => patch("variables", vars)}
          />

          {/* url (required) */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-url">
              URL <span className="text-destructive">*</span>
            </Label>
            <Input
              id="mcp-url"
              value={form.url}
              onChange={(e) => patch("url", e.target.value)}
              placeholder="https://my-mcp-server.example.com/sse"
              required
            />
          </div>

          {/* transport */}
          <div className="space-y-1.5">
            <Label htmlFor="mcp-transport">Transport</Label>
            <select
              id="mcp-transport"
              value={form.transport}
              onChange={(e) => patch("transport", e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="sse">SSE</option>
              <option value="http">HTTP</option>
              <option value="stdio">stdio</option>
            </select>
          </div>

          {/* Static Headers */}
          <StaticHeadersTable
            headers={form.static_headers}
            onChange={(h) => patch("static_headers", h)}
          />

          {/* divider */}
          <div className="border-t border-border" />

          {/* allowed_tools */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>
                Allowed tools{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  (leave empty to allow all)
                </span>
              </Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onDiscoverTools}
                disabled={discovering}
                className="h-7 gap-1.5 text-xs"
              >
                {discovering ? (
                  <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Search className="size-3" />
                )}
                {discovering ? "Discovering…" : "Discover & test"}
              </Button>
            </div>

            {/* Per-user variable test inputs — shown when per_user vars are defined */}
            {perUserVars.length > 0 && (
              <div className="rounded-md border border-border bg-muted/20 p-3 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Enter test values for per-user variables to discover tools:
                </p>
                {perUserVars.map((v) => (
                  <div key={v.name} className="flex items-center gap-2">
                    <label className="text-xs font-mono w-40 shrink-0 truncate">{v.name}</label>
                    <Input
                      type="password"
                      value={testVarValues[v.name] ?? ""}
                      onChange={(e) => setTestVarValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
                      placeholder="test value"
                      className="h-7 text-xs font-mono"
                    />
                  </div>
                ))}
              </div>
            )}

            {discoverError && (
              <p className="text-xs text-destructive">{discoverError}</p>
            )}

            {discoveredTools !== null ? (
              discoveredTools.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  No tools returned by the server.
                </p>
              ) : (
                <div className="rounded-md border border-border divide-y divide-border max-h-48 overflow-y-auto">
                  {discoveredTools.map((tool) => {
                    const checked = form.allowed_tools.includes(tool.name);
                    return (
                      <label
                        key={tool.name}
                        className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/30 transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleTool(tool.name, e.target.checked)}
                          className="mt-0.5 rounded shrink-0"
                        />
                        <div className="min-w-0">
                          <span className="block text-xs font-mono font-medium leading-tight">
                            {tool.name}
                          </span>
                          {tool.description && (
                            <span className="block text-[11px] text-muted-foreground leading-tight mt-0.5 line-clamp-2">
                              {tool.description}
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )
            ) : (
              <Input
                id="mcp-allowed-tools"
                value={form.allowed_tools_text}
                onChange={(e) => patch("allowed_tools_text", e.target.value)}
                placeholder="read_file, write_file"
                className="font-mono text-xs"
              />
            )}
          </div>

          {/* available_on_public_internet */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.available_on_public_internet}
                onChange={(e) =>
                  patch("available_on_public_internet", e.target.checked)
                }
                className="rounded"
              />
              <span className="text-sm font-medium">
                Show in public hub
              </span>
            </label>
            <p className="ml-6 mt-0.5 text-xs text-muted-foreground">
              Makes this server discoverable in the public integration hub.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4 shrink-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                Saving…
              </>
            ) : isEdit ? (
              "Save"
            ) : (
              "Add server"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
