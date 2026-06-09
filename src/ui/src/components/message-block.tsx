"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Globe,
  Loader2,
  Search,
  Send,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { BrandIcon } from "@/components/brand-icons";
import type { HarnessMessage, HarnessMessagePart } from "@/lib/types";

// Adapter: derive the local-message shape LAP's components consume from our
// HarnessMessage (which carries info + parts). Sub-threads / permissions /
// attachments are not supported here.
interface LocalMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  parts: HarnessMessagePart[];
  status?: "queued" | "in_progress" | "completed" | "failed";
  error?: string;
  latency_ms?: number;
  model?: string;
  harness?: string;
  tokens?: { input: number; output: number; total: number; cache?: { read: number; write: number } };
  cost?: number;
}

type RenderItem =
  | { type: "part"; part: HarnessMessagePart; key: string }
  | { type: "toolGroup"; parts: HarnessMessagePart[]; key: string };

function toLocal(m: HarnessMessage): LocalMessage {
  const role = m.info.role;
  const parts = Array.isArray(m.parts) ? m.parts : [];
  const text = parts
    .filter((p): p is Extract<HarnessMessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  let status: LocalMessage["status"];
  let latency_ms: number | undefined;
  const infoStatus = (m.info as Record<string, unknown>).status;
  if (
    infoStatus === "queued" ||
    infoStatus === "in_progress" ||
    infoStatus === "completed" ||
    infoStatus === "failed"
  ) {
    status = infoStatus;
  }
  if (role === "assistant") {
    const finish = m.info.finish;
    if (status) {
      status = status;
    } else if (!finish) {
      status = "in_progress";
    } else if (finish === "stop" || finish === "end_turn") {
      status = "completed";
    } else {
      status = "completed";
    }
    const created = m.info.time?.created;
    const completed = m.info.time?.completed;
    if (typeof created === "number" && typeof completed === "number") {
      latency_ms = completed - created;
    }
  }
  const providerID = (m.info as Record<string, unknown>).providerID as string | undefined;
  const modelID = (m.info as Record<string, unknown>).modelID as string | undefined;
  const model = providerID && modelID ? `${providerID}/${modelID}` : modelID;
  const infoRecord = m.info as Record<string, unknown>;
  const harness = (infoRecord.agent ?? infoRecord.harness) as string | undefined;
  const tokens = (m.info as Record<string, unknown>).tokens as LocalMessage["tokens"] | undefined;
  const cost = (m.info as Record<string, unknown>).cost as number | undefined;

  return {
    id: (m.info.id as string | undefined) ?? "",
    role,
    text,
    parts,
    status,
    latency_ms,
    model,
    harness,
    tokens,
    cost,
  };
}

function InnerMessageBlock({
  msg,
  isFirstUser,
  onCancelQueued,
  onSendQueued,
  queuedActionBusy,
}: {
  msg: LocalMessage;
  isFirstUser: boolean;
  onCancelQueued?: (msgId: string) => void;
  onSendQueued?: (msgId: string) => void;
  queuedActionBusy?: boolean;
}) {
  if (msg.role === "user") {
    return (
      <UserPromptBlock
        id={msg.id}
        content={msg.text ?? ""}
        emphasized={isFirstUser}
        status={msg.status}
        onCancelQueued={onCancelQueued}
        onSendQueued={onSendQueued}
        queuedActionBusy={queuedActionBusy}
      />
    );
  }
  return (
    <AssistantBlock
      msg={msg}
      onCancelQueued={onCancelQueued}
      onSendQueued={onSendQueued}
      queuedActionBusy={queuedActionBusy}
    />
  );
}

function UserPromptBlock({
  id,
  content,
  emphasized,
  status,
  onCancelQueued,
  onSendQueued,
  queuedActionBusy,
}: {
  id: string;
  content: string;
  emphasized: boolean;
  status?: LocalMessage["status"];
  onCancelQueued?: (msgId: string) => void;
  onSendQueued?: (msgId: string) => void;
  queuedActionBusy?: boolean;
}) {
  const queued = status === "queued";
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[min(740px,82%)] flex-col items-end gap-1.5">
        <div
          className={`w-full rounded-[18px] border border-border/80 bg-muted/65 px-5 py-3 text-[15px] leading-relaxed text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:bg-muted/45 ${
            emphasized ? "ring-1 ring-ring/30" : ""
          } ${queued ? "opacity-75" : ""}`}
        >
          {content && <div className="whitespace-pre-wrap">{content}</div>}
        </div>
        {queued && (
          <div className="flex items-center gap-1.5 pr-1 text-[12px] text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
            queued
            {onSendQueued && (
              <button
                type="button"
                onClick={() => onSendQueued(id)}
                disabled={queuedActionBusy}
                title="Interrupt active run and send queued message"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                aria-label="Interrupt active run and send queued message"
              >
                {queuedActionBusy ? (
                  <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Send className="size-3" />
                )}
                <span>Interrupt and send</span>
              </button>
            )}
            {onCancelQueued && (
              <button
                type="button"
                onClick={() => onCancelQueued(id)}
                disabled={queuedActionBusy}
                title="Cancel queued message"
                className="rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                aria-label="Cancel queued message"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantBlock({
  msg,
  onCancelQueued,
  onSendQueued,
  queuedActionBusy,
}: {
  msg: LocalMessage;
  onCancelQueued?: (msgId: string) => void;
  onSendQueued?: (msgId: string) => void;
  queuedActionBusy?: boolean;
}) {
  const failed = msg.status === "failed";
  const inProgress = msg.status === "in_progress";
  const queued = msg.status === "queued";
  const parts = msg.parts ?? [];

  const visibleParts = parts.filter((p) => {
    const t = typeof p?.type === "string" ? (p.type as string) : "";
    return (
      t === "text" ||
      t === "reasoning" ||
      t === "thinking" ||
      t === "tool" ||
      t === "image"
    );
  });
  const renderItems = groupRenderItems(visibleParts);
  const details = messageDetails(msg);

  return (
    <article className="group/turn flex flex-col gap-3 py-1">
      {failed && msg.text ? (
        <div
          className="sessions-md max-w-[920px] text-[15px] leading-7 text-red-600 dark:text-red-400"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
        </div>
      ) : queued ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground leading-relaxed">
          <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
          queued
          {onSendQueued && (
            <button
              type="button"
              onClick={() => onSendQueued(msg.id)}
              disabled={queuedActionBusy}
              title="Interrupt active run and send queued message"
              className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              aria-label="Interrupt active run and send queued message"
            >
              {queuedActionBusy ? (
                <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
              ) : (
                <Send className="size-3" />
              )}
              <span>Interrupt and send</span>
            </button>
          )}
          {onCancelQueued && (
            <button
              type="button"
              onClick={() => onCancelQueued(msg.id)}
              disabled={queuedActionBusy}
              title="Cancel queued message"
              className="ml-1 p-0.5 rounded hover:bg-muted hover:text-foreground transition-colors disabled:pointer-events-none disabled:opacity-50"
              aria-label="Cancel queued message"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ) : inProgress && visibleParts.length === 0 ? (
        msg.text ? (
          <div className="sessions-md max-w-[920px] text-[15px] leading-7 text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[14px] text-muted-foreground leading-relaxed">
            <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" />
            thinking…
          </div>
        )
      ) : (
        <>
          {renderItems.map((item) =>
            item.type === "toolGroup" ? (
              <ToolCluster key={item.key} parts={item.parts} />
            ) : (
              <PartBlock key={item.key} part={item.part} />
            ),
          )}
          {inProgress && (
            <div className="flex items-center gap-1.5 pt-1">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-pulse motion-reduce:animate-none" />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-pulse motion-reduce:animate-none [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-pulse motion-reduce:animate-none [animation-delay:300ms]" />
            </div>
          )}
        </>
      )}

      {failed && msg.error && (
        <div className="mono text-[11px] text-red-600 dark:text-red-400">{msg.error}</div>
      )}

      {!inProgress && !failed && (
        <div className="mono flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground/75 transition-colors group-hover/turn:text-muted-foreground">
          {msg.harness && (
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-mono font-medium ${
              msg.harness === "github-copilot"
                ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                : msg.harness === "claude-code"
                  ? "bg-orange-500/15 text-orange-600 dark:text-orange-400"
                  : "bg-muted text-muted-foreground"
            }`}>
              {msg.harness}
            </span>
          )}
          {details.map((detail) => (
            <span key={detail}>{detail}</span>
          ))}
        </div>
      )}
    </article>
  );
}

function groupRenderItems(parts: HarnessMessagePart[]): RenderItem[] {
  const items: RenderItem[] = [];
  let toolRun: HarnessMessagePart[] = [];

  const flushTools = () => {
    if (toolRun.length === 0) return;
    items.push({
      type: "toolGroup",
      parts: toolRun,
      key: `tools-${items.length}`,
    });
    toolRun = [];
  };

  parts.forEach((part, index) => {
    const t = typeof part?.type === "string" ? part.type : "";
    if (t === "tool") {
      toolRun.push(part);
      return;
    }
    flushTools();
    items.push({ type: "part", part, key: `${t || "part"}-${index}` });
  });
  flushTools();

  return items;
}

function messageDetails(msg: LocalMessage): string[] {
  const details: string[] = [];
  if (msg.model) details.push(msg.model);
  if (typeof msg.latency_ms === "number") details.push(formatLatency(msg.latency_ms));
  if (msg.tokens) {
    const tokenText = `↑${msg.tokens.input.toLocaleString()} ↓${msg.tokens.output.toLocaleString()}`;
    const cacheText = msg.tokens.cache && msg.tokens.cache.read > 0
      ? ` cache ${msg.tokens.cache.read.toLocaleString()}`
      : "";
    details.push(tokenText + cacheText);
  }
  if (typeof msg.cost === "number" && msg.cost > 0) details.push(`$${msg.cost.toFixed(4)}`);
  return details;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function PartBlock({ part }: { part: HarnessMessagePart }) {
  const t = typeof part?.type === "string" ? part.type : "";
  if (t === "text") {
    const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
    if (!text) return null;
    return (
      <div className="sessions-md max-w-[920px] text-[15px] leading-7 text-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }
  if (t === "reasoning" || t === "thinking") {
    const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
    if (!text) return null;
    return <ReasoningBlock text={text} />;
  }
  if (t === "tool") {
    return <ToolBlock part={part} />;
  }
  return null;
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 360 ? text.slice(0, 360) + "…" : text;
  return (
    <div className="max-w-[920px] border-l-2 border-border pl-3 text-[13px] text-muted-foreground italic leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Collapse reasoning" : "Expand reasoning"}
        aria-expanded={open}
        className="flex items-start gap-1 text-left hover:text-foreground"
      >
        <ChevronDown
          className={`w-3 h-3 mt-1 shrink-0 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="whitespace-pre-wrap">{open ? text : preview}</span>
      </button>
    </div>
  );
}

function toolDescriptor(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const n = tool.toLowerCase();
  if (n === "task") return pick("description");
  if (n === "bash") return pick("command", "description");
  if (n.includes("gmail")) return pick("subject", "to", "thread_id", "message_id");
  if (n.includes("pylon") || n.includes("linear")) return pick("issue_id", "title", "state");
  if (n.includes("read") || n.includes("edit") || n.includes("write") || n.includes("patch"))
    return pick("filePath", "file_path", "path");
  if (n.includes("grep") || n.includes("glob") || n.includes("find"))
    return pick("pattern", "query");
  return "";
}

function toolLabel(tool: string): string {
  return tool
    .replace(/^mcp__/i, "")
    .replace(/^functions\s+/i, "")
    .replace(/^mcp\s+/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toolBrand(tool: string): string | null {
  const n = tool.toLowerCase();
  if (n.includes("gmail")) return "gmail";
  if (n.includes("pylon")) return "pylon";
  if (n.includes("linear")) return "linear";
  return null;
}

function ToolIcon({
  tool,
  status,
}: {
  tool: string;
  status: string;
}) {
  const brand = toolBrand(tool);
  if (brand) {
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-md border border-border bg-background shadow-sm">
        <BrandIcon id={brand} className="size-3.5" />
      </span>
    );
  }

  const n = tool.toLowerCase();
  const Icon = n === "bash"
    ? Terminal
    : n.includes("read") || n.includes("write") || n.includes("edit")
      ? FileText
      : n.includes("grep") || n.includes("search") || n.includes("find")
        ? Search
        : n.includes("web") || n.includes("browser")
          ? Globe
          : status === "error"
            ? CircleAlert
            : Wrench;

  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground shadow-sm">
      <Icon className="size-3.5" />
    </span>
  );
}

function ToolCluster({ parts }: { parts: HarnessMessagePart[] }) {
  return (
    <div className="max-w-[920px] py-0.5">
      <div className="mb-1 flex items-center gap-2 pl-2">
        <span className="h-px w-5 bg-border" />
        <span className="mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Activity
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {parts.map((part, index) => (
          <ToolBlock key={`${(part as { id?: string }).id ?? "tool"}-${index}`} part={part} />
        ))}
      </div>
    </div>
  );
}

function ToolBlock({ part }: { part: HarnessMessagePart }) {
  const [open, setOpen] = useState(false);
  const p = part as Extract<HarnessMessagePart, { type: "tool" }>;
  const toolName = typeof p.tool === "string" ? p.tool : "tool";
  const state = (p.state as Record<string, unknown> | undefined) ?? {};
  const status = typeof state.status === "string" ? state.status : "running";
  const input = state.input;
  const output = state.output;
  const errorOut = state.error;
  const desc = toolDescriptor(toolName, input);

  const label = toolLabel(toolName);
  const hasDetails =
    input !== undefined || output !== undefined || errorOut !== undefined;

  const statusColor =
    status === "completed"
      ? "text-emerald-600 dark:text-emerald-400"
      : status === "error"
        ? "text-red-600 dark:text-red-400"
        : "text-amber-600 dark:text-amber-400";
  const StatusIcon =
    status === "completed" ? Check : status === "error" ? X : Loader2;
  const statusLabel = status === "completed" ? "done" : status;

  return (
    <div className="max-w-[920px] text-[13px]">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        aria-expanded={hasDetails ? open : undefined}
        className={`inline-flex max-w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left ${
          hasDetails ? "cursor-pointer transition-colors hover:bg-muted/55" : "cursor-default"
        }`}
      >
        <ToolIcon tool={toolName} status={status} />
        <span className="shrink-0 text-[14px] font-medium text-foreground">{label}</span>
        {desc && (
          <span className="mono min-w-0 max-w-[min(38rem,42vw)] truncate text-[12px] text-muted-foreground">{desc}</span>
        )}
        <span className={`mono inline-flex shrink-0 items-center gap-1 rounded-full border border-current/15 px-2 py-0.5 text-[10.5px] ${statusColor}`}>
          <StatusIcon
            className={`size-3 shrink-0 ${status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
          {statusLabel}
        </span>
        {hasDetails && (
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
        )}
      </button>

      {open && hasDetails && (
        <div className="ml-8 mt-1 flex flex-col gap-2 rounded-lg border border-border bg-muted/25 p-3 shadow-sm">
          {input !== undefined && <ToolKv label="input" value={input} />}
          {output !== undefined && <ToolKv label="output" value={output} />}
          {errorOut !== undefined && <ToolKv label="error" value={errorOut} />}
        </div>
      )}
    </div>
  );
}

function ToolKv({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="flex flex-col gap-1">
      <span className="mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <pre className="mono max-h-64 overflow-auto rounded-md border border-border bg-background p-2 text-[11px] text-foreground whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

export function MessageBlock({
  msg,
  onCancelQueued,
  onSendQueued,
  queuedActionBusy,
}: {
  msg: HarnessMessage;
  onCancelQueued?: (msgId: string) => void;
  onSendQueued?: (msgId: string) => void;
  queuedActionBusy?: boolean;
}) {
  const local = toLocal(msg);
  return (
    <InnerMessageBlock
      msg={local}
      isFirstUser={false}
      onCancelQueued={onCancelQueued}
      onSendQueued={onSendQueued}
      queuedActionBusy={queuedActionBusy}
    />
  );
}
