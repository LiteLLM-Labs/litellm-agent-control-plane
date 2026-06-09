import type { McpServer } from "@/lib/types";

// Catalog of example integrations. The agent builder uses registry-backed MCP
// servers instead, so users only attach servers that are actually configured.

export interface Integration {
  id: string;
  name: string;
  /** Short one-liner shown under the name on the card. */
  description: string;
  /** Group header the card is rendered under (e.g. "Google", "Other"). */
  category: string;
  /** Vault key the API key is stored under (and the label shown in the modal). */
  envKey: string;
  /** Well-known MCP server endpoint this integration connects to. */
  mcpUrl: string;
  /** Tools this MCP server exposes once connected. */
  tools: string[];
  /** Where this option came from. Static entries are examples outside builder flows. */
  source?: "catalog" | "registry";
  /** Whether this server has stored user credentials for the current user. */
  connected?: boolean;
  status?: string | null;
}

export const INTEGRATIONS: Integration[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, compose, and organize emails in your Gmail inbox.",
    category: "Google",
    envKey: "GMAIL_API_KEY",
    mcpUrl: "https://mcp.composio.dev/gmail",
    tools: ["Gmail Search", "Gmail Send", "Gmail Read Thread", "Gmail Create Draft"],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Track issues, plan sprints, and coordinate team projects in Linear.",
    category: "Other",
    envKey: "LINEAR_API_KEY",
    mcpUrl: "https://mcp.linear.app/sse",
    tools: ["Linear List Issues", "Linear Get Issue", "Linear Create Issue", "Linear Update Issue"],
  },
  {
    id: "pylon",
    name: "Pylon",
    description: "View and respond to customer support conversations across channels.",
    category: "Other",
    envKey: "PYLON_API_KEY",
    mcpUrl: "https://mcp.usepylon.com",
    tools: ["Pylon List Issues", "Pylon Get Issue", "Pylon Update Issue"],
  },
];

/** Order categories appear in on the page. Unlisted categories fall to the end. */
export const CATEGORY_ORDER = ["Google", "Microsoft", "Other"];

export function integrationsByCategory(): [string, Integration[]][] {
  const groups = new Map<string, Integration[]>();
  for (const it of INTEGRATIONS) {
    const arr = groups.get(it.category) ?? [];
    arr.push(it);
    groups.set(it.category, arr);
  }
  return [...groups.entries()].sort(
    (a, b) => orderIndex(a[0]) - orderIndex(b[0]),
  );
}

function orderIndex(cat: string): number {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

export function serverDisplayName(server: McpServer): string {
  return server.server_name ?? server.alias ?? server.server_id;
}

export function serverCategory(server: McpServer): string {
  const info = server.mcp_info as { category?: string } | undefined;
  return info?.category ?? "Other";
}

export function credentialLabel(server: McpServer): string {
  const variables =
    (server.mcp_info as { variables?: { name?: string; scope?: string }[] } | undefined)
      ?.variables ?? [];
  const perUserVariables = variables
    .filter((variable) => variable.scope === "per_user" && variable.name)
    .map((variable) => variable.name as string);
  if (perUserVariables.length > 1) return `${perUserVariables.length} credential vars`;
  if (perUserVariables.length === 1) return perUserVariables[0];
  return server.byok_description?.[0] ?? "No credential required";
}

function toolNamesFromServer(server: McpServer, discoveredTools?: string[]): string[] {
  if (discoveredTools && discoveredTools.length > 0) return discoveredTools;
  const displayNames =
    server.tool_name_to_display_name && typeof server.tool_name_to_display_name === "object"
      ? (server.tool_name_to_display_name as Record<string, unknown>)
      : {};
  return (server.allowed_tools ?? []).map((tool) => {
    const displayName = displayNames[tool];
    return typeof displayName === "string" && displayName.trim() ? displayName : tool;
  });
}

export function integrationFromMcpServer(
  server: McpServer,
  options: { connected?: boolean; tools?: string[] } = {},
): Integration {
  return {
    id: server.server_id,
    name: serverDisplayName(server),
    description: server.description ?? "Managed MCP server from the registry.",
    category: serverCategory(server),
    envKey: credentialLabel(server),
    mcpUrl: server.url ?? "",
    tools: toolNamesFromServer(server, options.tools),
    source: "registry",
    connected: options.connected ?? false,
    status: server.status ?? server.approval_status ?? null,
  };
}

export function sortIntegrations(integrations: Integration[]): Integration[] {
  return [...integrations].sort((a, b) => {
    const category = orderIndex(a.category) - orderIndex(b.category);
    if (category !== 0) return category;
    return a.name.localeCompare(b.name);
  });
}
