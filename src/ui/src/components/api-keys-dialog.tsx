"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { BrandIcon } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ApiError,
  createGatewayApiKey,
  deleteGatewayApiKey,
  listGatewayApiKeys,
  type CreatedGatewayApiKey,
  type GatewayApiKey,
} from "@/lib/api";

function formatTime(ts?: number | null): string {
  if (!ts) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts * 1000));
}

export function ApiKeysPanel() {
  const [keys, setKeys] = useState<GatewayApiKey[] | null>(null);
  const [label, setLabel] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedGatewayApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = async () => {
    try {
      setKeys(await listGatewayApiKeys());
      setError(null);
    } catch (err) {
      setKeys([]);
      setError(messageForKeyError(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const closeCreate = () => {
    setShowCreate(false);
    setLabel("");
    setCreated(null);
    setFormError(null);
  };

  const create = async () => {
    const name = label.trim();
    if (!name) {
      setFormError("Key name is required.");
      return;
    }
    setCreating(true);
    setCreated(null);
    setFormError(null);
    try {
      const key = await createGatewayApiKey(name);
      setCreated(key);
      await load();
    } catch (err) {
      const message = messageForKeyError(err);
      setFormError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id: string) => {
    setKeys((current) => current?.filter((key) => key.id !== id) ?? null);
    try {
      await deleteGatewayApiKey(id);
    } catch (err) {
      toast.error(messageForKeyError(err));
      await load().catch(() => {});
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Active keys</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Gateway keys that can authenticate CLI and agent traffic.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowCreate(true)}
          disabled={showCreate || Boolean(error)}
        >
          <Plus className="size-4" />
          Create key
        </Button>
      </div>

      {error && (
        <div className="border-b border-border bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {keys === null ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          Loading keys
        </div>
      ) : keys.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          {error ? "Keys cannot be loaded in this local UI-only session." : "No keys yet."}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/20 hover:bg-muted/20">
              <TableHead className="px-4">Key name</TableHead>
              <TableHead>Key ID</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead className="w-14 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="px-4 font-medium">{key.label || "Untitled key"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {key.id}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTime(key.created_at)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTime(key.last_used_at)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => remove(key.id)}
                    aria-label="Delete API key"
                    title="Delete key"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={showCreate} onOpenChange={(open) => (open ? setShowCreate(true) : closeCreate())}>
        <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] min-w-0 overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create key</DialogTitle>
            <DialogDescription>
              Name this key so it is easy to recognize later.
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <CreatedKeyCard created={created} />
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setFormError(null);
                }}
                placeholder="Production deploy key"
                onKeyDown={(event) => {
                  if (event.key === "Enter") create();
                }}
                autoFocus
              />
              {formError && (
                <p className="text-sm text-destructive">{formError}</p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            {created ? (
              <Button onClick={closeCreate}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={closeCreate}>
                  Cancel
                </Button>
                <Button onClick={create} disabled={creating}>
                  {creating ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Plus className="size-4" />}
                  Create key
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function messageForKeyError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return "Key management API is unavailable. Start the gateway backend to view or create keys.";
  }
  return err instanceof Error ? err.message : String(err);
}

function CreatedKeyCard({ created }: { created: CreatedGatewayApiKey }) {
  const origin = typeof window === "undefined" ? "http://127.0.0.1:4000" : window.location.origin;
  const claudeCommand = `lite claude --url "${origin}" --key "${created.key}"`;
  const codexCommand = `lite codex --url "${origin}" --key "${created.key}"`;
  const agentPrompt = `You have access to LiteLLM's Rust AI gateway at ${origin}. Ask the user for a LiteLLM API key if you need to make authenticated calls.

Start by checking what you can access:
- Providers and model IDs: GET ${origin}/v1/models
- Full gateway capabilities: GET ${origin}/api/capabilities
- OpenAPI schema and endpoints: GET ${origin}/openapi.json
- MCP servers: inspect "mcp_servers" from /api/capabilities, then call ${origin}/mcp or ${origin}/mcp/{server_id}
- Managed agents: inspect "agents" from /api/capabilities, then call POST ${origin}/api/agents/{agent_id}/run when available`;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="min-w-0 rounded-lg border border-border bg-emerald-500/10 p-3">
        <div className="mb-2 text-sm font-medium">Copy this key now</div>
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
          <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm">
            {created.key}
          </code>
          <CopyButton value={created.key} label="Copy API key" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Copy it now. It will not be shown again.
        </p>
      </div>

      <CommandCard icon="claude" title="Claude Code" command={claudeCommand} />
      <CommandCard icon="codex" title="Codex" command={codexCommand} />

      <div className="min-w-0 rounded-lg border border-border p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-medium">Prompt for AI agents</div>
          <CopyButton value={agentPrompt} label="Copy agent prompt" />
        </div>
        <pre className="max-h-44 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs leading-5 text-muted-foreground">
          {agentPrompt}
        </pre>
      </div>
    </div>
  );
}

function CommandCard({
  icon,
  title,
  command,
}: {
  icon: string;
  title: string;
  command: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <BrandIcon id={icon} className="size-5 shrink-0" />
          <span className="truncate">{title}</span>
        </div>
        <CopyButton value={command} label={`Copy ${title} command`} />
      </div>
      <code className="block min-w-0 overflow-x-auto whitespace-nowrap rounded-lg bg-muted px-3 py-2 font-mono text-xs">
        {command}
      </code>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={label} title={label}>
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}
