"use client";

/**
 * Automations section for the agent detail page.
 *
 * Lists the agent's scheduled triggers and lets the user add / pause /
 * delete them. Each automation fires a session on a cron cadence (evaluated
 * in UTC) with a fixed instruction as the initial prompt — see
 * src/server/automations.ts for the worker that runs them.
 *
 * Renders independently of the agent edit form: its own fetch + mutations,
 * not part of the form submit.
 */

import { useCallback, useEffect, useState } from "react";
import { Clock, Loader2, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AutomationRow,
  createAutomation,
  deleteAutomation,
  listAutomations,
  updateAutomation,
} from "@/lib/api";

interface Props {
  agentId: string;
}

// Preset schedules surfaced in the add form. The human label is the Select
// option value (this Select renders the value verbatim in the trigger, so a
// raw cron there is unreadable); the cron is looked up from the label on save.
// "Custom cron…" drops to a free-text cron input for anything else.
const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 10 minutes", cron: "*/10 * * * *" },
  { label: "Every 30 minutes", cron: "*/30 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at midnight UTC", cron: "0 0 * * *" },
  { label: "Daily at 9 AM UTC", cron: "0 9 * * *" },
  { label: "Weekdays at 9 AM UTC", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 9 AM UTC", cron: "0 9 * * 1" },
];

const CUSTOM_LABEL = "Custom cron…";
const DEFAULT_SCHEDULE_LABEL = "Every 10 minutes";

/** Human label for a stored cron expression — falls back to the raw cron. */
function humanizeCron(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron);
  return preset ? preset.label : cron;
}

export function AutomationsSection({ agentId }: Props) {
  const [automations, setAutomations] = useState<AutomationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setAutomations(await listAutomations(agentId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggle = async (auto: AutomationRow) => {
    setBusyId(auto.id);
    try {
      await updateAutomation(agentId, auto.id, { enabled: !auto.enabled });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await deleteAutomation(agentId, id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Automations</h2>
        <p className="text-xs text-muted-foreground">
          Run this agent on a schedule.
        </p>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      {automations === null ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </div>
      ) : automations.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-6 py-8 text-center text-sm text-muted-foreground">
          No automations yet. Add one to run this agent on a schedule.
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-card/40">
          {automations.map((auto) => (
            <AutomationItem
              key={auto.id}
              automation={auto}
              busy={busyId === auto.id}
              onToggle={() => handleToggle(auto)}
              onDelete={() => handleDelete(auto.id)}
            />
          ))}
        </ul>
      )}

      {adding ? (
        <AddAutomationForm
          agentId={agentId}
          onCancel={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false);
            await reload();
          }}
          onError={setError}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="ml-1.5">Add automation</span>
        </Button>
      )}
    </section>
  );
}

interface ItemProps {
  automation: AutomationRow;
  busy: boolean;
  onToggle: () => void;
  onDelete: () => void;
}

function AutomationItem({ automation, busy, onToggle, onDelete }: ItemProps) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {automation.name || automation.instruction}
          </span>
          {automation.enabled ? (
            <Badge variant="default" className="font-normal">
              Enabled
            </Badge>
          ) : (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              Paused
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3 w-3 shrink-0" />
          <span className="font-mono">{humanizeCron(automation.cron_expr)}</span>
          {automation.enabled && automation.next_run_at && (
            <span>· next {new Date(automation.next_run_at).toLocaleString()}</span>
          )}
        </div>
        {automation.name && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {automation.instruction}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onToggle} disabled={busy}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : automation.enabled ? (
            "Pause"
          ) : (
            "Resume"
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          disabled={busy}
          aria-label="Delete automation"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}

interface FormProps {
  agentId: string;
  onCancel: () => void;
  onCreated: () => void | Promise<void>;
  onError: (msg: string) => void;
}

function AddAutomationForm({ agentId, onCancel, onCreated, onError }: FormProps) {
  const [instruction, setInstruction] = useState("");
  // The Select value is the human label (shown verbatim in the trigger); the
  // cron is resolved from it on save.
  const [scheduleLabel, setScheduleLabel] = useState(DEFAULT_SCHEDULE_LABEL);
  const [customCron, setCustomCron] = useState("");
  const [saving, setSaving] = useState(false);

  const isCustom = scheduleLabel === CUSTOM_LABEL;
  const cronExpr = isCustom
    ? customCron.trim()
    : (SCHEDULE_PRESETS.find((p) => p.label === scheduleLabel)?.cron ?? "");
  const canSave = instruction.trim().length > 0 && cronExpr.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await createAutomation(agentId, {
        instruction: instruction.trim(),
        cron_expr: cronExpr,
      });
      await onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-card/40 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="automation-instruction">Instruction</Label>
        <Textarea
          id="automation-instruction"
          rows={3}
          placeholder="What should the agent do each time this runs?"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Schedule</Label>
        <Select
          value={scheduleLabel}
          onValueChange={(v) => v && setScheduleLabel(v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_PRESETS.map((p) => (
              <SelectItem key={p.label} value={p.label}>
                {p.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_LABEL}>{CUSTOM_LABEL}</SelectItem>
          </SelectContent>
        </Select>
        {isCustom && (
          <Input
            className="font-mono"
            placeholder="0 9 * * 1-5"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
          />
        )}
        <p className="text-xs text-muted-foreground">
          5-field cron, evaluated in UTC.
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}
