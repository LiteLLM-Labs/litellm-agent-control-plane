export function modelOptions(models: string[], currentModel: string): string[] {
  const options = normalizeModels(models);
  if (options.length > 0) return options;
  const current = currentModel.trim();
  return current ? [current] : [];
}

export function selectedRuntimeModel(models: string[], currentModel: string): string {
  const options = normalizeModels(models);
  const current = currentModel.trim();
  if (current && options.includes(current)) return current;
  return options.find((model) => !model.endsWith("/*")) ?? options[0] ?? "";
}

function normalizeModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}
