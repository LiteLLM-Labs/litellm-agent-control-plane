"use client";

import { Suspense } from "react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Pencil, Plus } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
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
import { getAgent, updateAgent, listAgents, listModels, listAgentRuntimes } from "@/lib/api";
import { DEFAULT_TIMEZONE } from "@/lib/schedule";
import type { Agent, AgentRuntime, AgentRuntimeId } from "@/lib/types";

interface FormState {
  name: string;
  description: string;
  prompt: string;
  model: string;
  runtime: AgentRuntimeId;
  cron: string;
  timezone: string;
  subAgentIds: string[];
  config: Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function subAgentIdsFromConfig(config: Record<string, unknown>): string[] {
  const subAgents = Array.isArray(config.sub_agents) ? config.sub_agents : [];
  return [
    ...new Set(
      subAgents
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const agentId = (entry as Record<string, unknown>).agent_id;
          return typeof agentId === "string" ? agentId.trim() : "";
        })
        .filter(Boolean),
    ),
  ];
}

function configWithSubAgents(config: Record<string, unknown>, subAgentIds: string[]): Record<string, unknown> {
  const next = { ...config };
  const ids = [...new Set(subAgentIds.map((id) => id.trim()).filter(Boolean))];
  next.sub_agents = ids.map((agent_id) => ({ agent_id }));
  const platformMcpIds = Array.isArray(next.platform_mcp_ids)
    ? next.platform_mcp_ids.filter((id): id is string => typeof id === "string" && id !== "run_sub_agent")
    : [];
  if (ids.length > 0) platformMcpIds.push("run_sub_agent");
  next.platform_mcp_ids = platformMcpIds;
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
    config: {},
  });
  const [models, setModels] = useState<string[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const [ag, modelList, agentList, runtimeList] = await Promise.all([
          getAgent(id),
          listModels(),
          listAgents(),
          listAgentRuntimes(),
        ]);
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
          config,
        });
        setModels(modelList);
        setAgents(agentList.filter((agent) => agent.id !== id));
        setRuntimes(runtimeList);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const save = async () => {
    setSaving(true);
    setFormError(null);
    try {
      if (!form.name.trim()) throw new Error("Name is required");
      const cron = form.cron.trim();
      await updateAgent(id, {
        name: form.name,
        description: form.description,
        prompt: form.prompt,
        system: form.prompt,
        runtime: form.runtime,
        cron: cron || null,
        timezone: form.timezone.trim() || "UTC",
        config: configWithSubAgents(form.config, form.subAgentIds),
        ...(form.model ? { model: form.model } : {}),
      });
      router.push(`/agents/detail/?id=${encodeURIComponent(id)}`);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

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
            {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : (
              <div className="flex flex-col gap-6">
                <h1 className="text-lg font-semibold">Edit agent</h1>
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
                    <ModelSelect value={form.model} models={models} onValueChange={(v) => setForm({ ...form, model: v })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Default runtime</Label>
                    <Select
                      value={form.runtime}
                      onValueChange={(value) => {
                        if (isAgentRuntimeId(value)) setForm({ ...form, runtime: value });
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
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-base font-semibold tracking-tight">Sub-agents</h2>
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
                  <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
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
  return value === "claude_managed_agents" || value === "cursor" || value === "gemini_antigravity" || value === "opencode";
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
    {
      id: "opencode",
      name: "OpenCode",
      default_api_base: "",
      credential_provider_id: "opencode",
      credential_provider_name: "OpenCode",
      tools: [],
      connected: false,
    },
  ];
}
