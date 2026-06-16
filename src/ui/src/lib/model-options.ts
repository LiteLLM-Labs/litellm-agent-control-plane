export function modelOptions(models: string[], currentModel: string): string[] {
  const options = normalizeModels(models);
  if (options.length > 0) return options;
  const current = currentModel.trim();
  return current ? [current] : [];
}

export function runtimeSupportsModelDiscovery(runtime?: string | null): boolean {
  return runtime !== "elastic_agent_builder";
}

export function defaultModelForRuntime(runtime?: string | null): string {
  return runtime === "elastic_agent_builder" ? "elastic-agent-builder" : "";
}

export function selectedRuntimeModel(models: string[], currentModel: string): string {
  const options = normalizeModels(models);
  const current = currentModel.trim();
  if (current && options.includes(current)) return current;
  return preferredModel(options);
}

function normalizeModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

export function preferredModel(models: string[]): string {
  const options = normalizeModels(models);
  const concrete = options.filter((model) => !model.endsWith("/*"));
  const preferred = concrete
    .map((model, index) => ({ model, index, score: defaultModelScore(model) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0];
  return (
    preferred?.model ??
    concrete.find((model) => !isDiscouragedDefaultModel(model)) ??
    concrete[0] ??
    options[0] ??
    ""
  );
}

function defaultModelScore(model: string): number {
  const normalized = model.toLowerCase();
  if (isDiscouragedDefaultModel(normalized) || normalized.endsWith("/*")) return 0;
  if (/(^|\/)claude-sonnet-4(?:[-.]|$)/.test(normalized)) return 600_000 + versionScore(normalized);
  if (/(^|\/)claude-opus-4(?:[-.]|$)/.test(normalized)) return 500_000 + versionScore(normalized);
  if (/(^|\/)claude-haiku-4(?:[-.]|$)/.test(normalized)) return 400_000 + versionScore(normalized);
  if (/(^|\/)claude-4(?:[-.]|$)/.test(normalized)) return 350_000 + versionScore(normalized);
  if (/(^|\/)gpt-5(?:[-.]|$)/.test(normalized)) return 300_000 + versionScore(normalized);
  if (/(^|\/)claude-(?:3[-.]7|3[-.]5)-sonnet(?:[-.]|$)/.test(normalized)) {
    return 200_000 + versionScore(normalized);
  }
  return 0;
}

function isDiscouragedDefaultModel(model: string): boolean {
  return /(^|\/)claude-(?:fable|mythos)-5(?:[-.]|$)/.test(model.toLowerCase());
}

function versionScore(model: string): number {
  const stablePrefix = model.replace(/-\d{8}\b.*$/, "");
  return Array.from(stablePrefix.matchAll(/\d+/g))
    .slice(0, 3)
    .map((match) => Number(match[0]))
    .reduce((score, value) => score * 100 + value, 0);
}
