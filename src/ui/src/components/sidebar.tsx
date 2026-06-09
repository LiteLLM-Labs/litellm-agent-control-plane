"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Bot,
  ChevronDown,
  FileText,
  Inbox,
  KeyRound,
  MessageCircle,
  Plus,
  Puzzle,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  Zap,
  Trash2,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiErrorMessage, deleteSession, listSessions, listInbox } from "@/lib/api";
import type { OpencodeSession } from "@/lib/types";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  active: (pathname: string) => boolean;
  badge?: number;
};

type NavSection = {
  label: string;
  icon: LucideIcon;
  home: string;
  description: string;
  items: NavItem[];
};

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function Sidebar({ activeId }: { activeId?: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [sessions, setSessions] = useState<OpencodeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const load = async () => {
    try {
      const list = await listSessions();
      setSessions(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // Poll the needs-attention count for the unread badge.
  useEffect(() => {
    const loadCount = () =>
      listInbox("attention")
        .then((items) => setInboxCount(items.length))
        .catch(() => {});
    loadCount();
    const t = setInterval(loadCount, 5000);
    return () => clearInterval(t);
  }, [pathname]);

  const onNew = async () => {
    router.push("/chat/");
  };

  const onDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const previousSessions = sessions;
    setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null);
    try {
      await deleteSession(id);
      setError(null);
      if (id === activeId) router.push("/chat/");
    } catch (err) {
      setSessions(previousSessions);
      setError(apiErrorMessage(err, "Failed to delete session"));
    }
  };

  const currentPath = pathname ?? "";
  const sections: NavSection[] = [
    {
      label: "AI Gateway",
      icon: ShieldCheck,
      home: "/providers/",
      description: "Keys, teams, logs, providers, and runtimes",
      items: [
        {
          label: "Keys",
          href: "/keys/",
          icon: KeyRound,
          active: (path) => path.startsWith("/keys"),
        },
        {
          label: "Teams",
          href: "/teams/",
          icon: Users,
          active: (path) => path.startsWith("/teams"),
        },
        {
          label: "Logs",
          href: "/observability/logs/",
          icon: Activity,
          active: (path) => path.startsWith("/observability"),
        },
        {
          label: "LLM Providers",
          href: "/providers/",
          icon: ServerCog,
          active: (path) => path.startsWith("/providers"),
        },
        {
          label: "Agent Runtimes",
          href: "/runtimes/",
          icon: ServerCog,
          active: (path) => path.startsWith("/runtimes"),
        },
        {
          label: "MCP Servers",
          href: "/mcp-servers/",
          icon: Server,
          active: (path) => path.startsWith("/mcp-servers"),
        },
      ],
    },
    {
      label: "Agent Platform",
      icon: Bot,
      home: "/chat/",
      description: "Agents, inbox, integrations, skills",
      items: [
        {
          label: "Chat",
          href: "/chat/",
          icon: MessageCircle,
          active: (path) => path === "/" || path.startsWith("/chat") || path.startsWith("/sessions"),
        },
        {
          label: "Agents",
          href: "/agents/",
          icon: Bot,
          active: (path) => path.startsWith("/agents"),
        },
        {
          label: "Routines",
          href: "/routines/",
          icon: Zap,
          active: (path) => path.startsWith("/routines"),
        },
        {
          label: "Inbox",
          href: "/inbox/",
          icon: Inbox,
          active: (path) => path.startsWith("/inbox"),
          badge: inboxCount,
        },
        {
          label: "Integrations",
          href: "/integrations/",
          icon: Puzzle,
          active: (path) => path.startsWith("/integrations"),
        },
        {
          label: "Skills",
          href: "/skills/",
          icon: FileText,
          active: (path) => path.startsWith("/skills"),
        },
        {
          label: "Rules",
          href: "/rules/",
          icon: ScrollText,
          active: (path) => path.startsWith("/rules"),
        },
        {
          label: "Vault",
          href: "/vault/",
          icon: KeyRound,
          active: (path) => path.startsWith("/vault"),
        },
      ],
    },
  ];
  const currentSection =
    sections.find((section) => section.items.some((item) => item.active(currentPath))) ??
    sections[1];
  const isAgentPlatform = currentSection.label === "Agent Platform";

  return (
    <aside className="flex h-screen w-16 shrink-0 flex-col border-r border-border bg-background sm:w-64">
      <div className="flex h-12 items-center border-b border-border px-2 sm:px-3">
        <ProductSwitcher
          current={currentSection}
          sections={sections}
          onSelect={(section) => router.push(section.home)}
        />
      </div>

      <div className="space-y-3 border-b border-border px-2 py-3 sm:px-3">
        {isAgentPlatform && (
          <Button
            onClick={onNew}
            className="relative w-full justify-center sm:justify-start"
            size="sm"
            aria-label="New session"
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">New session</span>
          </Button>
        )}
        <div className="space-y-1">
          {currentSection.items.map((item) => {
            const Icon = item.icon;
            const badge = item.badge ?? 0;
            return (
              <Button
                key={item.href}
                onClick={() => router.push(item.href)}
                variant={item.active(currentPath) ? "secondary" : "ghost"}
                className="relative w-full justify-center sm:justify-start"
                size="sm"
                aria-label={item.label}
                title={item.label}
              >
                <Icon className="size-4" />
                <span className="hidden sm:inline">{item.label}</span>
                {badge > 0 && (
                  <span className="absolute ml-7 mt-[-18px] flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white sm:static sm:ml-auto sm:mt-0 sm:h-5 sm:min-w-5 sm:px-1.5 sm:text-[11px]">
                    {badge}
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="hidden flex-1 overflow-y-auto py-2 sm:block">
        {isAgentPlatform && (
          <>
            <div className="px-4 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Agent Sessions
            </div>
            {error && (
              <div className="px-3 py-2 text-xs text-destructive">{error}</div>
            )}
            {!sessions && !error && (
              <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
            )}
            {sessions && sessions.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No sessions yet.
              </div>
            )}
            {sessions?.map((s) => {
              const short = s.id.slice(0, 12);
              const title = s.title?.trim() || short;
              const active = s.id === activeId;
              return (
                <div
                  key={s.id}
                  onClick={() => router.push(`/chat/?id=${encodeURIComponent(s.id)}`)}
                  className={`group mx-2 px-2 py-1.5 rounded text-xs cursor-pointer flex items-center justify-between gap-2 ${
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{title}</div>
                    <div className="font-mono text-[10px] text-muted-foreground truncate">
                      {(s.agent ?? s.harness) === "claude-code" ? "cc" : (s.agent ?? s.harness) === "github-copilot" ? "gh" : "oc"} · {short} · {timeAgo(s.time?.created)}
                    </div>
                  </div>
                  <button
                    onClick={(e) => onDelete(e, s.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-background rounded focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    aria-label="Delete session"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="border-t border-border p-2 sm:p-3">
        <Button
          onClick={() => router.push("/settings/")}
          variant={pathname?.startsWith("/settings") ? "secondary" : "ghost"}
          className="w-full justify-center sm:justify-start"
          size="sm"
          aria-label="Settings"
        >
          <Settings className="size-4" />
          <span className="hidden sm:inline">Settings</span>
        </Button>
      </div>
    </aside>
  );
}

function ProductSwitcher({
  current,
  sections,
  onSelect,
}: {
  current: NavSection;
  sections: NavSection[];
  onSelect: (section: NavSection) => void;
}) {
  const CurrentIcon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-9 w-full min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-left text-sm font-semibold outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 sm:justify-start"
        aria-label="Switch product"
      >
        <CurrentIcon className="size-5 shrink-0" />
        <span className="hidden min-w-0 flex-1 truncate sm:block">{current.label}</span>
        <ChevronDown className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-72 p-1.5">
        {sections.map((section) => {
          const Icon = section.icon;
          const selected = section.label === current.label;
          return (
            <DropdownMenuItem
              key={section.label}
              onClick={() => onSelect(section)}
              className={`items-start gap-3 px-3 py-2.5 ${selected ? "bg-accent" : ""}`}
            >
              <Icon className="mt-0.5 size-5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{section.label}</span>
                  {selected && <span className="text-xs text-muted-foreground">Current</span>}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
