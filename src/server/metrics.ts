/**
 * In-process Prometheus-compatible metrics registry.
 *
 * Supports Counter and Histogram. No external dependencies — renders directly
 * to Prometheus text format (version 0.0.4) for the /api/v1/metrics endpoint.
 *
 * NOTE: This registry lives in the web process only. The worker (reconciler,
 * warm pool provisioner) runs as a separate process and does not share this
 * state. Worker-side metrics require a separate HTTP server or DB-backed store.
 */

type Labels = Record<string, string>;

function serializeLabels(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`)
    .join(",");
}

interface HistogramData {
  bounds: number[];
  /** counts[i] = observations with value <= bounds[i]  (cumulative) */
  counts: number[];
  sum: number;
  total: number;
}

class MetricsRegistry {
  private counters = new Map<string, Map<string, number>>();
  private histogramBounds = new Map<string, number[]>();
  private histogramData = new Map<string, Map<string, HistogramData>>();

  defineCounter(name: string): void {
    if (!this.counters.has(name)) this.counters.set(name, new Map());
  }

  defineHistogram(name: string, bounds: number[]): void {
    if (!this.histogramBounds.has(name)) {
      this.histogramBounds.set(name, [...bounds].sort((a, b) => a - b));
      this.histogramData.set(name, new Map());
    }
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    let m = this.counters.get(name);
    if (!m) { m = new Map(); this.counters.set(name, m); }
    const key = serializeLabels(labels);
    m.set(key, (m.get(key) ?? 0) + by);
  }

  observe(name: string, labels: Labels, value: number): void {
    const bounds = this.histogramBounds.get(name);
    const dataMap = this.histogramData.get(name);
    if (!bounds || !dataMap) return;

    const key = serializeLabels(labels);
    let d = dataMap.get(key);
    if (!d) {
      d = { bounds, counts: new Array(bounds.length).fill(0), sum: 0, total: 0 };
      dataMap.set(key, d);
    }
    d.sum += value;
    d.total += 1;
    // Each counts[i] is cumulative: incremented for every bound >= value.
    for (let i = 0; i < bounds.length; i++) {
      if (value <= bounds[i]) d.counts[i] += 1;
    }
  }

  renderText(): string {
    const lines: string[] = [];

    for (const [name, labelMap] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labelStr, value] of labelMap) {
        lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${value}`);
      }
    }

    for (const [name, dataMap] of this.histogramData) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [labelStr, d] of dataMap) {
        const extra = labelStr ? `,${labelStr}` : "";
        for (let i = 0; i < d.bounds.length; i++) {
          lines.push(`${name}_bucket{le="${d.bounds[i]}"${extra}} ${d.counts[i]}`);
        }
        lines.push(`${name}_bucket{le="+Inf"${extra}} ${d.total}`);
        const sfx = labelStr ? `{${labelStr}}` : "";
        lines.push(`${name}_sum${sfx} ${d.sum}`);
        lines.push(`${name}_count${sfx} ${d.total}`);
      }
    }

    return lines.join("\n") + "\n";
  }
}

export const registry = new MetricsRegistry();

// Latency buckets tuned for sandbox spawn (seconds)
const SPAWN_BOUNDS = [1, 5, 10, 30, 60, 120, 300, 600];
// Latency buckets tuned for individual phases (seconds)
const PHASE_BOUNDS = [0.5, 1, 5, 10, 30, 60, 120, 300];

// --- session spawn (web process) ---
registry.defineCounter("session_spawn_total");          // {path, result}
registry.defineCounter("session_spawn_failure_total");  // {path, reason}
registry.defineHistogram("session_spawn_duration_seconds", SPAWN_BOUNDS); // {path}
registry.defineHistogram("session_phase_duration_seconds", PHASE_BOUNDS); // {phase}

// --- warm pool claim (web process) ---
registry.defineCounter("warm_pool_hit_total");
registry.defineCounter("warm_pool_miss_total");

// --- warm pool provisioning (worker process) ---
registry.defineCounter("warm_pool_provision_total");                               // {result}
registry.defineHistogram("warm_pool_provision_duration_seconds", PHASE_BOUNDS);

// --- reconciler (worker process) ---
registry.defineCounter("reconcile_failed_creating_total");
registry.defineCounter("reconcile_idle_killed_total");
registry.defineCounter("reconcile_ghost_killed_total");
registry.defineCounter("reconcile_warm_stale_killed_total");
registry.defineHistogram("reconcile_duration_seconds", [0.1, 0.5, 1, 2, 5, 10, 30]);

// --- session death tracking (worker process) ---
// Valid reason label values: oom_killed, task_disappeared, idle_timeout, creating_timeout, sandbox_unreachable
registry.defineCounter("sandbox_oom_killed_total");   // {agent_id}
registry.defineCounter("session_death_total");         // {reason}
