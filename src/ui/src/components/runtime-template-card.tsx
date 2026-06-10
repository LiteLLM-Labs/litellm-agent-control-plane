"use client";

import { ExternalLink, Plus } from "lucide-react";

import { BrandIcon } from "@/components/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  runtimeTemplateIconId,
  type RuntimeTemplate,
} from "@/lib/runtime-templates";

const SPEC_LABELS: Record<string, string> = {
  claude_managed_agents: "Claude Managed Agents",
  cursor: "Cursor",
  gemini_antigravity: "Gemini Antigravity",
  opencode: "OpenCode",
};

export function RuntimeTemplateCard({
  template,
  onUse,
}: {
  template: RuntimeTemplate;
  onUse: (template: RuntimeTemplate) => void;
}) {
  const openTemplate = () => {
    if (template.repoUrl) window.open(template.repoUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-sm">
          <BrandIcon id={runtimeTemplateIconId(template)} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13.5px] font-semibold tracking-tight">{template.name}</h3>
            <Badge variant="outline" className="text-xs">
              {SPEC_LABELS[template.apiSpec] ?? template.apiSpec}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {template.description}
          </p>
        </div>
      </div>

      <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-muted-foreground">Alias</span>
          <span className="truncate font-mono">{template.runtimeAlias}</span>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-muted-foreground">Path</span>
          <span className="truncate font-mono">{template.repoPath}</span>
        </div>
      </div>

      <div className="mt-auto flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => onUse(template)}>
          <Plus className="size-3.5" />
          Add Runtime
        </Button>
        {template.repoUrl && (
          <Button type="button" size="sm" variant="outline" onClick={openTemplate}>
            <ExternalLink className="size-3.5" />
            Open Template
          </Button>
        )}
      </div>
    </div>
  );
}
