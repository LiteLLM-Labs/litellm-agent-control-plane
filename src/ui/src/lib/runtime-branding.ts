export function runtimeBrandIconId(alias: string, apiSpec?: string | null): string {
  const normalizedAlias = alias.toLowerCase();
  const normalizedSpec = (apiSpec ?? "").toLowerCase();
  const search = `${normalizedAlias} ${normalizedSpec}`;

  if (search.includes("deepagents") || search.includes("deep-agents") || search.includes("langchain")) {
    return "langchain";
  }
  if (search.includes("hermes")) return "hermes";
  if (search.includes("opencode") || search.includes("open-code")) return "opencode";
  if (normalizedAlias === "claude_managed_agents") return "claude";
  if (normalizedSpec === "claude_managed_agents") return "claude";
  if (normalizedAlias === "gemini_antigravity" || normalizedSpec === "gemini_antigravity") return "gemini";
  if (normalizedAlias === "cursor" || normalizedSpec === "cursor") return "cursor";

  return alias || apiSpec || "opencode";
}
