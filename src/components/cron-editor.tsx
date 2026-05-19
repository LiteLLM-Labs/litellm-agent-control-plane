"use client";

import { useMemo, useState } from "react";
import { Loader2, Pencil, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Editor for an agent's scheduled-trigger config.
 *
 * Renders inline (read-only summary + Edit button → form) so it can drop
 * straight into the agent settings page's <dl> grid without yet another
 * dialog. The cron string is the source of truth; we don't try to build a
 * builder UI in v1 (cron grammar is small enough that a single input +
 * preview keeps the surface tight).
 *
 * Validation: only on submit, server-side. Client-side preview is a
 * cosmetic translation — if it can't parse the string it just falls back
 * to "scheduled" rather than blocking save. The server returns a 400 with
 * a human-readable message which we surface verbatim.
 */

interface CronEditorProps {
  cron_schedule: string | null;
  cron_timezone: string;
  cron_enabled: boolean;
  cron_last_fired_at?: string | null;
  cron_next_fire_at?: string | null;
  /**
   * Called when the user clicks Save. Pass `cron_schedule: ""` to clear.
   * Returns a promise so we can show the in-button spinner.
   */
  onSave: (next: {
    cron_schedule: string;
    cron_timezone: string;
    cron_enabled: boolean;
  }) => Promise<void>;
  onError: (msg: string) => void;
}

// Short, hand-curated set covering the cases that show up in real usage.
// Long list pulled from tzdata is overkill — users who need an obscure tz
// can type it directly (we accept any IANA string and validate server-side).
const COMMON_TIMEZONES: readonly string[] = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
  { label: "Weekly (Monday 9am)", value: "0 9 * * 1" },
];

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Cosmetic preview. Recognizes the common shapes and falls back to the raw
// expression. Intentionally minimal — anything richer belongs in a proper
// cron lib and the server is the ultimate source of truth via cron_next_fire_at.
function previewCron(expr: string): string {
  const e = expr.trim();
  if (!e) return "";
  for (const p of PRESETS) {
    if (p.value === e) return p.label;
  }
  // "0 H * * *" → "daily at H:00"
  const daily = e.match(/^0\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (daily) return `Daily at ${daily[1].padStart(2, "0")}:00`;
  // "*/N * * * *" → "every N minutes"
  const everyN = e.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyN) return `Every ${everyN[1]} minutes`;
  return "Custom schedule";
}

export function CronEditor(props: CronEditorProps) {
  const {
    cron_schedule,
    cron_timezone,
    cron_enabled,
    cron_last_fired_at,
    cron_next_fire_at,
    onSave,
    onError,
  } = props;

  // Draft state is initialized when the user opens the editor and replaced
  // wholesale on subsequent opens (via openEditor). We deliberately don't
  // sync draft → props in an effect while editing — that would clobber the
  // user's in-progress edits on every parent re-render.
  const [editing, setEditing] = useState(false);
  const [draftSchedule, setDraftSchedule] = useState(cron_schedule ?? "");
  const [draftTz, setDraftTz] = useState(cron_timezone);
  const [draftEnabled, setDraftEnabled] = useState(cron_enabled);
  const [saving, setSaving] = useState(false);

  function openEditor() {
    setDraftSchedule(cron_schedule ?? "");
    setDraftTz(cron_timezone);
    setDraftEnabled(cron_enabled);
    setEditing(true);
  }

  const preview = useMemo(() => previewCron(draftSchedule), [draftSchedule]);

  const tzOptions = useMemo(() => {
    // Preserve a user-typed tz that isn't in the curated list so the value
    // round-trips when re-opening the editor.
    if (COMMON_TIMEZONES.includes(draftTz)) return COMMON_TIMEZONES;
    return [draftTz, ...COMMON_TIMEZONES];
  }, [draftTz]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({
        cron_schedule: draftSchedule.trim(),
        cron_timezone: draftTz,
        cron_enabled: draftEnabled,
      });
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setEditing(false);
    setDraftSchedule(cron_schedule ?? "");
    setDraftTz(cron_timezone);
    setDraftEnabled(cron_enabled);
  }

  if (!editing) {
    const summary = cron_schedule
      ? `${previewCron(cron_schedule)} (${cron_timezone})`
      : "No schedule";
    return (
      <div className="flex items-center gap-2 text-[13px]">
        <span className={cron_schedule ? "" : "text-muted-foreground"}>
          {summary}
        </span>
        {cron_schedule ? (
          <Badge
            variant={cron_enabled ? "default" : "outline"}
            className="text-[10px]"
          >
            {cron_enabled ? "enabled" : "paused"}
          </Badge>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-[11px]"
          onClick={openEditor}
        >
          <Pencil className="size-3" />
          {cron_schedule ? "Edit" : "Set schedule"}
        </Button>
        {cron_schedule ? (
          <div className="ml-2 hidden text-[11px] text-muted-foreground sm:block">
            <div>last: {formatTime(cron_last_fired_at)}</div>
            <div>next: {formatTime(cron_next_fire_at)}</div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="space-y-1">
        <Label htmlFor="cron-schedule" className="text-[11px]">
          Cron expression
        </Label>
        <Input
          id="cron-schedule"
          value={draftSchedule}
          onChange={(e) => setDraftSchedule(e.target.value)}
          placeholder="e.g. 0 9 * * 1-5"
          className="font-mono text-[12px]"
        />
        <p className="text-[11px] text-muted-foreground">
          {draftSchedule.trim()
            ? preview
            : "Leave blank to remove the schedule"}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setDraftSchedule(p.value)}
            className="rounded-md border bg-muted/30 px-2 py-1 text-[11px] hover:bg-muted"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <Label htmlFor="cron-tz" className="text-[11px]">
          Timezone
        </Label>
        <select
          id="cron-tz"
          value={draftTz}
          onChange={(e) => setDraftTz(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-2 text-[12px]"
        >
          {tzOptions.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={draftEnabled}
          onChange={(e) => setDraftEnabled(e.target.checked)}
        />
        Enabled
      </label>

      <div className="flex items-center gap-2 pt-1">
        <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-3 animate-spin" /> : null}
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={handleCancel}
          disabled={saving}
        >
          <X className="size-3" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
