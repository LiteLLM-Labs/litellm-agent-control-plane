"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, Trash2, FileText, Loader2, Pencil, Plus, AlertTriangle } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  listSkills,
  deleteSkill,
  createSkill,
  updateSkill,
} from "@/lib/api";
import type { Skill } from "@/lib/types";

/** Pull name/description out of a SKILL.md YAML frontmatter block, if present. */
function parseFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith("---")) return {};
  const end = md.indexOf("\n---", 3);
  if (end === -1) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of md.slice(3, end).split("\n")) {
    const m = line.match(/^(name|description):\s*(.+)$/);
    if (m) out[m[1] as "name" | "description"] = m[2].trim();
  }
  return out;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // editor: null = closed; {skill:null} = creating; {skill} = editing.
  const [editor, setEditor] = useState<{ skill: Skill | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      setSkills(await listSkills());
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
    e.target.value = ""; // allow re-uploading the same file
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const content = await file.text();
      const fm = parseFrontmatter(content);
      const name = fm.name || file.name.replace(/\.(md|markdown)$/i, "");
      await createSkill({ name, content, description: fm.description ?? null });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const onDelete = async (id: string) => {
    setDeleteTarget(null);
    setSkills((prev) => prev?.filter((s) => s.id !== id) ?? null);
    await deleteSkill(id);
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <FileText className="size-4" />
            <span className="text-sm font-semibold">Skills</span>
          </div>
          <ThemeToggle />
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-6 py-6">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Skills</h1>
                <p className="text-sm text-muted-foreground">
                  Reusable capability docs. Upload a <code>.md</code> file or
                  paste content to create one. Agents see the catalog and follow
                  their skills at runtime.
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
                <Button onClick={() => setEditor({ skill: null })}>
                  <Plus className="size-4" />
                  New skill
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

            {skills === null && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-32 animate-pulse motion-reduce:animate-none rounded-xl border border-border bg-muted"
                  />
                ))}
              </div>
            )}

            {skills?.length === 0 && (
              <div className="rounded-xl border border-dashed border-border py-16 text-center">
                <FileText className="mx-auto mb-3 size-7 text-muted-foreground" />
                <h2 className="text-base font-semibold tracking-tight">No skills yet</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Upload a <code>.md</code> file or create one manually.
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <Button variant="outline" onClick={onPick}>
                    <Upload className="size-4" />
                    Upload .md
                  </Button>
                  <Button onClick={() => setEditor({ skill: null })}>
                    <Plus className="size-4" />
                    New skill
                  </Button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {skills?.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-col rounded-xl border border-border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      onClick={() => setEditor({ skill: s })}
                      className="group min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
                      title="Open to view / edit"
                    >
                      <div className="font-medium leading-none group-hover:underline">
                        {s.name}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                        {s.id}
                      </div>
                    </button>
                    <button
                      onClick={() => setDeleteTarget(s)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      aria-label="Delete skill"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <button
                    onClick={() => setEditor({ skill: s })}
                    className="mt-2 line-clamp-2 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
                  >
                    {s.description || "No description."}
                  </button>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      {(s.content.length / 1000).toFixed(1)}k chars
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setEditor({ skill: s })}>
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

      <SkillEditorDialog
        editor={editor}
        open={!!editor}
        onOpenChange={(o) => !o && setEditor(null)}
        onSaved={refresh}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-red-600 dark:text-red-400" />
              Delete skill
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

function SkillEditorDialog({
  editor,
  open,
  onOpenChange,
  onSaved,
}: {
  editor: { skill: Skill | null } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const editing = editor?.skill ?? null;
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

  const onSave = async () => {
    if (!name.trim() || !content.trim()) {
      setError("Name and content are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateSkill(editing.id, {
          name: name.trim(),
          description: description.trim() || null,
          content,
        });
      } else {
        await createSkill({
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
          <DialogTitle>{editing ? "Edit skill" : "New skill"}</DialogTitle>
          <DialogDescription>
            {editing ? (
              <span className="font-mono text-xs">{editing.id}</span>
            ) : (
              "Name it and paste the skill content (markdown)."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="pylon-triage"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this skill does (optional)"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Content (markdown)</label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# Skill&#10;Paste the skill instructions here…"
              className="h-72 font-mono text-xs"
            />
          </div>

          {error && <div className="text-xs text-destructive">{error}</div>}

          <Button className="w-full" onClick={onSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                Saving…
              </>
            ) : editing ? (
              "Save changes"
            ) : (
              "Create skill"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
