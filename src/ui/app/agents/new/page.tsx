"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  Loader2,
  Pencil,
  Plus,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/ui/components/ui/button";
import { Textarea } from "@/ui/components/ui/textarea";
import { AgentFormFields, DEFAULT_HARNESS_ID } from "@/ui/components/agent-form-fields";
import { EnabledTools } from "@/ui/components/mcp-tools-picker";
import {
  AgentTemplate,
  ApiError,
  McpAllowedTools,
  createAgent,
  createSkill,
  getPreinstalledGithubRepo,
  listTemplates,
} from "@/ui/lib/api";
import { cn } from "@/ui/lib/utils";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const NAME_MAX = 64;

function normalizeRepoUrl(repo: string | undefined): string | undefined {
  const trimmed = repo?.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}`;
  }
  return trimmed;
}

function enabledToolsFromTemplate(t: AgentTemplate): EnabledTools {
  const enabled = new Map<string, Set<string>>();
  const allowedByServer = new Map(
    (t.mcp_allowed_tools ?? []).map((item) => [item.server_id, item.tools]),
  );
  for (const serverId of t.mcp_servers ?? []) {
    const tools = allowedByServer.get(serverId);
    if (tools?.length) enabled.set(serverId, new Set(tools));
  }
  return enabled;
}

export default function NewAgentPage() {
  const router = useRouter();

  // "blank" = no template; any other string = template id
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("blank");
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [activeTemplateTab, setActiveTemplateTab] = useState<"overview" | "files" | "skill" | "prompt">("overview");
  // Per-template skill edits — keyed by template id
  const [skillEdits, setSkillEdits] = useState<Record<string, string>>({});
  // Per-template skill edit mode — false = rendered preview, true = raw textarea
  const [skillEditMode, setSkillEditMode] = useState<Record<string, boolean>>({});

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;
  const currentSkill = selectedTemplate
    ? (skillEdits[selectedTemplate.id] ?? selectedTemplate.skill)
    : "";

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => {});
  }, []);

  function selectTemplate(id: string) {
    setSelectedTemplateId(id);
    setActiveTemplateTab("overview");
    const t = templates.find((t) => t.id === id);
    if (t) {
      setName(t.name);
      setHarnessId(t.harness_id);
      setModel(t.model);
      setPfpUrl(t.pfp_url ?? null);
      const parts = [t.prompt, t.skill ? `<!-- skill -->\n\n${skillEdits[t.id] ?? t.skill}` : ""].filter(Boolean);
      setSystemPrompt(parts.join("\n\n"));
      const templateVars = Object.entries(t.env_vars).filter(([k]) => !k.startsWith("LAP_FILE_"));
      setEnvVars(templateVars.length > 0 ? templateVars : [["", ""]]);
      setEnvVarHosts(t.env_var_hosts ?? {});
      setEnabledTools(enabledToolsFromTemplate(t));
      setPickedSkillIds(t.skill_ids ?? []);
      setSkillMode(t.skill_ids?.length ? "pick" : null);
    } else {
      // blank
      setName("");
      setHarnessId(DEFAULT_HARNESS_ID);
      setModel(DEFAULT_MODEL);
      setPfpUrl(null);
      setSystemPrompt("");
      setEnvVars([["", ""]]);
      setEnvVarHosts({});
      setEnabledTools(new Map());
      setPickedSkillIds([]);
      setSkillMode(null);
    }
  }

  // Form state — controlled props for AgentFormFields
  const [name, setName] = useState("");
  const [harnessId, setHarnessId] = useState<string>(DEFAULT_HARNESS_ID);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [pfpUrl, setPfpUrl] = useState<string | null>(null);
  const [envVars, setEnvVars] = useState<[string, string][]>([["", ""]]);
  const [envVarHosts, setEnvVarHosts] = useState<Record<string, string[]>>({});
  const [enabledTools, setEnabledTools] = useState<EnabledTools>(new Map());
  const [mcpToolTotals, setMcpToolTotals] = useState<Map<string, number>>(new Map());

  // Skill state
  const [pickedSkillIds, setPickedSkillIds] = useState<string[]>([]);
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillMode, setSkillMode] = useState<null | "write" | "pick">(null);
  const [skillSaveToLibrary, setSkillSaveToLibrary] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preinstalledRepo, setPreinstalledRepo] = useState<string>("");
  const [, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPreinstalledGithubRepo()
      .catch(() => "")
      .then((repo) => { if (!cancelled) setPreinstalledRepo(repo); })
      .catch((e) => { if (!cancelled) setMetaError(e instanceof ApiError ? e.message : (e as Error).message); })
      .finally(() => { if (!cancelled) setLoadingMeta(false); });
    return () => { cancelled = true; };
  }, []);

  function validate(): string | null {
    const trimmedName = name.trim();
    if (trimmedName.length > NAME_MAX) {
      return `Name must be ${NAME_MAX} characters or fewer.`;
    }
    if (!model.trim()) return "Model is required.";
    return null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    // Every secret must declare at least one allowed host — that's the whole
    // point of the per-secret scoping.
    const unscoped = envVars
      .map(([k]) => k.trim())
      .filter((k) => k && !(envVarHosts[k]?.length));
    if (unscoped.length > 0) {
      setError(`Set at least one allowed host for: ${unscoped.join(", ")}`);
      return;
    }

    setSubmitting(true);
    try {
      const mcpServers: string[] = [];
      const mcpAllowedTools: McpAllowedTools[] = [];
      for (const [serverId, toolSet] of enabledTools.entries()) {
        if (toolSet.size === 0) continue;
        mcpServers.push(serverId);
        const total = mcpToolTotals.get(serverId);
        if (total === undefined || toolSet.size < total) {
          mcpAllowedTools.push({
            server_id: serverId,
            tools: Array.from(toolSet).sort(),
          });
        }
      }

      const envVarsRecord: Record<string, string> = {};
      for (const [k, v] of envVars) {
        const key = k.trim();
        if (key) envVarsRecord[key] = v;
      }
      // Keep only host lists for credentials that still exist on submit, and
      // derive the agent's egress allowlist from the union of all per-secret
      // hosts — there's no separate global list.
      const finalEnvVarHosts: Record<string, string[]> = {};
      for (const key of Object.keys(envVarsRecord)) {
        if (envVarHosts[key]?.length) finalEnvVarHosts[key] = envVarHosts[key];
      }
      const derivedAllowOut = [...new Set(Object.values(finalEnvVarHosts).flat())];

      // If a template is selected and the user edited the skill panel, merge back.
      let finalPrompt = systemPrompt.trim() || undefined;
      if (selectedTemplate) {
        const editedSkill = skillEdits[selectedTemplate.id];
        if (editedSkill !== undefined) {
          const SEPARATOR = "<!-- skill -->";
          const separatorIdx = systemPrompt.indexOf(SEPARATOR);
          const basePrompt =
            separatorIdx >= 0
              ? systemPrompt.slice(0, separatorIdx).trimEnd()
              : systemPrompt.trimEnd();
          finalPrompt =
            `${basePrompt}\n\n${SEPARATOR}\n\n${editedSkill}`.trim() || undefined;
        }
      }

      // Append newly-picked library skills
      for (const skillId of pickedSkillIds) {
        finalPrompt = (finalPrompt ?? "") + `\n<!-- skill:${skillId} -->\n`;
      }

      // Merge inline skill into prompt
      if (skillInstructions.trim()) {
        const base = (finalPrompt ?? "").trimEnd();
        finalPrompt = base
          ? `${base}\n<!-- skill -->\n${skillInstructions.trim()}`
          : skillInstructions.trim();
        if (skillSaveToLibrary && skillName.trim()) {
          createSkill({
            name: skillName.trim(),
            description: skillDesc.trim() || undefined,
            content: skillInstructions.trim(),
          }).catch(() => {});
        }
      }

      const repoUrl = normalizeRepoUrl(preinstalledRepo || undefined);
      const created = await createAgent({
        name: name.trim() || undefined,
        model: model.trim(),
        prompt: finalPrompt,
        harness_id: harnessId,
        requirements: selectedTemplate?.requirements ?? undefined,
        repo_url: repoUrl,
        pfp_url: pfpUrl ?? undefined,
        mcp_servers: mcpServers.length > 0 ? mcpServers : undefined,
        mcp_allowed_tools: mcpAllowedTools.length > 0 ? mcpAllowedTools : undefined,
        env_vars: Object.keys(envVarsRecord).length > 0 ? envVarsRecord : undefined,
        env_var_hosts: Object.keys(finalEnvVarHosts).length > 0 ? finalEnvVarHosts : undefined,
        allow_out: derivedAllowOut,
        skill_ids: pickedSkillIds.length > 0 ? pickedSkillIds : undefined,
        // Preserve template provenance so the platform can detect version drift
        // and surface "sync available" when the template is later updated.
        template_id: selectedTemplate?.id ?? undefined,
      });
      router.push(`/agents/${created.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-full bg-background">
      <div className="w-full px-5 py-6 lg:px-8">
        <header className="mb-5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Back to agents"
              onClick={() => router.push("/agents")}
              className="text-muted-foreground"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-[20px] font-semibold tracking-tight">Create agent</h1>
              <p className="text-[12px] text-muted-foreground">Choose a template, runtime, and tools.</p>
            </div>
          </div>
          <Button type="submit" form="new-agent-form" disabled={submitting} size="sm">
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {submitting ? "Creating" : "Create"}
          </Button>
        </header>

        <form
          id="new-agent-form"
          className="space-y-5"
          onSubmit={onSubmit}
          noValidate
        >
          <section className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              Template
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
            <button
              type="button"
              onClick={() => selectTemplate("blank")}
              className={cn(
                "min-h-[92px] rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/30",
                selectedTemplateId === "blank"
                  ? "border-foreground/60 bg-accent/30"
                  : "border-dashed border-border bg-background/50",
              )}
            >
              <span className="flex items-center gap-2">
                <Bot className="size-3.5 text-muted-foreground" />
                <span className="text-[13px] font-medium">Blank</span>
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">Start from scratch.</span>
            </button>

            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => selectTemplate(t.id)}
                className={cn(
                  "min-h-[92px] rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/30",
                  selectedTemplateId === t.id
                    ? "border-foreground/60 bg-accent/30"
                    : "border-border bg-background/50",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="text-[13px]" aria-hidden>{t.icon}</span>
                  <span className="truncate text-[13px] font-medium">{t.name}</span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                  {t.description}
                </span>
              </button>
            ))}
            </div>
          </section>

            <section className="rounded-lg border bg-card/70 p-5 shadow-sm lg:p-6">
              <AgentFormFields
                name={name} onNameChange={setName}
                pfpUrl={pfpUrl} onPfpUrlChange={setPfpUrl}
                harnessId={harnessId} onHarnessIdChange={setHarnessId}
                model={model} onModelChange={setModel}
                systemPrompt={systemPrompt} onSystemPromptChange={setSystemPrompt}
                pickedSkillIds={pickedSkillIds} onPickedSkillIdsChange={setPickedSkillIds}
                skillName={skillName} onSkillNameChange={setSkillName}
                skillDesc={skillDesc} onSkillDescChange={setSkillDesc}
                skillInstructions={skillInstructions} onSkillInstructionsChange={setSkillInstructions}
                skillMode={skillMode} onSkillModeChange={setSkillMode}
                skillSaveToLibrary={skillSaveToLibrary} onSkillSaveToLibraryChange={setSkillSaveToLibrary}
                envVars={envVars} onEnvVarsChange={setEnvVars}
                envVarHosts={envVarHosts} onEnvVarHostsChange={setEnvVarHosts}
                enabledTools={enabledTools}
                onEnabledToolsChange={(v) => setEnabledTools(v as Parameters<typeof setEnabledTools>[0])}
                onMcpToolTotals={setMcpToolTotals}
                disabled={submitting}
              />
            </section>

              {metaError ? (
                <p className="font-mono text-xs text-muted-foreground">
                  Could not load repo info: {metaError}
                </p>
              ) : null}

              {error ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2 border-t pt-4">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={submitting}
                  onClick={() => router.push("/agents")}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  {submitting ? "Creating" : "Create agent"}
                </Button>
              </div>
          </form>

        {selectedTemplate && (
          <section className="mt-4 overflow-hidden rounded-lg border bg-card/70 shadow-sm">
              <div className="flex border-b text-[13px]">
                {(["overview", "files", "skill", "prompt"] as const)
                  .filter((tab) => {
                    if (tab === "files") return selectedTemplate.files.length > 0;
                    if (tab === "skill") return !!selectedTemplate.skill;
                    if (tab === "prompt") return !!selectedTemplate.prompt;
                    return true;
                  })
                  .map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTemplateTab(tab)}
                      className={cn(
                        "px-4 py-2 font-medium capitalize transition-colors hover:text-foreground",
                        activeTemplateTab === tab
                          ? "border-b-2 border-foreground text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {tab}
                    </button>
                  ))}
              </div>
              <div className="p-4">
                {activeTemplateTab === "overview" && (
                  <div className="space-y-3 text-[13px]">
                    {selectedTemplate.files.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Files</p>
                        <div className="space-y-1">
                          {selectedTemplate.files.map((f) => (
                            <div key={f.template_path} className="flex items-center gap-2 font-mono text-[12px]">
                              <span className="rounded border border-border bg-muted px-2 py-0.5">{f.template_path}</span>
                              <span className="text-muted-foreground">→</span>
                              <span className="text-muted-foreground">{f.sandbox_path}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedTemplate.tools.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Tools</p>
                        <div className="flex flex-wrap gap-1.5">
                          {selectedTemplate.tools.map((tool) => (
                            <span key={tool} className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[12px]">
                              {tool}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedTemplate.skill_name && (
                      <div>
                        <p className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Skill</p>
                        <div className="flex items-center gap-2">
                          <span className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[12px]">
                            {selectedTemplate.skill_name}
                          </span>
                          <button
                            type="button"
                            aria-label="View skill details"
                            onClick={() => setActiveTemplateTab("skill")}
                            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            View →
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {activeTemplateTab === "files" && (
                  <div className="space-y-4">
                    {selectedTemplate.files.map((f) => (
                      <div key={f.template_path}>
                        <div className="mb-1.5 flex items-center gap-2 font-mono text-[12px]">
                          <span className="rounded border border-border bg-muted px-2 py-0.5">{f.template_path}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-muted-foreground">{f.sandbox_path}</span>
                        </div>
                        <pre className="overflow-x-auto rounded-md border bg-muted/30 px-4 py-3 font-mono text-[12px] text-foreground">{f.content}</pre>
                      </div>
                    ))}
                  </div>
                )}
                {activeTemplateTab === "skill" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[13px] font-semibold">{selectedTemplate.skill_name}</p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setSkillEditMode((prev) => ({
                              ...prev,
                              [selectedTemplate.id]: !prev[selectedTemplate.id],
                            }))
                          }
                          className="flex items-center gap-1 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                          {skillEditMode[selectedTemplate.id] ? "Preview" : "Edit"}
                        </button>
                        {skillEdits[selectedTemplate.id] !== undefined && (
                          <button
                            type="button"
                            onClick={() =>
                              setSkillEdits((prev) => {
                                const next = { ...prev };
                                delete next[selectedTemplate.id];
                                return next;
                              })
                            }
                            className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                    {skillEditMode[selectedTemplate.id] ? (
                      <Textarea
                        value={currentSkill}
                        onChange={(e) =>
                          setSkillEdits((prev) => ({
                            ...prev,
                            [selectedTemplate.id]: e.target.value,
                          }))
                        }
                        className="min-h-[400px] font-mono text-[12px]"
                        spellCheck={false}
                      />
                    ) : (
                      <div className="prose prose-sm dark:prose-invert max-w-none overflow-y-auto rounded-md border bg-muted/30 px-4 py-3 text-[13px] [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {currentSkill}
                        </ReactMarkdown>
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      Edits are local to this agent — template is unchanged.
                    </p>
                  </div>
                )}
                {activeTemplateTab === "prompt" && (
                  <Textarea
                    aria-label="System prompt preview"
                    value={selectedTemplate.prompt}
                    readOnly
                    className="min-h-[400px] text-[13px] opacity-70"
                  />
                )}
              </div>
          </section>
        )}
      </div>
    </div>
  );
}
