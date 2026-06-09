export const DEFAULT_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function scheduleLabel(cron?: string | null, timezone?: string | null): string {
  const expr = cron?.trim();
  if (!expr) return "On demand";

  const normalized = expr.replace(/\s+/g, " ");
  const parts = normalized.split(" ");
  const tz = timezone?.trim() || "UTC";

  if (parts.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    if (minute === "0" && hour === "9" && dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
      return `Weekdays at 09:00 (${tz})`;
    }
    if (minute === "0" && hour === "9" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Daily at 09:00 (${tz})`;
    }
    if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Every ${minute.slice(2)} minutes (${tz})`;
    }
    if (minute === "0" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Hourly (${tz})`;
    }
    if (minute === "0" && hour.startsWith("*/") && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Every ${hour.slice(2)} hours (${tz})`;
    }
  }

  return `${normalized} (${tz})`;
}
