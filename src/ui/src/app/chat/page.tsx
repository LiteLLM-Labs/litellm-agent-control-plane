"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  ClipboardCheck,
  Cpu,
  ExternalLink,
  FileText,
  KeyRound,
  Loader2,
  Square,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelSelect } from "@/components/model-select";
import { MessageBlock } from "@/components/message-block";
import { Composer } from "@/components/composer";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sidebar } from "@/components/sidebar";
import { InspectorPanel } from "@/components/inspector-panel";
import { getMessages, getSession, createSession, deleteSession, subscribeRuntimeEvents, listModels, abortSession, interruptSession, listAgents, listApprovals, acceptApproval, rejectApproval, sendMessageWithRuntimeModel, listRuntimeEvents, listRuntimeHarnesses } from "@/lib/api";
import type { PendingApproval, RuntimeAgentEvent } from "@/lib/api";
import { ToolApprovalPanel } from "@/components/tool-approval-panel";
import type { Agent, AgentRuntimeId, HarnessMessage, RuntimeHarness, BuiltinRuntimeId } from "@/lib/types";
import { resolveApiSpec } from "@/lib/types";
import type { Frame } from "@/components/inspector-panel";
import SessionsPage from "../sessions/page";

const FALLBACK_MODELS = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4-1",
  "anthropic/claude-haiku-4-5",
];

const BUILTIN_AGENTS: Record<string, string> = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  cc: "Claude Code",
  "github-copilot": "GitHub Copilot",
  codex: "Codex",
};

function agentPrompt(agent: Agent | null): string {
  if (!agent) return "";
  return String(agent.prompt ?? agent.system ?? agent.system_prompt ?? "").trim();
}

function shortPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 220 ? compact.slice(0, 220).trimEnd() + "…" : compact;
}

function runtimeLabel(runtime?: string): string {
  if (runtime === "claude_managed_agents" || runtime === "claude_agents") return "Claude Managed Agents";
  if (runtime === "cursor") return "Cursor";
  if (runtime === "gemini_antigravity") return "Gemini Antigravity";
  return BUILTIN_AGENTS[runtime ?? ""] ?? runtime ?? "Claude Code";
}

function runtimeModelId(alias?: string, harnesses: RuntimeHarness[] = []): string | null {
  if (!alias) return null;
  const spec = resolveApiSpec(alias, harnesses);
  if (spec === "claude_managed_agents") return "anthropic/*";
  if (spec === "cursor") return "cursor/*";
  if (spec === "gemini_antigravity") return "gemini/*";
  if (spec === "opencode") return "opencode/*";
  return null;
}

function providerSessionUrl(runtime?: string, providerSessionId?: string, providerUrl?: string): string | null {
  if (providerUrl) return providerUrl;
  if ((runtime === "claude_managed_agents" || runtime === "claude_agents") && providerSessionId) {
    return `https://platform.claude.com/workspaces/default/sessions/${encodeURIComponent(providerSessionId)}`;
  }
  return null;
}

function runtimeTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(runtimeTextValue).join("");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [
    record.text,
    record.thinking,
    record.content,
    record.delta,
    record.content_block,
  ]
    .map(runtimeTextValue)
    .join("");
}

function runtimeEventText(ev: RuntimeAgentEvent): string {
  return runtimeTextValue(ev.text ?? ev.delta ?? ev.content ?? ev.content_block);
}

function normalizedRuntimeEventType(ev: RuntimeAgentEvent): string {
  const type = ev.type;
  return typeof type === "string" ? type : "";
}

function runtimeEventPartKind(ev: RuntimeAgentEvent): "text" | "thinking" {
  const part = ev.part;
  if (part && typeof part === "object") {
    const type = (part as { type?: unknown }).type;
    if (type === "thinking" || type === "reasoning") return "thinking";
  }
  const field = ev.field;
  if (field === "thinking" || field === "reasoning") return "thinking";
  const type = ev.type;
  if (type === "thinking_back" || type === "agent.thinking" || type === "agent.reasoning") {
    return "thinking";
  }
  return "text";
}

function runtimeErrorMessage(ev: RuntimeAgentEvent): string {
  const error = ev.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(ev);
}

function isRuntimeAssistantTextEvent(type: string): boolean {
  return (
    type === "assistant_response" ||
    type === "agent.message" ||
    type === "content_block_start" ||
    type === "content_block_delta" ||
    type === "message_delta"
  );
}

function isRuntimeThinkingEvent(type: string): boolean {
  return type === "thinking_back" || type === "agent.thinking" || type === "agent.reasoning";
}

function isRuntimeToolEvent(type: string): boolean {
  return (
    type === "tool_call" ||
    type === "tool_result" ||
    type === "agent.tool_use" ||
    type === "agent.tool_result"
  );
}

function isRuntimeTurnStartEvent(type: string): boolean {
  return (
    type === "span.model_request_start" ||
    type === "session.status_running" ||
    type === "session.thread_status_running"
  );
}

function runtimeToolId(ev: RuntimeAgentEvent): string {
  const id = ev.tool_use_id ?? ev.id;
  return typeof id === "string" && id ? id : `tool_${Date.now().toString(36)}`;
}

function runtimeToolStatus(ev: RuntimeAgentEvent): string {
  if (typeof ev.status === "string") return ev.status;
  if (ev.type === "tool_result" || ev.type === "agent.tool_result") return "completed";
  if (ev.error) return "error";
  return "running";
}

function runtimeEventKey(ev: RuntimeAgentEvent): string {
  const id = ev.id;
  if (typeof id === "string" && id) return `id:${id}`;
  const type = typeof ev.type === "string" ? ev.type : "";
  const createdAt = ev.created_at ?? ev.timestamp ?? ev.time;
  if (createdAt) return `${type}:${String(createdAt)}:${runtimeEventText(ev)}`;
  return `${type}:${JSON.stringify(ev)}`;
}

function runtimeUserText(ev: RuntimeAgentEvent): string {
  return runtimeTextValue(ev.content ?? ev.text ?? ev.message).trim();
}

function isLocalRuntimeUserEvent(ev: RuntimeAgentEvent): boolean {
  return ev.type === "user.message" && ev.local === true;
}

function mergeRuntimeEventList(
  current: RuntimeAgentEvent[],
  incoming: RuntimeAgentEvent | RuntimeAgentEvent[],
): RuntimeAgentEvent[] {
  const events = Array.isArray(incoming) ? incoming : [incoming];
  let next = current;
  const seen = new Set(current.map(runtimeEventKey));

  for (const ev of events) {
    const key = runtimeEventKey(ev);
    if (seen.has(key)) continue;

    if (ev.type === "user.message" && !isLocalRuntimeUserEvent(ev)) {
      const text = runtimeUserText(ev);
      if (text) {
        next = next.filter((candidate) => (
          !isLocalRuntimeUserEvent(candidate) || runtimeUserText(candidate) !== text
        ));
      }
    }

    next = [...next, ev];
    seen.add(key);
  }

  return next;
}

function makeTextMessage(sessionId: string, role: "user" | "assistant", id: string, text: string): HarnessMessage {
  return {
    info: { id, role, sessionID: sessionId },
    parts: [
      {
        id: `${id}_text`,
        messageID: id,
        sessionID: sessionId,
        type: "text",
        text,
      },
    ],
  };
}

type QueuedPrompt = {
  id: string;
  text: string;
};

function makeQueuedPromptMessage(sessionId: string, prompt: QueuedPrompt): HarnessMessage {
  return {
    ...makeTextMessage(sessionId, "user", prompt.id, prompt.text),
    info: { id: prompt.id, role: "user", sessionID: sessionId, status: "queued" },
  };
}

function runtimeEventsToMessages(
  sessionId: string,
  events: RuntimeAgentEvent[],
  status: "idle" | "busy",
): HarnessMessage[] {
  const messages: HarnessMessage[] = [];
  let assistant: HarnessMessage | null = null;
  let turnIndex = 0;

  const ensureAssistant = (seed?: string): HarnessMessage => {
    if (assistant && !assistant.info.finish) return assistant;
    turnIndex += 1;
    const messageId = `${sessionId}_runtime_turn_${seed ?? turnIndex}`;
    assistant = {
      info: { id: messageId, role: "assistant", sessionID: sessionId },
      parts: [],
    };
    messages.push(assistant);
    return assistant;
  };

  const appendPartText = (message: HarnessMessage, kind: "text" | "thinking", text: string) => {
    if (!text) return;
    const partId = `${message.info.id}_${kind}`;
    const existing = message.parts.find((part) => part.id === partId);
    if (existing && "text" in existing) {
      existing.text = `${existing.text}${text}`;
      return;
    }
    message.parts.push({
      id: partId,
      messageID: message.info.id,
      sessionID: sessionId,
      type: kind,
      text,
    });
  };

  const upsertToolPart = (message: HarnessMessage, ev: RuntimeAgentEvent) => {
    const toolId = runtimeToolId(ev);
    const partId = `${message.info.id}_${toolId}`;
    const name = typeof ev.name === "string" ? ev.name : "tool";
    const statusValue = runtimeToolStatus(ev);
    const existing = message.parts.find((part) => part.id === partId && part.type === "tool");
    if (existing && existing.type === "tool") {
      existing.tool = existing.tool || name;
      existing.state = {
        ...existing.state,
        status: statusValue,
        input: existing.state.input ?? ev.input,
        output: ev.output ?? existing.state.output,
        error: ev.error ?? existing.state.error,
      };
      return;
    }
    message.parts.push({
      id: partId,
      messageID: message.info.id,
      sessionID: sessionId,
      type: "tool",
      tool: name,
      state: {
        status: statusValue,
        input: ev.input,
        output: ev.output,
        error: ev.error,
      },
    });
  };

  events.forEach((ev, index) => {
    const type = normalizedRuntimeEventType(ev);
    const seed = typeof ev.id === "string" && ev.id ? ev.id : String(index);

    if (type === "user.message") {
      const text = runtimeUserText(ev);
      if (text) {
        messages.push(makeTextMessage(sessionId, "user", `${sessionId}_user_${seed}`, text));
      }
      assistant = null;
      return;
    }

    if (type === "session.status_idle") {
      if (assistant) assistant.info.finish = "stop";
      assistant = null;
      return;
    }

    if (type === "session.status") {
      const eventStatus = ev.status;
      const statusType =
        typeof eventStatus === "string"
          ? eventStatus
          : eventStatus && typeof eventStatus === "object"
            ? (eventStatus as { type?: unknown }).type
            : undefined;
      if (statusType === "busy" || statusType === "running") {
        ensureAssistant(seed);
      }
      if (statusType === "idle" && assistant) {
        assistant.info.finish = "stop";
        assistant = null;
      }
      return;
    }

    if (isRuntimeTurnStartEvent(type)) {
      ensureAssistant(seed);
      return;
    }

    if (type === "session.error") {
      const message = ensureAssistant(seed);
      appendPartText(message, "text", `Error: ${runtimeErrorMessage(ev)}`);
      message.info.finish = "stop";
      return;
    }

    if (isRuntimeToolEvent(type)) {
      upsertToolPart(ensureAssistant(seed), ev);
      return;
    }

    if (!isRuntimeAssistantTextEvent(type) && !isRuntimeThinkingEvent(type)) return;
    const text = runtimeEventText(ev);
    if (!text && type !== "content_block_start") return;
    appendPartText(
      ensureAssistant(seed),
      isRuntimeThinkingEvent(type) ? "thinking" : runtimeEventPartKind(ev),
      text,
    );
  });

  if (status === "busy" && (messages.length === 0 || messages.at(-1)?.info.role === "user" || assistant === null)) {
    ensureAssistant("pending");
  }

  if (status === "idle") {
    const lastAssistant = messages.findLast((message) => message.info.role === "assistant" && !message.info.finish);
    if (lastAssistant) lastAssistant.info.finish = "stop";
  }
  return messages;
}

function runtimeStatusFromEvents(events: RuntimeAgentEvent[]): "idle" | "busy" | null {
  let next: "idle" | "busy" | null = null;
  for (const ev of events) {
    const type = normalizedRuntimeEventType(ev);
    if (isLocalRuntimeUserEvent(ev)) {
      next = "busy";
      continue;
    }
    if (isRuntimeTurnStartEvent(type)) {
      next = "busy";
      continue;
    }
    if (type === "session.status_idle" || type === "session.thread_status_idle" || type === "session.error") {
      next = "idle";
      continue;
    }
    if (type === "session.status") {
      const status = ev.status;
      const statusType =
        typeof status === "string"
          ? status
          : status && typeof status === "object"
            ? (status as { type?: unknown }).type
            : undefined;
      if (statusType === "busy" || statusType === "running") next = "busy";
      if (statusType === "idle" || statusType === "error" || statusType === "failed") next = "idle";
    }
  }
  return next;
}

function runtimeSessionStatusFromMetadata(status?: string, providerRunId?: unknown): "idle" | "busy" {
  if (status === "starting" || status === "running" || status === "busy") return "busy";
  if (status === "idle" || status === "error" || status === "completed" || status === "failed") return "idle";
  if (typeof providerRunId === "string" && providerRunId.trim()) return "busy";
  return "idle";
}

function ChatInner() {
  const sp = useSearchParams();
  const sid = sp.get("id");
  const autostartPrompt = sp.get("autostart") === "1" ? sp.get("prompt")?.trim() : "";
  const [messages, setMessages] = useState<HarnessMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [model, setModel] = useState(FALLBACK_MODELS[0]);
  const [sessionStatus, setSessionStatus] = useState<"idle" | "busy">("idle");
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const eventBufferRef = useRef<Frame[]>([]);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeAgentEvent[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [interruptingQueuedPromptId, setInterruptingQueuedPromptId] = useState<string | null>(null);
  const [runtimeStreamVersion, setRuntimeStreamVersion] = useState(0);
  const [sessionHarness, setSessionHarness] = useState<string>("claude-code");
  const [sessionRuntime, setSessionRuntime] = useState<AgentRuntimeId | undefined>();
  const [harnesses, setHarnesses] = useState<RuntimeHarness[]>([]);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [providerSessionId, setProviderSessionId] = useState<string | undefined>();
  const [providerUrl, setProviderUrl] = useState<string | undefined>();
  const [sessionTitle, setSessionTitle] = useState<string>("");
  const [savedAgents, setSavedAgents] = useState<Agent[]>([]);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const activeSessionRef = useRef<string | null>(null);
  const autostartedRef = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    if (!sid) return;
    try {
      const sessionId = sid;
      const list = await getMessages(sid);
      if (activeSessionRef.current !== sessionId) return;
      setMessages(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sid]);

  const router = useRouter();

  const activeAgent = useMemo(() => {
    const target = sessionHarness || sessionTitle;
    return (
      savedAgents.find((a) => a.id === target) ??
      savedAgents.find((a) => a.name === target) ??
      savedAgents.find((a) => sessionTitle && a.name === sessionTitle) ??
      null
    );
  }, [savedAgents, sessionHarness, sessionTitle]);

  const activePrompt = agentPrompt(activeAgent);
  const activeAgentName =
    activeAgent?.name || sessionTitle || BUILTIN_AGENTS[sessionHarness] || sessionHarness;
  const baseRuntime =
    sessionRuntime
      ? runtimeLabel(sessionRuntime)
      : String(activeAgent?.harness ?? activeAgent?.base_agent ?? sessionHarness ?? "claude-code");
  const providerLink = providerSessionUrl(sessionRuntime, providerSessionId, providerUrl);
  const skills = Array.isArray(activeAgent?.skills) ? activeAgent.skills : [];
  const vaultKeys = Array.isArray(activeAgent?.vault_keys) ? activeAgent.vault_keys : [];
  const runtimeMessages = useMemo(() => {
    if (!sid || !sessionRuntime) return null;
    return runtimeEventsToMessages(sid, runtimeEvents, sessionStatus);
  }, [runtimeEvents, sessionRuntime, sessionStatus, sid]);
  const displayMessages = useMemo(() => {
    const baseMessages = sessionRuntime ? runtimeMessages : messages;
    if (!sid || !sessionRuntime || queuedPrompts.length === 0) return baseMessages;
    return [
      ...(baseMessages ?? []),
      ...queuedPrompts.map((prompt) => makeQueuedPromptMessage(sid, prompt)),
    ];
  }, [messages, queuedPrompts, runtimeMessages, sessionRuntime, sid]);
  const hasStarted = Boolean(displayMessages && displayMessages.length > 0);
  const modelOptions = useMemo(() => {
    const runtimeModel = runtimeModelId(sessionRuntime, harnesses);
    return runtimeModel ? [runtimeModel, ...models.filter((item) => item !== runtimeModel)] : models;
  }, [models, sessionRuntime, harnesses]);

  const onCopyPrompt = useCallback(() => {
    if (!activePrompt) return;
    navigator.clipboard?.writeText(activePrompt).then(() => {
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1400);
    }).catch(() => {});
  }, [activePrompt]);

  useEffect(() => {
    listModels().then((fetched) => {
      if (fetched.length > 0) {
        setModels(fetched);
        setModel((prev) => (fetched.includes(prev) ? prev : fetched[0]));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const runtimeModel = runtimeModelId(sessionRuntime, harnesses);
    if (runtimeModel) setModel(runtimeModel);
  }, [models, sessionRuntime, harnesses]);

  // Fetch session metadata to get the locked agent
  useEffect(() => {
    if (!sid) return;
    activeSessionRef.current = sid;
    eventBufferRef.current = [];
    setMessages(null);
    setRuntimeEvents([]);
    setQueuedPrompts([]);
    setInterruptingQueuedPromptId(null);
    setError(null);
    setSessionLoaded(false);
    setProviderSessionId(undefined);
    setProviderUrl(undefined);
    setSessionTitle("");
    getSession(sid).then(s => {
      if (activeSessionRef.current !== sid) return;
      const a = s.agent_id ?? s.agent ?? s.harness;
      if (a) setSessionHarness(a);
      setSessionRuntime(s.runtime);
      setSessionStatus(
        s.runtime ? runtimeSessionStatusFromMetadata(s.status, s.provider_run_id) : s.status === "running" ? "busy" : "idle",
      );
      setProviderSessionId(s.provider_session_id);
      setProviderUrl(s.provider_url);
      if (s.title) setSessionTitle(s.title);
    }).catch(() => {}).finally(() => {
      if (activeSessionRef.current === sid) setSessionLoaded(true);
    });
  }, [sid]);

  // Fetch saved agents for dropdown
  useEffect(() => {
    listAgents().then(setSavedAgents).catch(() => {});
    listRuntimeHarnesses().then(setHarnesses).catch(() => {});
  }, []);

  const onHarnessChange = useCallback(async (next: string) => {
    if (!sid || next === sessionHarness) return;
    setSwitchingAgent(true);
    setError(null);
    try {
      if (!hasStarted) await deleteSession(sid).catch(() => {});
      const options = next.startsWith("agent_") && sessionRuntime ? { runtime: sessionRuntime } : undefined;
      const s = await createSession(undefined, next, options);
      router.replace(`/chat/?id=${encodeURIComponent(s.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch agent");
      setSwitchingAgent(false);
    }
  }, [hasStarted, sid, sessionHarness, sessionRuntime, router]);

  const mergeRuntimeEventsAndStatus = useCallback((events: RuntimeAgentEvent | RuntimeAgentEvent[]) => {
    setRuntimeEvents((prev) => {
      const next = mergeRuntimeEventList(prev, events);
      const eventStatus = runtimeStatusFromEvents(next);
      if (eventStatus) setSessionStatus(eventStatus);
      return next;
    });
  }, []);

  const appendRuntimeEvent = useCallback((ev: RuntimeAgentEvent) => {
    eventBufferRef.current = [
      ...eventBufferRef.current.slice(-499),
      { ts: Date.now(), ev: ev as Frame["ev"] },
    ];

    const type = normalizedRuntimeEventType(ev);
    if (isRuntimeTurnStartEvent(type)) {
      setSessionStatus("busy");
    } else if (type === "session.status_idle") {
      setSessionStatus("idle");
    } else if (type === "session.status") {
      const status = ev.status;
      const statusType =
        typeof status === "string"
          ? status
          : status && typeof status === "object"
            ? (status as { type?: unknown }).type
            : undefined;
      if (statusType === "busy" || statusType === "running") setSessionStatus("busy");
      if (statusType === "idle") setSessionStatus("idle");
    } else if (type === "session.error") {
      setError(`Error: ${runtimeErrorMessage(ev)}`);
      setSessionStatus("idle");
    } else if (
      type === "user.message" ||
      isRuntimeAssistantTextEvent(type) ||
      isRuntimeThinkingEvent(type) ||
      isRuntimeToolEvent(type)
    ) {
      setSessionStatus((current) => (current === "busy" ? current : "busy"));
    }

    mergeRuntimeEventsAndStatus(ev);
  }, [mergeRuntimeEventsAndStatus]);

  const beginRuntimeTurn = useCallback((text?: string) => {
    if (!sessionRuntime || !sid) return;
    const trimmed = text?.trim();
    if (trimmed) {
      appendRuntimeEvent({
        id: `${sid}_local_user_${Date.now().toString(36)}`,
        type: "user.message",
        local: true,
        content: [{ type: "text", text: trimmed }],
      });
    }
    setSessionStatus("busy");
  }, [appendRuntimeEvent, sessionRuntime, sid]);

  const queueRuntimePrompt = useCallback((text: string) => {
    if (!sid) return;
    setQueuedPrompts((current) => [
      ...current,
      {
        id: `${sid}_queued_${Date.now().toString(36)}_${current.length}`,
        text,
      },
    ]);
  }, [sid]);

  const sendOrQueueRuntimePrompt = useCallback(async (text: string) => {
    if (!sid) return;
    if (sessionStatus === "busy") {
      queueRuntimePrompt(text);
      return;
    }
    sendMessageWithRuntimeModel({
      sessionId: sid,
      text,
      model,
      runtime: sessionRuntime,
      apiSpec: resolveApiSpec(sessionRuntime ?? "", harnesses),
    }).catch((err) => {
      if (activeSessionRef.current !== sid) return;
      setError(err instanceof Error ? err.message : String(err));
      setSessionStatus("idle");
    });
  }, [model, queueRuntimePrompt, sessionRuntime, sessionStatus, sid, harnesses]);

  const cancelQueuedPrompt = useCallback((id: string) => {
    setQueuedPrompts((current) => current.filter((prompt) => prompt.id !== id));
  }, []);

  const interruptAndSendQueuedPrompt = useCallback(async (id: string) => {
    if (!sid || !sessionRuntime || interruptingQueuedPromptId) return;
    const prompt = queuedPrompts.find((item) => item.id === id);
    if (!prompt) return;

    setError(null);
    setInterruptingQueuedPromptId(id);
    try {
      if (sessionStatus === "busy") {
        await interruptSession(sid);
      }
      if (activeSessionRef.current !== sid) return;
      setQueuedPrompts((current) => current.filter((item) => item.id !== id));
      beginRuntimeTurn(prompt.text);
      await sendMessageWithRuntimeModel({
        sessionId: sid,
        text: prompt.text,
        model,
        runtime: sessionRuntime,
        apiSpec: resolveApiSpec(sessionRuntime ?? "", harnesses),
      });
      if (activeSessionRef.current === sid) {
        setRuntimeStreamVersion((version) => version + 1);
      }
    } catch (err) {
      if (activeSessionRef.current !== sid) return;
      setError(err instanceof Error ? err.message : String(err));
      setSessionStatus("idle");
    } finally {
      if (activeSessionRef.current === sid) {
        setInterruptingQueuedPromptId(null);
      }
    }
  }, [
    beginRuntimeTurn,
    harnesses,
    interruptingQueuedPromptId,
    model,
    queuedPrompts,
    sessionRuntime,
    sessionStatus,
    sid,
  ]);

  useEffect(() => {
    if (!sid || !sessionLoaded) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    if (sessionRuntime) {
      listRuntimeEvents(sid)
        .then((events) => {
          if (activeSessionRef.current !== sid) return;
          eventBufferRef.current = events.slice(-500).map((ev) => ({ ts: Date.now(), ev: ev as Frame["ev"] }));
          mergeRuntimeEventsAndStatus(events);
          if (cancelled || runtimeStatusFromEvents(events) === "idle") return;
          unsub = subscribeRuntimeEvents({
            sessionId: sid,
            onEvent: (ev) => {
              if (activeSessionRef.current === sid) appendRuntimeEvent(ev);
            },
            onError: (err) => {
              if (activeSessionRef.current === sid) {
                setError(err instanceof Error ? err.message : String(err));
              }
            },
          });
        })
        .catch((err) => {
          if (activeSessionRef.current !== sid) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    } else {
      void refetch();
    }
    if (autostartPrompt && autostartedRef.current !== sid) {
      autostartedRef.current = sid;
      beginRuntimeTurn(autostartPrompt);
      void sendMessageWithRuntimeModel({
        sessionId: sid,
        text: autostartPrompt,
        model,
        runtime: sessionRuntime,
        apiSpec: resolveApiSpec(sessionRuntime ?? "", harnesses),
      })
        .then(() => {
          if (activeSessionRef.current !== sid) return;
          if (!sessionRuntime) return refetch();
        })
        .then(() => router.replace(`/chat/?id=${encodeURIComponent(sid)}`))
        .catch((err) => {
          if (activeSessionRef.current !== sid) return;
          setError(err instanceof Error ? err.message : String(err));
          setSessionStatus("idle");
        });
    }
    listApprovals().then(setApprovals).catch(() => {});
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [sid, sessionLoaded, refetch, appendRuntimeEvent, mergeRuntimeEventsAndStatus, autostartPrompt, beginRuntimeTurn, model, router, sessionRuntime, runtimeStreamVersion, harnesses]);

  useEffect(() => {
    if (!sid || !sessionRuntime || sessionStatus !== "busy") return;
    let active = true;
    const replay = () => {
      listRuntimeEvents(sid)
        .then((events) => {
          if (!active) return;
          if (activeSessionRef.current !== sid) return;
          mergeRuntimeEventsAndStatus(events);
        })
        .catch((err) => {
          if (active && activeSessionRef.current === sid) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    };
    replay();
    const timer = window.setInterval(replay, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [mergeRuntimeEventsAndStatus, sid, sessionRuntime, sessionStatus]);

  const onApprovalAccept = useCallback(async (id: string, args: Record<string, unknown>) => {
    setApprovalBusy(true);
    try {
      await acceptApproval(id, args);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApprovalBusy(false);
    }
  }, []);

  const onApprovalReject = useCallback(async (id: string, feedback: string) => {
    setApprovalBusy(true);
    try {
      await rejectApproval(id, feedback);
      setApprovals((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApprovalBusy(false);
    }
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - (el.scrollTop + el.clientHeight);
    wasNearBottomRef.current = dist < 120;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [displayMessages]);

  if (!sid) {
    return <SessionsPage />;
  }

  const shortSid = sid.length > 12 ? sid.slice(0, 12) + "…" : sid;

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar activeId={sid} />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-2">
            {sessionTitle && (
              <span className="text-sm font-medium" title={sessionTitle}>{sessionTitle}</span>
            )}
            <span className="text-xs font-mono text-muted-foreground">{shortSid}</span>
            {sessionStatus === "busy" ? (
              <button
                onClick={() => sid && abortSession(sid).catch(() => {})}
                className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 font-mono hover:text-red-600 dark:hover:text-red-400 transition-colors group"
                title="Abort agent"
                aria-label="Agent busy — click to abort"
              >
                <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none group-hover:hidden" />
                <Square className="w-3 h-3 hidden group-hover:block fill-current" />
                <span className="group-hover:hidden">busy</span>
                <span className="hidden group-hover:inline">abort</span>
              </button>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                idle
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">agent</span>
              <Select
                value={sessionHarness}
                onValueChange={(v) => v && onHarnessChange(v)}
                disabled={switchingAgent || sessionStatus === "busy"}
              >
                <SelectTrigger className="h-8 text-xs w-[190px]">
                  <SelectValue placeholder={activeAgentName} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opencode" className="text-xs font-mono">opencode</SelectItem>
                  <SelectItem value="claude-code" className="text-xs font-mono">claude code</SelectItem>
                  <SelectItem value="github-copilot" className="text-xs font-mono">github copilot</SelectItem>
                  {savedAgents.length > 0 && (
                    <>
                      <div className="px-2 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider border-t mt-1 pt-2">Saved agents</div>
                      {savedAgents.map(a => (
                        <SelectItem key={a.id} value={a.id} className="text-xs font-mono">{a.name}</SelectItem>
                      ))}
                    </>
                  )}
                  <div className="px-2 py-2 text-[10px] text-muted-foreground border-t mt-1">
                    Switching agents opens a new session.
                  </div>
                </SelectContent>
              </Select>
              {switchingAgent && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none text-muted-foreground" />}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">model</span>
              <ModelSelect value={model} models={modelOptions} onValueChange={setModel} />
            </div>
            {providerLink && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                render={
                  <a href={providerLink} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />
                    Open provider session
                  </a>
                }
              />
            )}
            <Button
              variant={inspectorOpen ? "default" : "outline"}
              size="sm"
              onClick={() => setInspectorOpen((v) => !v)}
              className="h-8"
            >
              <Activity className="size-3.5" />
              Inspect
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8">
            {!displayMessages && !error && (
              <div className="text-muted-foreground text-sm">Loading…</div>
            )}
            {error && (
              <Card className="border-destructive p-4">
                <p className="text-sm text-destructive">{error}</p>
              </Card>
            )}
            <Card className="gap-0 overflow-hidden rounded-lg border border-border/80 bg-card/80 py-0 ring-0">
              <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
                <section className="min-w-0 border-b border-border/70 p-4 md:border-b-0 md:border-r">
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                      <Bot className="size-4 text-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-semibold tracking-tight leading-5">{activeAgentName}</h2>
                        {activePrompt ? (
                          <span className="inline-flex h-5 items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="size-3" />
                            prompt active
                          </span>
                        ) : (
                          <span className="inline-flex h-5 items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="size-3" />
                            no saved prompt
                          </span>
                        )}
                      </div>
                      {activeAgent?.description ? (
                        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                          {String(activeAgent.description)}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          Session instructions and runtime context are shown before the transcript.
                        </p>
                      )}
                      <div className="mt-3 grid gap-1.5 text-[11px] sm:grid-cols-2">
                        <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1.5">
                          <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="text-muted-foreground">runtime</span>
                          <span className="ml-auto truncate font-mono text-foreground">{baseRuntime}</span>
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1.5">
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="text-muted-foreground">session</span>
                          <span className="ml-auto truncate font-mono text-foreground">{shortSid}</span>
                        </div>
                        {providerLink && (
                          <a
                            href={providerLink}
                            target="_blank"
                            rel="noreferrer"
                            className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1.5 hover:bg-muted"
                          >
                            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="text-muted-foreground">provider</span>
                            <span className="ml-auto truncate font-mono text-foreground">
                              {providerSessionId ?? "open"}
                            </span>
                          </a>
                        )}
                      </div>
                      {(skills.length > 0 || vaultKeys.length > 0) && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {skills.map((skill) => (
                            <span
                              key={skill}
                              className="inline-flex h-5 items-center gap-1 rounded-md border border-sky-500/25 bg-sky-500/10 px-1.5 font-mono text-[10px] text-sky-600 dark:text-sky-400"
                            >
                              <Wrench className="size-3" />
                              {skill}
                            </span>
                          ))}
                          {vaultKeys.map((key) => (
                            <span
                              key={key}
                              className="inline-flex h-5 items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 font-mono text-[10px] text-amber-600 dark:text-amber-400"
                            >
                              <KeyRound className="size-3" />
                              {key}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                <section className="min-w-0 bg-background/35 p-4">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0">
                      <h3 className="text-[13.5px] font-semibold tracking-tight">System prompt</h3>
                      <div className="text-[11px] text-muted-foreground">
                        {activePrompt ? "Visible before the first turn runs." : "No reusable agent prompt is attached."}
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        disabled={!activePrompt}
                        onClick={onCopyPrompt}
                        aria-label="Copy system prompt"
                        title="Copy system prompt"
                      >
                        {promptCopied ? <ClipboardCheck className="size-3.5" /> : <Clipboard className="size-3.5" />}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => setPromptOpen((v) => !v)}
                        disabled={!activePrompt}
                        title={promptOpen ? "Collapse system prompt" : "Expand system prompt"}
                      >
                        <span>{promptOpen ? "Full" : "Preview"}</span>
                        <ChevronDown className={`size-3.5 transition-transform ${promptOpen ? "rotate-180" : ""}`} />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3">
                    {activePrompt ? (
                      promptOpen ? (
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground">
                          {activePrompt}
                        </pre>
                      ) : (
                        <div className="rounded-md border border-border bg-background p-3">
                          <p className="line-clamp-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
                            {shortPrompt(activePrompt)}
                          </p>
                        </div>
                      )
                    ) : (
                      <div className="rounded-md border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                        {activeAgent
                          ? "This saved agent will run without a stored system prompt until one is added on the Agents page."
                          : "This is a built-in runtime session, so there is no saved agent prompt to review."}
                      </div>
                    )}
                  </div>
                  {promptCopied && (
                    <div className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                      Copied system prompt.
                    </div>
                  )}
                </section>
              </div>
            </Card>
            {displayMessages && displayMessages.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <Bot className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No messages yet.</p>
                <p className="text-xs text-muted-foreground">Type a message below to start the conversation.</p>
              </div>
            )}
            {displayMessages?.map((m, i) => (
              <MessageBlock
                key={(m.info.id as string | undefined) ?? i}
                msg={m}
                onCancelQueued={cancelQueuedPrompt}
                onSendQueued={interruptAndSendQueuedPrompt}
                queuedActionBusy={interruptingQueuedPromptId === m.info.id}
              />
            ))}
            {approvals.map((a) => (
              <ToolApprovalPanel
                key={a.id}
                approval={a}
                onAccept={onApprovalAccept}
                onReject={onApprovalReject}
                busy={approvalBusy}
              />
            ))}
          </div>
        </div>

        <Composer
          sessionId={sid}
          model={model}
          onSent={sessionRuntime ? undefined : refetch}
          onSend={sessionRuntime ? sendOrQueueRuntimePrompt : undefined}
          onSendStart={sessionRuntime ? (text) => {
            if (sessionStatus !== "busy") beginRuntimeTurn(text);
          } : undefined}
          onAbort={sessionRuntime ? () => abortSession(sid).catch(() => {}) : undefined}
          busy={Boolean(sessionRuntime && sessionStatus === "busy")}
        />
      </div>

      <InspectorPanel
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        sessionId={sid}
        initialFrames={eventBufferRef.current}
      />
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
          Loading…
        </div>
      }
    >
      <ChatInner />
    </Suspense>
  );
}
