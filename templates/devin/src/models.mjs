// models.mjs — model normalization for the Devin runtime.
//
// Unlike the opencode template, Devin does not use a `provider/model` split:
// models are addressed by fuzzy family names (opus, sonnet, swe, gpt, gemini)
// or specific IDs, and routed through Devin's own account. This module is a
// thin pass-through that trims and validates the model string.

export function devinModel(model) {
  if (!model || typeof model !== "string") return undefined;
  const value = model.trim();
  return value || undefined;
}

// LAP agents may carry `provider/model` strings from the UI (e.g.
// "devin/opus"). Strip a leading `devin/` provider prefix so only the model
// name reaches `devin acp`.
export function devinModelString(model) {
  const normalized = devinModel(model);
  if (!normalized) return model || "";
  if (normalized.toLowerCase().startsWith("devin/")) {
    return normalized.slice("devin/".length);
  }
  return normalized;
}
