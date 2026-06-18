"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink, KeyRound, Loader2, Pencil, Plug, Plus, Wrench } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelect } from "@/components/model-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScheduleEditor } from "@/components/schedule-editor";
import {
  apiErrorMessage,
  getAgent,
  updateAgent,
  listAgents,
  listModels,
  listAgentRuntimes,
  listMcpServerTools,
  listMcpUserCredentials,
  listPublicMcpServers,
} from "@/lib/api";
import {
  integrationFromMcpServer,
  sortIntegrations,
} from "@/lib/integrations";
import type { Integration } from "@/lib/integrations";
import {
  defaultModelForRuntime,
  modelOptions,
  runtimeSupportsModelDiscovery,
  selectedRuntimeModel,
} from "@/lib/model-options";
import { DEFAULT_TIMEZONE } from "@/lib/schedule";
import type { Agent, AgentRuntime, AgentRuntimeId } from "@/lib/types";
import { cn } from "@/lib/utils";

interface FormState {
  name: string;
  description: string;
  prompt: string;
  model: string;
  runtime: AgentRuntimeId;
  cron: string;
  timezone: string;
  subAgentIds: string[];
  mcpServerIds: string[];
  config: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function subAgentIdsFromConfig(config: Record<string, unknown>): string[] {
  const subAgents = Array.isArray(config.sub_agents) ? config.sub_agents : [];
  return uniqueStrings(
    subAgents.map((entry) => {
      if (!isRecord(entry)) return "";
      return typeof entry.agent_id === "string" ? entry.agent_id : "";
    }),
  );
}

function configWithSubAgents(config: Record<string, unknown>, subAgentIds: string[]): Record<string, unknown> {
  const next = { ...config };
  const ids = uniqueStrings(subAgentIds);
  next.sub_agents = ids.map((agent_id) => ({ agent_id }));
  const platformMcpIds = Array.isArray(next.platform_mcp_ids)
    ? next.platform_mcp_ids.filter((id): id is string => typeof id === "string" && id !== "run_sub_agent")
    : [];
  if (ids.length > 0) platformMcpIds.push("run_sub_agent");
  next.platform_mcp_ids = platformMcpIds;
  return next;
}

function configMcpValue(config: Record<string, unknown>): unknown {
  return config.mcp_servers ?? config.mcpServers;
}

function mcpServerId(server: Record<string, unknown>): string {
  for (const key of ["name", "server_id", "id", "mcp_server_name"]) {
    const value = server[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function mcpServersByIdFromConfig(config: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  const value = configMcpValue(config);
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (!isRecord(entry)) return;
      const id = mcpServerId(entry);
      if (id) byId.set(id, { ...entry, name: id });
    });
    return byId;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([id, entry]) => {
      if (!isRecord(entry)) return;
      const name = mcpServerId(entry) || id;
      if (name.trim()) byId.set(name.trim(), { ...entry, name: name.trim() });
    });
  }
  return byId;
}

function mcpServerIdsFromConfig(config: Record<string, unknown>): string[] {
  return uniqueStrings([...mcpServersByIdFromConfig(config).keys()]);
}

function mcpIntegrationsForForm(
  integrations: Integration[],
  config: Record<string, unknown>,
  selectedIds: string[],
): Integration[] {
  const knownIds = new Set(integrations.map((integration) => integration.id));
  const existingServers = mcpServersByIdFromConfig(config);
  const existingIntegrations = selectedIds.flatMap((id) => {
    if (knownIds.has(id)) return [];
    const server = existingServers.get(id);
    const url = typeof server?.url === "string" ? server.url : "";
    if (!server || !url.trim()) return [];
    return [{
      id,
      name: id,
      description: "Saved MCP server from this agent config.",
      category: "Other",
      envKey: "Saved configuration",
      mcpUrl: url,
      tools: [],
      source: "catalog" as const,
      connected: false,
      status: null,
    }];
  });
  return [...integrations, ...existingIntegrations];
}

function resolvedMcpServers(
  config: Record<string, unknown>,
  mcpServerIds: string[],
  integrations: Integration[],
): Record<string, unknown>[] {
  const existingServers = mcpServersByIdFromConfig(config);
  return uniqueStrings(mcpServerIds)
    .map((id): Record<string, unknown> | null => {
      const integration = integrations.find((entry) => entry.id === id);
      if (integration?.mcpUrl.trim()) {
        return { type: "url", name: id, url: integration.mcpUrl };
      }
      const existing = existingServers.get(id);
      if (typeof existing?.url !== "string" || !existing.url.trim()) return null;
      return {
        ...existing,
        type: typeof existing.type === "string" && existing.type.trim() ? existing.type : "url",
        name: id,
      };
    })
    .filter((server): server is Record<string, unknown> => server !== null);
}

function configWithAgentLinks(
  config: Record<string, unknown>,
  subAgentIds: string[],
  mcpServerIds: string[],
  integrations: Integration[],
): Record<string, unknown> {
  const next = configWithSubAgents(config, subAgentIds);
  const servers = resolvedMcpServers(config, mcpServerIds, integrations);
  const baseTools = Array.isArray(next.tools)
    ? next.tools.filter((tool) => !(isRecord(tool) && tool.type === "mcp_toolset"))
    : [];
  next.mcp_servers = servers;
  next.tools = [
    ...baseTools,
    ...servers.map((server) => ({ type: "mcp_toolset", mcp_server_name: server.name })),
  ];
  return next;
}

function AgentEdit() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = decodeURIComponent(searchParams.get("id") ?? "");

  const [form, setForm] = useState<FormState>({
    name: "",
    description: "",
    prompt: "",
    model: "",
    runtime: "claude_managed_agents",
    cron: "",
    timezone: DEFAULT_TIMEZONE,
    subAgentIds: [],
    mcpServerIds: [],
    config: {},
  });
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>([]);
  const [mcpIntegrations, setMcpIntegrations] = useState<Integration[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const [ag, agentList, runtimeList] = await Promise.all([
          getAgent(id),
          listAgents(),
          listAgentRuntimes(),
        ]);
        if (cancelled) return;
        const config = objectValue(ag.config);
        setForm({
          name: ag.name ?? "",
          description: ag.description ?? "",
          prompt: ag.prompt ?? "",
          model: ag.model ?? "",
          runtime: runtimeFromAgent(ag),
          cron: ag.cron ?? "",
          timezone: ag.timezone ?? DEFAULT_TIMEZONE,
          subAgentIds: subAgentIdsFromConfig(config),
          mcpServerIds: mcpServerIdsFromConfig(config),
          config,
        });
        setAgents(agentList.filter((agent) => agent.id !== id));
        setRuntimes(runtimeList);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const loadMcpIntegrations = async () => {
      setMcpLoading(true);
      setMcpError(null);
      try {
        const [servers, credentials] = await Promise.all([
          listPublicMcpServers(),
          listMcpUserCredentials().catch(() => [] as { server_id: string }[]),
        ]);
        const connectedIds = new Set(credentials.map((credential) => credential.server_id));
        const toolEntries = await Promise.all(
          servers.map(async (server) => {
            try {
              const tools = await listMcpServerTools(server.server_id);
              return [server.server_id, tools.map((tool) => tool.name).filter(Boolean)] as const;
            } catch {
              return [server.server_id, [] as string[]] as const;
            }
          }),
        );
        if (cancelled) return;
        const toolsByServer = new Map(toolEntries);
        const registryIntegrations = servers.map((server) =>
          integrationFromMcpServer(server, {
            connected: connectedIds.has(server.server_id),
            tools: toolsByServer.get(server.server_id),
          }),
        );
        setMcpIntegrations(sortIntegrations(registryIntegrations));
      } catch (err) {
        if (cancelled) return;
        setMcpIntegrations([]);
        setMcpError(apiErrorMessage(err, "MCP servers unavailable"));
      } finally {
        if (!cancelled) setMcpLoading(false);
      }
    };

    void loadMcpIntegrations();

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const runtime = form.runtime.trim();
    if (!runtime) {
      setModels([]);
      setModelsLoading(false);
      setModelsError(null);
      return;
    }

    setModels([]);
    setModelsLoading(true);
    setModelsError(null);
    if (!runtimeSupportsModelDiscovery(runtime)) {
      const defaultModel = defaultModelForRuntime(runtime);
      setModels(defaultModel ? [defaultModel] : []);
      setModelsLoading(false);
      setForm((current) => ({ ...current, model: current.model.trim() || defaultModel }));
      return;
    }
    listModels(runtime)
      .then((modelList) => {
        if (cancelled) return;
        setModels(modelList);
        setForm((current) => ({
          ...current,
          model: selectedRuntimeModel(modelList, current.model),
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setModels([]);
        setModelsError(apiErrorMessage(err, "Failed to load runtime models"));
        setForm((current) => ({ ...current, model: "" }));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [form.runtime, loading]);

  useEffect(() => {
    if (models.length === 0) return;
    setForm((current) => {
      const nextModel = selectedRuntimeModel(models, current.model);
      if (current.model.trim() === nextModel) return current;
      return { ...current, model: nextModel };
    });
  }, [form.model, models]);

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      if (!form.name.trim()) throw new Error("Name is required");
      if (!form.model.trim()) throw new Error("Model is required");
      const cron = form.cron.trim();
      await updateAgent(id, {
        name: form.name,
        description: form.description,
        prompt: form.prompt,
        system: form.prompt,
        model: form.model.trim(),
        runtime: form.runtime,
        cron: cron || null,
        timezone: form.timezone.trim() || "UTC",
        config: configWithAgentLinks(
          form.config,
          form.subAgentIds,
          form.mcpServerIds,
          mcpIntegrations,
        ),
      });
      router.push(`/agents/detail/?id=${encodeURIComponent(id)}`);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const availableModels = modelOptions(models, form.model);
  const displayedMcpIntegrations = mcpIntegrationsForForm(
    mcpIntegrations,
    form.config,
    form.mcpServerIds,
  );

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost"
              onClick={() => router.push(`/agents/detail/?id=${encodeURIComponent(id)}`)}
              className="gap-1.5 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-3.5" />Agent
            </Button>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm font-semibold">Edit</span>
          </div>
          <ThemeToggle />
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-8">
            {error && <Card className="border-destructive p-3 mb-6"><p className="text-sm text-destructive">{error}</p></Card>}
            {loading ? (
              <div className="flex flex-col gap-3">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="rounded-lg border border-border bg-card p-4">
                    <div className="h-4 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                    <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <h1 className="text-lg font-semibold tracking-tight">Edit Agent</h1>
                <div className="flex flex-col gap-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ag-name">Name</Label>
                    <Input id="ag-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="security-reviewer" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ag-desc">Description</Label>
                    <Input id="ag-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this agent does" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Model</Label>
                    <ModelSelect value={form.model} models={availableModels} onValueChange={(v) => setForm({ ...form, model: v })} />
                    {modelsLoading && (
                      <p className="text-xs text-muted-foreground">Loading runtime models…</p>
                    )}
                    {modelsError && (
                      <p className="text-xs text-destructive">{modelsError}</p>
                    )}
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Default runtime</Label>
                    <Select
                      value={form.runtime}
                      onValueChange={(value) => {
                        if (isAgentRuntimeId(value)) setForm({ ...form, runtime: value, model: "" });
                      }}
                    >
                      <SelectTrigger className="h-8 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {runtimeOptions(runtimes).map((runtime) => (
                          <SelectItem key={runtime.id} value={runtime.id}>
                            {runtime.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ag-prompt">System prompt</Label>
                    <Textarea id="ag-prompt" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                      className="font-mono text-xs min-h-[320px] resize-y" placeholder="You are a meticulous security reviewer…" />
                  </div>
                  <ScheduleEditor
                    cron={form.cron}
                    timezone={form.timezone}
                    onChange={(next) => setForm({ ...form, ...next })}
                  />

                  <div className="grid gap-2 rounded-lg border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="grid gap-1">
                        <h2 className="text-base font-semibold tracking-tight">MCP Servers</h2>
                        <p className="text-xs text-muted-foreground">
                          Attach registry MCP servers to expose their toolsets to this agent.
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {form.mcpServerIds.length} attached
                      </span>
                    </div>

                    {mcpError && (
                      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {mcpError}. Check the MCP registry connection and refresh this page.
                      </div>
                    )}

                    {mcpLoading ? (
                      <div className="grid gap-2">
                        {[0, 1, 2].map((item) => (
                          <div
                            key={item}
                            className="rounded-md border border-border bg-background px-3 py-3"
                          >
                            <div className="h-3 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                            <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                          </div>
                        ))}
                      </div>
                    ) : displayedMcpIntegrations.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-6 text-center">
                        <Plug className="size-8 text-muted-foreground/40" />
                        <div className="grid gap-1">
                          <p className="text-sm font-medium">No MCP Servers Available</p>
                          <p className="text-xs text-muted-foreground">
                            Add a server in the MCP registry, then return here to attach it.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="grid max-h-[360px] gap-2 overflow-y-auto pr-1">
                        {displayedMcpIntegrations.map((integration) => {
                          const enabled = form.mcpServerIds.includes(integration.id);
                          const availableTools = integration.tools.filter(Boolean);
                          const previewTools = availableTools.slice(0, 8);
                          const remainingTools = Math.max(availableTools.length - previewTools.length, 0);
                          const canAttach = integration.mcpUrl.trim().length > 0;
                          const checkboxId = `mcp-server-${integration.id}`;
                          const toggleMcpServer = (nextEnabled: boolean) => {
                            const mcpServerIds = nextEnabled
                              ? uniqueStrings([...form.mcpServerIds, integration.id])
                              : form.mcpServerIds.filter((serverId) => serverId !== integration.id);
                            setForm({ ...form, mcpServerIds });
                          };

                          return (
                            <label
                              key={integration.id}
                              htmlFor={checkboxId}
                              className={cn(
                                "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2.5 text-xs hover:bg-muted/40",
                                enabled && "border-foreground/30 bg-muted/40",
                                !canAttach && !enabled && "cursor-not-allowed opacity-70",
                              )}
                            >
                              <input
                                id={checkboxId}
                                type="checkbox"
                                checked={enabled}
                                disabled={!canAttach && !enabled}
                                onChange={(event) => toggleMcpServer(event.target.checked)}
                                className="mt-0.5 size-3.5 shrink-0"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium">{integration.name}</span>
                                  <span className="truncate font-mono text-muted-foreground">
                                    {integration.id}
                                  </span>
                                  <Badge variant="outline" className="h-5 rounded-md text-[10px]">
                                    {integration.source === "registry" ? "Registry" : "Saved"}
                                  </Badge>
                                  {integration.connected ? (
                                    <Badge variant="secondary" className="h-5 rounded-md text-[10px]">
                                      <KeyRound className="size-3" />
                                      Connected
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="h-5 rounded-md text-[10px]">
                                      <KeyRound className="size-3" />
                                      Needs Credentials
                                    </Badge>
                                  )}
                                </span>
                                <span className="mt-1 line-clamp-2 block text-muted-foreground">
                                  {integration.description}
                                </span>
                                <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                  <span className="inline-flex items-center gap-1">
                                    <KeyRound className="size-3" />
                                    {integration.envKey}
                                  </span>
                                  <span className="inline-flex items-center gap-1">
                                    <Wrench className="size-3" />
                                    {availableTools.length > 0
                                      ? `${availableTools.length} tools available`
                                      : "Tools not discovered yet"}
                                  </span>
                                </span>
                                {(enabled || availableTools.length > 0) && (
                                  <span className="mt-2 flex flex-wrap gap-1">
                                    {previewTools.map((tool) => (
                                      <span
                                        key={tool}
                                        className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                                      >
                                        {tool}
                                      </span>
                                    ))}
                                    {remainingTools > 0 && (
                                      <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                        +{remainingTools} more
                                      </span>
                                    )}
                                  </span>
                                )}
                                {!canAttach && (
                                  <span className="mt-2 block text-xs text-destructive">
                                    This server is missing a URL and cannot be attached until it is fixed in the registry.
                                  </span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}

                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => router.push("/mcp-servers/")}
                      className="h-7 justify-self-start gap-1.5 px-2 text-xs"
                    >
                      <ExternalLink className="size-3.5" />
                      Manage MCP Servers
                    </Button>
                  </div>

                  <div className="grid gap-2 rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-base font-semibold tracking-tight">Sub-Agents</h2>
                        <p className="text-xs text-muted-foreground">
                          Attached LAP agents are exposed as constrained run_sub_agent calls.
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {form.subAgentIds.length} attached
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => router.push("/agents/new/")}
                          className="h-7 gap-1.5 px-2 text-xs"
                        >
                          <Plus className="size-3.5" />
                          New
                        </Button>
                      </div>
                    </div>
                    {agents.length === 0 ? (
                      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        Create another agent first, then attach it here.
                      </div>
                    ) : (
                      <div className="grid gap-2">
                        {agents.map((agent) => {
                          const checked = form.subAgentIds.includes(agent.id);
                          const checkboxId = `sub-agent-${agent.id}`;
                          const toggleSubAgent = (enabled: boolean) => {
                            const subAgentIds = enabled
                              ? [...form.subAgentIds, agent.id]
                              : form.subAgentIds.filter((agentId) => agentId !== agent.id);
                            setForm({ ...form, subAgentIds });
                          };
                          return (
                            <div
                              key={agent.id}
                              className="flex min-w-0 items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-xs hover:bg-muted/40"
                            >
                              <input
                                id={checkboxId}
                                aria-label={`Attach ${agent.name}`}
                                type="checkbox"
                                checked={checked}
                                onChange={(event) => toggleSubAgent(event.target.checked)}
                                className="mt-0.5 size-3.5 shrink-0"
                              />
                              <span className="min-w-0 flex-1">
                                <label htmlFor={checkboxId} className="block cursor-pointer truncate text-sm font-medium">
                                  {agent.name}
                                </label>
                                <span className="mt-0.5 block truncate font-mono text-muted-foreground">
                                  {agent.id}
                                </span>
                                <span className="mt-1 line-clamp-2 block text-muted-foreground">
                                  {agent.description || agent.model || "Saved LAP agent"}
                                </span>
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Edit ${agent.name}`}
                                  title={`Edit ${agent.name}`}
                                  onClick={() => router.push(`/agents/edit/?id=${encodeURIComponent(agent.id)}`)}
                                  className="size-7"
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Open ${agent.name}`}
                                  title={`Open ${agent.name}`}
                                  onClick={() => router.push(`/agents/detail/?id=${encodeURIComponent(agent.id)}`)}
                                  className="size-7"
                                >
                                  <ExternalLink className="size-3.5" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {formError && (
                    <p className="text-sm text-destructive">{formError}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 pt-2">
                  <Button onClick={save} disabled={saving || !form.model.trim()} className="gap-1.5">
                    {saving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}
                    {saving ? "Saving…" : "Save Changes"}
                  </Button>
                  <Button variant="outline" onClick={() => router.push(`/agents/detail/?id=${encodeURIComponent(id)}`)} disabled={saving}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default function AgentEditPage() {
  return <Suspense><AgentEdit /></Suspense>;
}

function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return value === "claude_managed_agents" || value === "cursor" || value === "gemini_antigravity";
}

function runtimeFromAgent(agent: Agent): AgentRuntimeId {
  const config = agent.config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const runtime = (config as { runtime?: unknown }).runtime;
    if (isAgentRuntimeId(runtime)) return runtime;
  }
  if (isAgentRuntimeId(agent.harness)) return agent.harness;
  return "claude_managed_agents";
}

function runtimeOptions(runtimes: AgentRuntime[]): AgentRuntime[] {
  if (runtimes.length > 0) return runtimes;
  return [
    {
      id: "claude_managed_agents",
      name: "Claude Managed Agents",
      default_api_base: "",
      credential_provider_id: "anthropic",
      credential_provider_name: "Anthropic",
      tools: [],
      connected: false,
    },
    {
      id: "cursor",
      name: "Cursor",
      default_api_base: "",
      credential_provider_id: "cursor",
      credential_provider_name: "Cursor",
      tools: [],
      connected: false,
    },
    {
      id: "gemini_antigravity",
      name: "Gemini Antigravity",
      default_api_base: "",
      credential_provider_id: "gemini",
      credential_provider_name: "Gemini",
      tools: [],
      connected: false,
    },
  ];
}
