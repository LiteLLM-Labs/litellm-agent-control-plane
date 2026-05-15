"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { SANDBOX_TEMPLATES_STORAGE_KEY } from "@/lib/constants";

export interface LocalTemplate {
  id: string;
  name: string;
  repo_url?: string;
  env_vars?: Record<string, string>;
  // retained for AgentTemplate compat when passed to agents/new
  description: string;
  icon: string;
  tags: string[];
  harness_id: string;
  model: string;
  prompt: string;
  skill_name: string;
  skill: string;
  tools: string[];
  requirements: string | null;
  source: "local";
}

function loadLocalTemplates(): LocalTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SANDBOX_TEMPLATES_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LocalTemplate[]) : [];
  } catch { return []; }
}

function saveLocalTemplates(ts: LocalTemplate[]): void {
  try { window.localStorage.setItem(SANDBOX_TEMPLATES_STORAGE_KEY, JSON.stringify(ts)); } catch { /* ignore */ }
}

function TemplateCard({ template, onDelete }: { template: LocalTemplate; onDelete?: () => void }) {
  const envKeys = Object.keys(template.env_vars ?? {});

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-foreground">{template.name}</p>
          {template.repo_url && (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {template.repo_url.replace("https://github.com/", "")}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label={`Delete ${template.name}`}
          onClick={onDelete}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:hover:bg-red-950 dark:hover:text-red-400"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>

      {envKeys.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {envKeys.map((k) => (
            <span key={k} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<LocalTemplate[]>([]);

  useEffect(() => { setTemplates(loadLocalTemplates()); }, []);

  function deleteTemplate(id: string) {
    setTemplates((prev) => {
      const next = prev.filter((t) => t.id !== id);
      saveLocalTemplates(next);
      return next;
    });
  }

  const all = templates;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between border-b pb-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">Templates</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Preconfigured sandbox environments for agent creation.
          </p>
        </div>
        <Link href="/templates/new" className={buttonVariants()}>
          <Plus className="size-4" aria-hidden />
          New Template
        </Link>
      </div>

      {all.length === 0 && (
        <div className="rounded-lg border border-dashed bg-muted/30 px-6 py-12 text-center">
          <p className="text-[13px] text-muted-foreground">No templates yet.</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            <Link href="/templates/new" className="underline underline-offset-2 hover:text-foreground">
              Create your first template →
            </Link>
          </p>
        </div>
      )}

      {all.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {all.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              onDelete={() => deleteTemplate(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
