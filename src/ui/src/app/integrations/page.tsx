"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Check, Puzzle } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntegrationDialog } from "@/components/integration-dialog";
import { BrandIcon } from "@/components/brand-icons";
import { listPublicMcpServers, listMcpUserCredentials } from "@/lib/api";
import type { McpServer } from "@/lib/types";

/** Derive a display name from an MCP server record. */
function serverDisplayName(s: McpServer): string {
  return s.server_name ?? s.alias ?? s.server_id;
}

/** Derive the category to group this server under. */
function serverCategory(s: McpServer): string {
  const info = s.mcp_info as { category?: string } | undefined;
  return info?.category ?? "Other";
}

/** Priority order for category headers. Unlisted categories fall to the end. */
const CATEGORY_ORDER = ["Google", "Microsoft", "Other"];

function categoryIndex(cat: string): number {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

function groupByCategory(servers: McpServer[]): [string, McpServer[]][] {
  const groups = new Map<string, McpServer[]>();
  for (const s of servers) {
    const cat = serverCategory(s);
    const arr = groups.get(cat) ?? [];
    arr.push(s);
    groups.set(cat, arr);
  }
  return [...groups.entries()].sort(
    (a, b) => categoryIndex(a[0]) - categoryIndex(b[0]),
  );
}

export default function IntegrationsPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<McpServer | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const refresh = async () => {
    const [srvs, creds] = await Promise.all([
      listPublicMcpServers().catch(() => [] as McpServer[]),
      listMcpUserCredentials().catch(() => [] as { server_id: string }[]),
    ]);
    setServers(srvs);
    setConnected(new Set(creds.map((c) => c.server_id)));
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupByCategory(servers)
      .map(([cat, items]) => {
        const filtered = q
          ? items.filter(
              (it) =>
                serverDisplayName(it).toLowerCase().includes(q) ||
                (it.description ?? "").toLowerCase().includes(q),
            )
          : items;
        return [cat, filtered] as [string, McpServer[]];
      })
      .filter(([, items]) => items.length > 0);
  }, [query, servers]);

  const openDialog = (it: McpServer) => {
    setActive(it);
    setDialogOpen(true);
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Puzzle className="size-4" />
            <span className="text-sm font-semibold">Integrations</span>
          </div>
          <ThemeToggle />
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-6 py-6">
            <div className="mb-6">
              <h1 className="text-xl font-semibold tracking-tight">Connect your tools</h1>
              <p className="text-sm text-muted-foreground">
                Each integration is a managed MCP server. Add your API key to make
                its tools available to your agents.
              </p>
            </div>

            <div className="relative mb-6 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search..."
                className="h-9 pl-8"
              />
            </div>

            {!loading && servers.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No integrations available. Ask your admin to add MCP servers.
              </div>
            )}

            {!loading && servers.length > 0 && groups.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No integrations match &ldquo;{query}&rdquo;.
              </div>
            )}

            <div className="space-y-8">
              {groups.map(([cat, items]) => (
                <section key={cat}>
                  <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {cat}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {items.map((it) => {
                      const isConnected = connected.has(it.server_id);
                      const displayName = serverDisplayName(it);
                      return (
                        <div
                          key={it.server_id}
                          className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20"
                        >
                          <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40">
                            <BrandIcon id={it.server_id} className="size-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium leading-none">{displayName}</div>
                            <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                              {it.description ?? ""}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant={isConnected ? "secondary" : "outline"}
                            onClick={() => openDialog(it)}
                          >
                            {isConnected ? (
                              <>
                                <Check className="size-3.5" />
                                Connected
                              </>
                            ) : (
                              "Connect"
                            )}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </main>
      </div>

      <IntegrationDialog
        server={active}
        open={dialogOpen}
        connected={active ? connected.has(active.server_id) : false}
        onOpenChange={setDialogOpen}
        onChange={refresh}
      />
    </div>
  );
}
