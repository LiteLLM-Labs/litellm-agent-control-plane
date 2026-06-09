"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Brain,
  Check,
  Clock,
  Download,
  FileText,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteAgent,
  deleteMemory,
  downloadAgentFile,
  getAgent,
  listAgentFiles,
  listMemory,
  listSessions,
  storeMemory,
} from "@/lib/api";
import { scheduleLabel } from "@/lib/schedule";
import type { Agent, AgentFile, AgentRuntimeId, Memory, OpencodeSession } from "@/lib/types";

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function isAlwaysOn(memory: Memory): boolean {
  return memory.always_on === true || memory.always_on === 1;
}

function formatMemoryDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return timeAgo(ms);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return value === "claude_managed_agents" || value === "cursor" || value === "gemini_antigravity" || value === "opencode";
}

function runtimeFromAgent(agent: Agent): string {
  const config = agent.config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const runtime = (config as { runtime?: unknown }).runtime;
    if (isAgentRuntimeId(runtime)) return runtime;
  }
  if (isAgentRuntimeId(agent.harness)) return agent.harness;
  return "claude_managed_agents";
}

function fileNameFromPath(filePath: string): string {
  return filePath.split("/").filter(Boolean).at(-1) || "agent-file";
}

type MemoryFilter = "all" | "always" | "standard";

function AgentDetail() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = decodeURIComponent(searchParams.get("id") ?? "");

  const [agent, setAgent] = useState<Agent | null>(null);
  const [sessions, setSessions] = useState<OpencodeSession[]>([]);
  const [files, setFiles] = useState<AgentFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryFilter, setMemoryFilter] = useState<MemoryFilter>("all");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [newMemory, setNewMemory] = useState({ key: "", value: "", alwaysOn: false });
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ key: "", value: "", alwaysOn: false });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMemories = async (agentId = id) => {
    if (!agentId) return;
    setMemoryLoading(true);
    try {
      const rows = await listMemory(agentId);
      setMemories(rows);
      setSelectedKeys((prev) => new Set([...prev].filter((key) => rows.some((m) => m.key === key))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMemoryLoading(false);
    }
  };

  const loadFiles = async (agentId = id) => {
    if (!agentId) return;
    setFilesLoading(true);
    try {
      setFiles(await listAgentFiles(agentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFilesLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const [ag, allSessions, memoryRows, fileRows] = await Promise.all([
          getAgent(id),
          listSessions().catch(() => []),
          listMemory(id).catch(() => []),
          listAgentFiles(id).catch(() => []),
        ]);
        setAgent(ag);
        setSessions(allSessions.filter((s) => s.agent_id === id || s.agent === id || s.harness === id));
        setMemories(memoryRows);
        setFiles(fileRows);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const visibleFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    const rows = q
      ? files.filter((file) => file.path.toLowerCase().includes(q))
      : files;
    return [...rows].sort((a, b) => a.path.localeCompare(b.path));
  }, [files, fileQuery]);

  const visibleMemories = useMemo(() => {
    const q = memoryQuery.trim().toLowerCase();
    return memories
      .filter((memory) => {
        if (memoryFilter === "always" && !isAlwaysOn(memory)) return false;
        if (memoryFilter === "standard" && isAlwaysOn(memory)) return false;
        if (!q) return true;
        return memory.key.toLowerCase().includes(q) || memory.value.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const pinDiff = Number(isAlwaysOn(b)) - Number(isAlwaysOn(a));
        return pinDiff || b.updated_at - a.updated_at;
      });
  }, [memories, memoryFilter, memoryQuery]);

  const alwaysOnCount = memories.filter(isAlwaysOn).length;
  const selectedMemories = memories.filter((memory) => selectedKeys.has(memory.key));

  const handleDelete = async () => {
    if (!agent) return;
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    try {
      await deleteAgent(id);
      router.push("/agents/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openSessionStart = () => {
    if (!id) return;
    router.push(`/sessions/?agent=${encodeURIComponent(id)}`);
  };

  const handleDownloadFile = async (file: AgentFile) => {
    setDownloadingPath(file.path);
    try {
      const blob = await downloadAgentFile(id, file.path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileNameFromPath(file.path);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingPath(null);
    }
  };

  const toggleSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const beginEditMemory = (memory: Memory) => {
    setEditingKey(memory.key);
    setEditDraft({ key: memory.key, value: memory.value, alwaysOn: isAlwaysOn(memory) });
  };

  const saveMemoryDraft = async () => {
    if (!editingKey) return;
    const key = editDraft.key.trim();
    const value = editDraft.value.trim();
    if (!key || !value) return;
    try {
      const updated = await storeMemory(id, key, editDraft.value, editDraft.alwaysOn);
      if (key !== editingKey) await deleteMemory(id, editingKey);
      setMemories((prev) => {
        const withoutOld = prev.filter((m) => m.key !== editingKey && m.key !== key);
        return [updated, ...withoutOld];
      });
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.delete(editingKey)) next.add(key);
        return next;
      });
      setEditingKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addMemory = async () => {
    const key = newMemory.key.trim();
    const value = newMemory.value.trim();
    if (!key || !value) return;
    try {
      const row = await storeMemory(id, key, newMemory.value, newMemory.alwaysOn);
      setMemories((prev) => [row, ...prev.filter((m) => m.key !== row.key)]);
      setNewMemory({ key: "", value: "", alwaysOn: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setMemoryAlwaysOn = async (memory: Memory, alwaysOn: boolean) => {
    try {
      const row = await storeMemory(id, memory.key, memory.value, alwaysOn);
      setMemories((prev) => prev.map((m) => (m.key === row.key ? row : m)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteMemoryRow = async (key: string) => {
    setMemories((prev) => prev.filter((m) => m.key !== key));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    try {
      await deleteMemory(id, key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await loadMemories();
    }
  };

  const bulkSetAlwaysOn = async (alwaysOn: boolean) => {
    if (selectedMemories.length === 0) return;
    try {
      const updated = await Promise.all(
        selectedMemories.map((memory) => storeMemory(id, memory.key, memory.value, alwaysOn)),
      );
      setMemories((prev) =>
        prev.map((memory) => updated.find((row) => row.key === memory.key) ?? memory),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const bulkDelete = async () => {
    const keys = [...selectedKeys];
    if (keys.length === 0) return;
    if (!confirm(`Delete ${keys.length} selected memor${keys.length === 1 ? "y" : "ies"}?`)) return;
    setMemories((prev) => prev.filter((memory) => !selectedKeys.has(memory.key)));
    setSelectedKeys(new Set());
    try {
      await Promise.all(keys.map((key) => deleteMemory(id, key)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await loadMemories();
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push("/agents/")}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Agents
            </Button>
            {agent && (
              <>
                <span className="text-muted-foreground">/</span>
                <span className="max-w-[240px] truncate text-sm font-semibold">{agent.name}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {agent && (
              <>
                <Button size="sm" variant="default" onClick={openSessionStart}>
                  <Play className="size-3.5" />
                  Run
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => router.push(`/agents/edit/?id=${encodeURIComponent(id)}`)}
                >
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
                <Button size="sm" variant="outline" onClick={handleDelete} aria-label="Delete">
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6">
            {error && (
              <Card className="border-destructive p-3">
                <p className="text-sm text-destructive">{error}</p>
              </Card>
            )}
            {loading && <div className="text-sm text-muted-foreground">Loading...</div>}

            {agent && (
              <>
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-xl font-semibold">{agent.name}</h1>
                    {agent.model && (
                      <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                        {String(agent.model)}
                      </span>
                    )}
                  </div>
                  {agent.description && (
                    <p className="text-sm text-muted-foreground">{agent.description}</p>
                  )}
                  {agent.created_at && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground/60">
                      <Clock className="size-3" />
                      Created {timeAgo(Number(agent.created_at) * 1000)}
                    </p>
                  )}
                </div>

                <section>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Configuration
                  </h2>
                  <Card className="p-4">
                    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[140px_1fr]">
                      <dt className="font-medium text-muted-foreground">ID</dt>
                      <dd className="break-all font-mono text-xs text-muted-foreground">{agent.id}</dd>

                      {agent.model && (
                        <>
                          <dt className="font-medium text-muted-foreground">Model</dt>
                          <dd className="font-mono text-xs">{String(agent.model)}</dd>
                        </>
                      )}

                      {agent.owner_id && (
                        <>
                          <dt className="font-medium text-muted-foreground">Owner</dt>
                          <dd className="font-mono text-xs">{String(agent.owner_id)}</dd>
                        </>
                      )}

                      <dt className="font-medium text-muted-foreground">Default runtime</dt>
                      <dd className="font-mono text-xs">{runtimeFromAgent(agent)}</dd>

                      <dt className="font-medium text-muted-foreground">Run schedule</dt>
                      <dd className="flex flex-col gap-1">
                        <span className="font-mono text-xs">
                          {scheduleLabel(agent.cron, agent.timezone)}
                        </span>
                        {agent.cron && (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {String(agent.cron)}
                          </span>
                        )}
                      </dd>

                      {agent.prompt && (
                        <>
                          <dt className="pt-1 font-medium text-muted-foreground">System prompt</dt>
                          <dd>
                            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                              {String(agent.prompt)}
                            </pre>
                          </dd>
                        </>
                      )}
                      {!agent.prompt && agent.system && (
                        <>
                          <dt className="pt-1 font-medium text-muted-foreground">System prompt</dt>
                          <dd>
                            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
                              {String(agent.system)}
                            </pre>
                          </dd>
                        </>
                      )}
                    </dl>
                  </Card>
                </section>

                <section>
                  <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <FileText className="size-3.5" />
                        Workspace Files
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Persisted files copied into this agent's workspace on each run.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative w-full sm:w-[260px]">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={fileQuery}
                          onChange={(e) => setFileQuery(e.target.value)}
                          placeholder="Search files"
                          className="h-8 pl-8 text-xs"
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8"
                        onClick={() => loadFiles()}
                        disabled={filesLoading}
                      >
                        <RefreshCw className={`size-3.5 ${filesLoading ? "animate-spin" : ""}`} />
                      </Button>
                    </div>
                  </div>

                  <Card className="overflow-hidden">
                    <div className="grid grid-cols-3 border-b border-border bg-muted/20 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      <span>Path</span>
                      <span className="text-right">Size</span>
                      <span className="text-right">Download</span>
                    </div>
                    {filesLoading && files.length === 0 ? (
                      <div className="p-6 text-sm text-muted-foreground">Loading files...</div>
                    ) : visibleFiles.length === 0 ? (
                      <div className="p-8 text-center">
                        <FileText className="mx-auto mb-3 size-7 text-muted-foreground/60" />
                        <p className="text-sm font-medium">
                          {files.length === 0 ? "No workspace files" : "No matching files"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {files.length === 0
                            ? "Upload or persist files to make them available on future runs."
                            : "Adjust the search to broaden the file list."}
                        </p>
                      </div>
                    ) : (
                      <div className="max-h-[360px] divide-y divide-border overflow-y-auto">
                        {visibleFiles.map((file) => (
                          <div
                            key={file.path}
                            className="grid grid-cols-[minmax(0,1fr)_72px_44px] items-center gap-3 px-3 py-2.5"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-mono text-xs" title={file.path}>
                                {file.path}
                              </p>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {file.encoding === "base64" ? "Binary" : "Text"} · Updated {formatMemoryDate(file.updated_at)}
                              </p>
                            </div>
                            <span className="text-right font-mono text-xs text-muted-foreground">
                              {formatBytes(file.size_bytes)}
                            </span>
                            <div className="flex justify-end">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 w-8 p-0"
                                onClick={() => handleDownloadFile(file)}
                                disabled={downloadingPath === file.path}
                                aria-label={`Download ${file.path}`}
                              >
                                <Download className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </section>

                <section>
                  <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <Brain className="size-3.5" />
                        Memory
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Review what this agent has learned, pin critical notes, and curate stale context.
                      </p>
                    </div>
                    <div className="grid grid-cols-3 overflow-hidden rounded-md border border-border bg-muted/20 text-center sm:w-[300px]">
                      <div className="px-3 py-2">
                        <div className="text-base font-semibold">{memories.length}</div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
                      </div>
                      <div className="border-x border-border px-3 py-2">
                        <div className="text-base font-semibold">{alwaysOnCount}</div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Always-on</div>
                      </div>
                      <div className="px-3 py-2">
                        <div className="text-base font-semibold">{selectedKeys.size}</div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Selected</div>
                      </div>
                    </div>
                  </div>

                  <Card className="overflow-hidden">
                    <div className="border-b border-border p-3">
                      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                        <div className="relative min-w-0 flex-1">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={memoryQuery}
                            onChange={(e) => setMemoryQuery(e.target.value)}
                            placeholder="Search keys or memory text"
                            className="h-8 pl-8 text-xs"
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {(["all", "always", "standard"] as MemoryFilter[]).map((filter) => (
                            <Button
                              key={filter}
                              type="button"
                              size="sm"
                              variant={memoryFilter === filter ? "default" : "outline"}
                              className="h-8 capitalize"
                              onClick={() => setMemoryFilter(filter)}
                            >
                              {filter === "always" ? "Always-on" : filter}
                            </Button>
                          ))}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8"
                            onClick={() => loadMemories()}
                            disabled={memoryLoading}
                          >
                            <RefreshCw className={`size-3.5 ${memoryLoading ? "animate-spin" : ""}`} />
                          </Button>
                        </div>
                      </div>
                      {selectedKeys.size > 0 && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
                          <span className="text-xs text-muted-foreground">
                            {selectedKeys.size} selected
                          </span>
                          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => bulkSetAlwaysOn(true)}>
                            <Pin className="size-3.5" />
                            Always-on
                          </Button>
                          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => bulkSetAlwaysOn(false)}>
                            <PinOff className="size-3.5" />
                            Standard
                          </Button>
                          <Button type="button" size="sm" variant="outline" className="h-7 text-destructive" onClick={bulkDelete}>
                            <Trash2 className="size-3.5" />
                            Delete
                          </Button>
                          <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" onClick={() => setSelectedKeys(new Set())}>
                            Clear
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="border-b border-border bg-muted/10 p-3">
                      <div className="grid gap-2 lg:grid-cols-[180px_minmax(0,1fr)_auto]">
                        <Input
                          value={newMemory.key}
                          onChange={(e) => setNewMemory((m) => ({ ...m, key: e.target.value }))}
                          placeholder="memory_key"
                          className="h-9 font-mono text-xs"
                        />
                        <Textarea
                          value={newMemory.value}
                          onChange={(e) => setNewMemory((m) => ({ ...m, value: e.target.value }))}
                          placeholder="Add a durable note for this agent"
                          rows={1}
                          className="min-h-9 resize-none text-xs"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant={newMemory.alwaysOn ? "default" : "outline"}
                            className="h-9"
                            onClick={() => setNewMemory((m) => ({ ...m, alwaysOn: !m.alwaysOn }))}
                          >
                            <Pin className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            className="h-9"
                            onClick={addMemory}
                            disabled={!newMemory.key.trim() || !newMemory.value.trim()}
                          >
                            <Plus className="size-3.5" />
                            Add
                          </Button>
                        </div>
                      </div>
                    </div>

                    {memoryLoading && memories.length === 0 ? (
                      <div className="p-6 text-sm text-muted-foreground">Loading memories...</div>
                    ) : visibleMemories.length === 0 ? (
                      <div className="p-8 text-center">
                        <Brain className="mx-auto mb-3 size-7 text-muted-foreground/60" />
                        <p className="text-sm font-medium">
                          {memories.length === 0 ? "No memories yet" : "No matching memories"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {memories.length === 0
                            ? "The agent can add memories as it works, or you can seed one above."
                            : "Adjust the search or filter to broaden the list."}
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-border">
                        {visibleMemories.map((memory) => {
                          const checked = selectedKeys.has(memory.key);
                          const editing = editingKey === memory.key;
                          return (
                            <div key={memory.key} className="grid gap-3 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSelected(memory.key)}
                                className="mt-1 size-4 rounded border-border bg-background"
                                aria-label={`Select ${memory.key}`}
                              />
                              <div className="min-w-0">
                                {editing ? (
                                  <div className="grid gap-2">
                                    <Input
                                      value={editDraft.key}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, key: e.target.value }))}
                                      className="h-8 font-mono text-xs"
                                    />
                                    <Textarea
                                      value={editDraft.value}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, value: e.target.value }))}
                                      rows={3}
                                      className="text-xs"
                                    />
                                  </div>
                                ) : (
                                  <>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-mono text-xs font-medium">{memory.key}</span>
                                      {isAlwaysOn(memory) && (
                                        <Badge variant="secondary" className="gap-1 text-[10px]">
                                          <Pin className="size-3" />
                                          Always-on
                                        </Badge>
                                      )}
                                      <span className="text-[11px] text-muted-foreground">
                                        Updated {formatMemoryDate(memory.updated_at)}
                                      </span>
                                    </div>
                                    <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                                      {memory.value}
                                    </p>
                                  </>
                                )}
                              </div>
                              <div className="flex items-center gap-1 sm:justify-end">
                                {editing ? (
                                  <>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant={editDraft.alwaysOn ? "default" : "outline"}
                                      className="h-8"
                                      onClick={() => setEditDraft((d) => ({ ...d, alwaysOn: !d.alwaysOn }))}
                                      aria-label="Toggle always-on"
                                    >
                                      <Pin className="size-3.5" />
                                    </Button>
                                    <Button type="button" size="sm" className="h-8" onClick={saveMemoryDraft}>
                                      <Check className="size-3.5" />
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => setEditingKey(null)}>
                                      <X className="size-3.5" />
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-8"
                                      onClick={() => setMemoryAlwaysOn(memory, !isAlwaysOn(memory))}
                                      aria-label={isAlwaysOn(memory) ? "Disable always-on" : "Make always-on"}
                                    >
                                      {isAlwaysOn(memory) ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => beginEditMemory(memory)}>
                                      <Pencil className="size-3.5" />
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-8 text-destructive"
                                      onClick={() => deleteMemoryRow(memory.key)}
                                    >
                                      <Trash2 className="size-3.5" />
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Card>
                </section>

                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Sessions ({sessions.length})
                    </h2>
                    <Button size="sm" variant="outline" onClick={openSessionStart}>
                      <Play className="size-3" />
                      Run
                    </Button>
                  </div>
                  {sessions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No sessions yet.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {sessions.map((s) => (
                        <Card
                          key={s.id}
                          className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 transition-colors hover:bg-muted/40"
                          onClick={() => router.push(`/chat/?id=${encodeURIComponent(s.id)}`)}
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{s.title ?? "Untitled session"}</p>
                            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{s.id}</p>
                          </div>
                          {s.time?.created && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {timeAgo(s.time.created * 1000)}
                            </span>
                          )}
                        </Card>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default function AgentDetailPage() {
  return (
    <Suspense>
      <AgentDetail />
    </Suspense>
  );
}
