"use client";

import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type HeaderContext,
  type SortingState,
} from "@tanstack/react-table";
import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Pencil,
  Play,
  Search,
  Trash2,
  Webhook,
} from "lucide-react";

import { BrandIcon } from "@/components/brand-icons";
import { RuntimeProviderLogo } from "@/components/runtime-provider-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { scheduleLabel } from "@/lib/schedule";
import type { Agent, AgentRuntime } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  importedSource,
  platformMcpIds,
  providerLabel,
  runtimeFromAgent,
} from "./agent-row-utils";
import {
  googleChatActionClass,
  googleChatActionLabel,
  googleChatConfig,
} from "./google-chat-app-flow";
import { slackActionClass, slackActionLabel, slackConfig } from "./slack-app-flow";
import { teamsActionClass, teamsActionLabel, teamsConfig } from "./teams-app-flow";
import { webhookActionClass, webhookActionLabel, webhookConfig } from "./webhook-app-flow";

interface AgentsTableProps {
  agents: Agent[];
  runtimes: AgentRuntime[];
  byoConfiguredAgents: Set<string>;
  onRun: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  onSlack: (agent: Agent) => void;
  onTeams: (agent: Agent) => void;
  onGoogleChat: (agent: Agent) => void;
  onWebhook: (agent: Agent) => void;
  onOpenDetail: (agent: Agent) => void;
}

interface AgentTableRow {
  agent: Agent;
  name: string;
  description: string;
  prompt: string;
  runtimeId: string;
  runtimeName: string;
  runtimeProviderName: string;
  runtimeProviderId: string;
  model: string;
  schedule: string;
  access: string;
  slack: string;
  teams: string;
  webhook: string;
  mcpCount: number;
  searchText: string;
}

export function AgentsTable({
  agents,
  runtimes,
  byoConfiguredAgents,
  onRun,
  onEdit,
  onDelete,
  onSlack,
  onTeams,
  onGoogleChat,
  onWebhook,
  onOpenDetail,
}: AgentsTableProps) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "runtime", desc: false },
    { id: "agent", desc: false },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const runtimeNames = useMemo(() => runtimeNameMap(runtimes), [runtimes]);
  const rows = useMemo(
    () => agents.map((agent) => toTableRow(agent, runtimeNames, byoConfiguredAgents)),
    [agents, runtimeNames, byoConfiguredAgents],
  );
  const runtimeOptions = useMemo(() => runtimeFilterOptions(rows), [rows]);
  const runtimeFilter = String(columnFilters.find((filter) => filter.id === "runtime")?.value ?? "");
  const setRuntimeFilter = (value: string) => {
    setColumnFilters((current) => [
      ...current.filter((filter) => filter.id !== "runtime"),
      ...(value ? [{ id: "runtime", value }] : []),
    ]);
  };
  const columns = useMemo<ColumnDef<AgentTableRow>[]>(
    () => [
      {
        id: "agent",
        accessorKey: "name",
        header: SortableHeader,
        cell: ({ row }) => <AgentCell row={row.original} onOpenDetail={onOpenDetail} />,
      },
      {
        id: "runtime",
        accessorKey: "runtimeName",
        header: SortableHeader,
        filterFn: (row, _columnId, value) => row.original.runtimeId === value,
        cell: ({ row }) => <RuntimeCell row={row.original} />,
      },
      {
        id: "model",
        accessorKey: "model",
        header: SortableHeader,
        cell: ({ row }) => <MonoPill>{row.original.model || "default"}</MonoPill>,
      },
      {
        id: "schedule",
        accessorKey: "schedule",
        header: SortableHeader,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.schedule}</span>,
      },
      {
        id: "access",
        accessorKey: "access",
        header: SortableHeader,
        cell: ({ row }) => (
          <Badge variant={row.original.access === "BYO key" ? "destructive" : "outline"}>
            {row.original.access}
          </Badge>
        ),
      },
      {
        id: "slack",
        accessorKey: "slack",
        header: SortableHeader,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.slack}</span>,
      },
      {
        id: "teams",
        accessorKey: "teams",
        header: SortableHeader,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.teams}</span>,
      },
      {
        id: "webhook",
        accessorKey: "webhook",
        header: SortableHeader,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.webhook}</span>,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <ActionsCell
            agent={row.original.agent}
            onRun={onRun}
            onEdit={onEdit}
            onDelete={onDelete}
            onSlack={onSlack}
            onTeams={onTeams}
            onGoogleChat={onGoogleChat}
            onWebhook={onWebhook}
          />
        ),
      },
    ],
    [onDelete, onEdit, onOpenDetail, onRun, onSlack, onTeams, onGoogleChat, onWebhook],
  );
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter, columnFilters },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: (row, _columnId, value) =>
      row.original.searchText.includes(String(value).trim().toLowerCase()),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 border-b border-border pb-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-sm">
          <Search className="absolute left-2.5 top-2 size-4 text-muted-foreground" />
          <Input
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder="Search agents, runtime, model..."
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <RuntimeFilterButton active={!runtimeFilter} onClick={() => setRuntimeFilter("")}>
            All <span className="text-muted-foreground">{rows.length}</span>
          </RuntimeFilterButton>
          {runtimeOptions.map((option) => (
            <RuntimeFilterButton
              key={option.id}
              active={runtimeFilter === option.id}
              onClick={() => setRuntimeFilter(option.id)}
            >
              {option.name} <span className="text-muted-foreground">{option.count}</span>
            </RuntimeFilterButton>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-background shadow-sm">
        <Table className="table-fixed">
          <TableHeader className="bg-muted/30">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      columnWidthClass(header.id),
                      header.id === "actions" ? "text-right" : "",
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-32 text-center text-muted-foreground"
                >
                  No agents match the current filters.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="group">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        "h-[72px]",
                        columnWidthClass(cell.column.id),
                        cell.column.id !== "actions" && "overflow-hidden",
                        cell.column.id === "actions" && "text-right",
                      )}
                    >
                      <div
                        className={cn(
                          cell.column.id === "agent" && "min-w-0",
                          cell.column.id === "actions" && "flex justify-end",
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="text-xs text-muted-foreground">
        Showing {table.getRowModel().rows.length} of {rows.length} agents
      </div>
    </div>
  );
}

function SortableHeader({ column }: HeaderContext<AgentTableRow, unknown>) {
  const sorted = column.getIsSorted();
  return (
    <button
      type="button"
      disabled={!column.getCanSort()}
      onClick={column.getToggleSortingHandler()}
      className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground disabled:cursor-default"
    >
      {headerLabel(column.id)}
      {sorted === "asc" ? (
        <ChevronUp className="size-3" />
      ) : sorted === "desc" ? (
        <ChevronDown className="size-3" />
      ) : (
        <ChevronsUpDown className="size-3 opacity-60" />
      )}
    </button>
  );
}

function AgentCell({
  row,
  onOpenDetail,
}: {
  row: AgentTableRow;
  onOpenDetail: (agent: Agent) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenDetail(row.agent)}
      className="flex w-full min-w-0 flex-col overflow-hidden text-left"
    >
      <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
        {row.description || row.prompt || row.agent.id}
      </span>
    </button>
  );
}

function RuntimeCell({ row }: { row: AgentTableRow }) {
  return (
    <div className="flex min-w-[180px] items-center gap-2">
      <RuntimeProviderLogo
        alias={row.runtimeProviderId}
        apiSpec={row.runtimeId}
        className="size-8"
        iconClassName="size-4.5"
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{row.runtimeProviderName}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {row.runtimeId}
        </span>
      </span>
    </div>
  );
}

function ActionsCell({
  agent,
  onRun,
  onEdit,
  onDelete,
  onSlack,
  onTeams,
  onGoogleChat,
  onWebhook,
}: {
  agent: Agent;
  onRun: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  onSlack: (agent: Agent) => void;
  onTeams: (agent: Agent) => void;
  onGoogleChat: (agent: Agent) => void;
  onWebhook: (agent: Agent) => void;
}) {
  const slack = slackConfig(agent);
  const teams = teamsConfig(agent);
  const gChat = googleChatConfig(agent);
  const webhook = webhookConfig(agent);
  return (
    <div className="flex justify-end gap-1">
      <Button size="icon-sm" onClick={() => onRun(agent)} aria-label="Run" title="Run">
        <Play className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="outline"
        className={slackActionClass(slack)}
        onClick={() => onSlack(agent)}
        aria-label={slackActionLabel(slack)}
        title={
          slack.status === "connected"
            ? `${slack.slack_team_name || "Slack"}${
                slack.bot_user_id ? ` · <@${slack.bot_user_id}>` : ""
              }`
            : slack.oauth_error || undefined
        }
      >
        <BrandIcon id="slack" className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="outline"
        className={teamsActionClass(teams)}
        onClick={() => onTeams(agent)}
        aria-label={teamsActionLabel(teams)}
        title={
          teams.status === "package_ready"
            ? `${teams.app_name || "Teams"} package ready`
            : teams.oauth_error || undefined
        }
      >
        <BrandIcon id="teams" className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="outline"
        className={googleChatActionClass(gChat)}
        onClick={() => onGoogleChat(agent)}
        aria-label={googleChatActionLabel(gChat)}
      >
        <BrandIcon id="google_chat" className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="outline"
        className={webhookActionClass(webhook)}
        onClick={() => onWebhook(agent)}
        aria-label={webhookActionLabel(webhook)}
        title={webhook.secret_key || undefined}
      >
        <Webhook className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="outline"
        onClick={() => onEdit(agent)}
        aria-label="Edit agent"
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="outline"
        onClick={() => onDelete(agent)}
        aria-label="Delete agent"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

function MonoPill({ children }: { children: string }) {
  return (
    <span className="inline-block max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function RuntimeFilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-8 rounded-md border border-border px-2.5 text-xs font-medium transition-colors",
        active ? "bg-foreground text-background" : "bg-background hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function runtimeNameMap(runtimes: AgentRuntime[]) {
  return new Map(runtimes.map((runtime) => [runtime.id, runtime.name]));
}

function toTableRow(
  agent: Agent,
  runtimeNames: Map<string, string>,
  byoConfiguredAgents: Set<string>,
): AgentTableRow {
  const source = importedSource(agent);
  const runtimeId = source?.provider ?? runtimeFromAgent(agent);
  const runtimeName = source
    ? providerLabel(source.provider)
    : runtimeNames.get(runtimeId) ?? runtimeId;
  const access =
    source?.credential_mode === "byo"
      ? byoConfiguredAgents.has(agent.id)
        ? "Key added"
        : "BYO key"
      : source?.credential_mode === "shared"
        ? "Shared key"
        : "Workspace";
  const slack = slackActionLabel(slackConfig(agent));
  const teams = teamsActionLabel(teamsConfig(agent));
  const webhook = webhookActionLabel(webhookConfig(agent));
  return {
    agent,
    name: String(agent.name ?? "Untitled agent"),
    description: String(agent.description ?? ""),
    prompt: String(agent.prompt ?? agent.system ?? ""),
    runtimeId,
    runtimeName,
    runtimeProviderName: runtimeName,
    runtimeProviderId: runtimeId,
    model: String(agent.model ?? ""),
    schedule: scheduleLabel(agent.cron, agent.timezone),
    access,
    slack,
    teams,
    webhook,
    mcpCount: platformMcpIds(agent).length,
    searchText: [
      agent.id,
      agent.name,
      agent.description,
      agent.prompt,
      agent.system,
      agent.model,
      runtimeId,
      runtimeName,
      access,
      slack,
      teams,
      webhook,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

function runtimeFilterOptions(rows: AgentTableRow[]) {
  const counts = new Map<string, { id: string; name: string; count: number }>();
  for (const row of rows) {
    const current = counts.get(row.runtimeId) ?? {
      id: row.runtimeId,
      name: row.runtimeName,
      count: 0,
    };
    current.count += 1;
    counts.set(row.runtimeId, current);
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function headerLabel(id: string) {
  const labels: Record<string, string> = {
    agent: "Agent",
    runtime: "Runtime",
    model: "Model",
    schedule: "Schedule",
    access: "Access",
    slack: "Slack",
    teams: "Teams",
    webhook: "Webhook",
  };
  return labels[id] ?? id;
}

function columnWidthClass(id: string) {
  const widths: Record<string, string> = {
    agent: "w-[18%]",
    runtime: "w-[16%]",
    model: "w-[10%]",
    schedule: "w-[8%]",
    access: "w-[7%]",
    slack: "w-[7%]",
    teams: "w-[7%]",
    webhook: "w-[7%]",
    actions: "w-[20%]",
  };
  return widths[id] ?? "";
}
