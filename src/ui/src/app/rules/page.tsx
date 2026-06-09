"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText, Loader2, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createRule, deleteRule, listRules, updateRule } from "@/lib/api";
import type { Rule } from "@/lib/types";

function parseFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith("---")) return {};
  const end = md.indexOf("\n---", 3);
  if (end === -1) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of md.slice(3, end).split("\n")) {
    const match = line.match(/^(name|description):\s*(.+)$/);
    if (match) out[match[1] as "name" | "description"] = match[2].trim();
  }
  return out;
}

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editor, setEditor] = useState<{ rule: Rule | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Rule | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      setRules(await listRules());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onPick = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const content = await file.text();
      const frontmatter = parseFrontmatter(content);
      const name = frontmatter.name || file.name.replace(/\.(md|markdown)$/i, "");
      await createRule({ name, content, description: frontmatter.description ?? null });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (id: string) => {
    setDeleteTarget(null);
    setRules((prev) => prev?.filter((rule) => rule.id !== id) ?? null);
    await deleteRule(id);
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <FileText className="size-4" />
            <span className="text-sm font-semibold">Rules</span>
          </div>
          <ThemeToggle />
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-6 py-6">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Rules</h1>
                <p className="text-sm text-muted-foreground">
                  Language models do not retain memory between completions.
                  Rules provide persistent, reusable context at the prompt
                  level. When applied, rule contents are included at the start
                  of the model context to guide code generation, edits, and
                  workflows.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" onClick={onPick} disabled={uploading}>
                  {uploading ? (
                    <>
                      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                      Uploading…
                    </>
                  ) : (
                    <>
                      <Upload className="size-4" />
                      Upload .md
                    </>
                  )}
                </Button>
                <Button onClick={() => setEditor({ rule: null })}>
                  <Plus className="size-4" />
                  New rule
                </Button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.markdown,text/markdown"
                className="hidden"
                onChange={onFile}
              />
            </div>

            {error && (
              <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            {rules === null && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-32 animate-pulse rounded-xl border border-border bg-muted motion-reduce:animate-none"
                  />
                ))}
              </div>
            )}

            {rules?.length === 0 && (
              <div className="rounded-xl border border-dashed border-border py-16 text-center">
                <FileText className="mx-auto mb-3 size-7 text-muted-foreground" />
                <h2 className="text-base font-semibold tracking-tight">No rules yet</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Upload a <code>.md</code> file or create one manually.
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <Button variant="outline" onClick={onPick}>
                    <Upload className="size-4" />
                    Upload .md
                  </Button>
                  <Button onClick={() => setEditor({ rule: null })}>
                    <Plus className="size-4" />
                    New rule
                  </Button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {rules?.map((rule) => (
                <div key={rule.id} className="flex flex-col rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setEditor({ rule })}
                      className="group min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      title="Open to view / edit"
                    >
                      <div className="font-medium leading-none group-hover:underline">
                        {rule.name}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                        {rule.id}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(rule)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      aria-label="Delete rule"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditor({ rule })}
                    className="mt-2 line-clamp-2 rounded text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {rule.description || "No description."}
                  </button>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      {(rule.content.length / 1000).toFixed(1)}k chars
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setEditor({ rule })}>
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>

      <RuleEditorDialog
        editor={editor}
        open={!!editor}
        onOpenChange={(open) => !open && setEditor(null)}
        onSaved={refresh}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-red-600 dark:text-red-400" />
              Delete rule
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">{deleteTarget?.name}</span>? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && onDelete(deleteTarget.id)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RuleEditorDialog({
  editor,
  open,
  onOpenChange,
  onSaved,
}: {
  editor: { rule: Rule | null } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const editing = editor?.rule ?? null;
  const updateFileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setContent(editing?.content ?? "");
    setError(null);
  }, [open, editing]);

  const onUpdateFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const nextContent = await file.text();
      const frontmatter = parseFrontmatter(nextContent);
      setName(frontmatter.name || file.name.replace(/\.(md|markdown)$/i, ""));
      setDescription(frontmatter.description ?? "");
      setContent(nextContent);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSave = async () => {
    if (!name.trim() || !content.trim()) {
      setError("Name and content are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateRule(editing.id, {
          name: name.trim(),
          description: description.trim() || null,
          content,
        });
      } else {
        await createRule({
          name: name.trim(),
          description: description.trim() || null,
          content,
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>
            {editing ? (
              <span className="font-mono text-xs">{editing.id}</span>
            ) : (
              "Name it and paste the rule content (markdown)."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => updateFileRef.current?.click()}
              disabled={saving}
            >
              <Upload className="size-4" />
              Update from .md
            </Button>
            <input
              ref={updateFileRef}
              type="file"
              accept=".md,.markdown,text/markdown"
              className="hidden"
              onChange={onUpdateFile}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="backend-safety"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Instructions this agent should always follow"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Content</label>
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={14}
              className="font-mono text-xs"
              placeholder="Always validate inputs before writing to the database."
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}
            {saving ? "Saving…" : "Save rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
