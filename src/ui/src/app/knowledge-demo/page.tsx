"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, ConfigProvider, Input, Modal, Switch, Tag, theme } from "antd";
import { useTheme } from "next-themes";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Database,
  FileText,
  GitBranch,
  Layers3,
  ListFilter,
  LockKeyhole,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  ThumbsUp,
  Users,
  X,
} from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";

const steps = [
  "Define scope",
  "Capture a memo",
  "Review & reuse",
  "Learn & curate",
];
const titles = [
  "Define what agents should remember",
  "Turn a hard-won finding into a memo",
  "Review corrections. Share the better answer.",
  "Let outcomes improve the knowledge base",
];
const subtitles = [
  "Organize shared knowledge by system and by the people who use it.",
  "An agent resolves an unusual problem and saves the lesson for the next person.",
  "Agents propose changes; a service-side LLM judge checks them before publication.",
  "A periodic review promotes proven patterns and archives low-value knowledge.",
];
const initialTitle = "Exclude inactive accounts from cross-account totals";
const initialSummary =
  "The reporting service includes inactive accounts by default. Explicitly exclude them when calculating totals.";
const categories = [
  {
    name: "Account reporting",
    audience: "User",
    count: 18,
    description: "Totals, account lifecycle, and reporting quirks",
    icon: Users,
  },
  {
    name: "Billing",
    audience: "User",
    count: 12,
    description: "Invoices, credits, and reconciliation",
    icon: FileText,
  },
  {
    name: "Bazel & builds",
    audience: "Operator",
    count: 9,
    description: "Build failures, caches, and dependency recovery",
    icon: Terminal,
  },
  {
    name: "Deployments",
    audience: "Operator",
    count: 7,
    description: "Rollouts, service health, and incident recovery",
    icon: Layers3,
  },
];

function subscribeStep(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function readStep() {
  const step = Number(window.location.hash.replace("#step-", ""));
  return step >= 1 && step <= 4 && Number.isInteger(step) ? step : 1;
}

function subscribeHydration() {
  return () => {};
}

function Panel({
  title,
  extra,
  children,
  className = "",
}: {
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`overflow-hidden rounded-xl border border-border bg-card ${className}`}
    >
      <div className="flex min-h-12 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          {title}
        </h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </p>
  );
}

function Success({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
      <Check className="size-3.5" />
      {children}
    </span>
  );
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>{children}</div>
    </div>
  );
}

export default function KnowledgeDemoPage() {
  const step = useSyncExternalStore(subscribeStep, readStep, () => 1);
  const { resolvedTheme } = useTheme();
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false,
  );
  const dark = hydrated && resolvedTheme === "dark";
  const [enabled, setEnabled] = useState(categories.map(() => true));
  const [selected, setSelected] = useState(0);
  const [memoTitle, setMemoTitle] = useState(initialTitle);
  const [summary, setSummary] = useState(initialSummary);
  const [saved, setSaved] = useState(false);
  const [version, setVersion] = useState(1);
  const [proposalBaseVersion, setProposalBaseVersion] = useState(1);
  const [judge, setJudge] = useState<"pending" | "accepted" | "rejected">(
    "pending",
  );
  const [proposal, setProposal] = useState<"supported" | "unsupported">(
    "supported",
  );
  const [loads, setLoads] = useState<{ version: number; helpful: boolean }[]>(
    [],
  );
  const [activeLoad, setActiveLoad] = useState<number | null>(null);
  const [query, setQuery] = useState(
    "cross-account totals include inactive accounts",
  );
  const [search, setSearch] = useState(
    "cross-account totals include inactive accounts",
  );
  const [skillVersion, setSkillVersion] = useState<number | null>(null);
  const reviewed = skillVersion !== null;
  const loaded = activeLoad !== null;
  const outcome = activeLoad !== null && loads[activeLoad]?.helpful;
  const loadedVersion =
    activeLoad !== null ? loads[activeLoad]?.version : version;
  const helpfulCount = loads.filter((load) => load.helpful).length;
  const publishedTitle = saved ? memoTitle : initialTitle;
  const [skillOpen, setSkillOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const hasMatch = /account|total|report|inactive|sum/i.test(search);
  const enabledCount = enabled.filter(Boolean).length;
  const category = categories[selected];
  const canSave =
    enabled[0] && memoTitle.trim().length > 0 && summary.trim().length > 0;
  const go = (next: number) => {
    window.location.hash = `step-${next}`;
  };
  const chooseProposal = (next: "supported" | "unsupported") => {
    if (next === "supported" && version >= 2) return;
    setProposal(next);
    setProposalBaseVersion(version);
    setJudge("pending");
    setActiveLoad(null);
  };
  const reset = () => {
    setEnabled(categories.map(() => true));
    setSelected(0);
    setMemoTitle(initialTitle);
    setSummary(initialSummary);
    setSaved(false);
    setVersion(1);
    setProposalBaseVersion(1);
    setJudge("pending");
    setProposal("supported");
    setActiveLoad(null);
    setSkillVersion(null);
    setLoads([]);
    setQuery("cross-account totals include inactive accounts");
    setSearch("cross-account totals include inactive accounts");
    go(1);
  };

  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          fontFamily: "var(--font-geist-sans), sans-serif",
          borderRadius: 8,
          fontSize: 13,
          colorPrimary: dark ? "#ededed" : "#171717",
        },
        components: { Button: { primaryColor: dark ? "#0a0a0a" : "#ffffff" } },
      }}
    >
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar demo />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BookOpen className="size-4" />
              <span className="hidden sm:inline">Agent Platform</span>
              <ChevronRight className="hidden size-3 sm:block" />
              <span className="font-medium text-foreground">Knowledge</span>
            </div>
            <div className="flex items-center gap-3">
              <Tag>Interactive demo</Tag>
              <ThemeToggle />
            </div>
          </header>
          <main id="main-content" className="flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h1 className="text-xl font-semibold tracking-tight">
                    Shared knowledge
                  </h1>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Lessons from one agent. Useful to every agent.
                  </p>
                </div>
                <div className="hidden items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground sm:flex">
                  <LockKeyhole className="size-3.5" />
                  Workspace shared
                </div>
              </div>
              <nav
                aria-label="Demo steps"
                className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-card p-2 sm:grid-cols-4"
              >
                {steps.map((label, index) => (
                  <button
                    key={label}
                    onClick={() => go(index + 1)}
                    aria-current={step === index + 1 ? "step" : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${step === index + 1 ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    <span
                      className={`grid size-6 shrink-0 place-items-center rounded-full border text-[11px] ${step === index + 1 ? "border-foreground bg-foreground text-background" : "border-border"}`}
                    >
                      {index + 1}
                    </span>
                    {label}
                  </button>
                ))}
              </nav>
              <div className="flex items-start gap-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-muted font-mono text-xl">
                  {step}
                </span>
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">
                    {titles[step - 1]}
                  </h2>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {subtitles[step - 1]}
                  </p>
                </div>
              </div>

              {step >= 3 && !saved && (
                <p className="text-xs text-muted-foreground">
                  Using a published sample memo. Save your draft in step 2 to
                  use it here.
                </p>
              )}

              {step === 1 && (
                <>
                  <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
                    <Panel
                      title={
                        <>
                          <ListFilter className="size-4 text-muted-foreground" />
                          Knowledge categories
                        </>
                      }
                      extra={<Tag>{enabledCount} enabled</Tag>}
                    >
                      <div className="p-2">
                        {["User", "Operator"].map((audience) => (
                          <div key={audience} className="p-2">
                            <Eyebrow>{audience} systems</Eyebrow>
                            {categories.map(
                              (item, i) =>
                                item.audience === audience && (
                                  <div
                                    key={item.name}
                                    className={`mb-2 flex items-center gap-3 rounded-lg border p-3 ${selected === i ? "border-foreground/30 bg-accent/60" : "border-border"}`}
                                  >
                                    <button
                                      onClick={() => setSelected(i)}
                                      className="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                      aria-pressed={selected === i}
                                    >
                                      <item.icon className="size-4 shrink-0 text-muted-foreground" />
                                      <span className="min-w-0">
                                        <span className="block text-sm font-medium">
                                          {item.name}
                                        </span>
                                        <span className="mt-0.5 block text-xs text-muted-foreground">
                                          {item.count} memos
                                        </span>
                                      </span>
                                    </button>
                                    <Switch
                                      size="small"
                                      aria-label={`Enable ${item.name}`}
                                      checked={enabled[i]}
                                      onChange={(value) =>
                                        setEnabled((previous) =>
                                          previous.map((entry, index) =>
                                            index === i ? value : entry,
                                          ),
                                        )
                                      }
                                    />
                                  </div>
                                ),
                            )}
                          </div>
                        ))}
                      </div>
                    </Panel>
                    <Panel
                      title="Category settings"
                      extra={<Tag>{category.audience}</Tag>}
                    >
                      <div className="space-y-5 p-4">
                        <div>
                          <Eyebrow>Selected category</Eyebrow>
                          <h3 className="text-base font-semibold tracking-tight">
                            {category.name}
                          </h3>
                          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                            {category.description}
                          </p>
                        </div>
                        <div className="border-t border-border pt-4">
                          <Eyebrow>When should an agent write a memo?</Eyebrow>
                          <ul className="space-y-3 text-sm">
                            <li className="flex gap-2">
                              <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                              An unexpected behavior took research to resolve
                            </li>
                            <li className="flex gap-2">
                              <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                              The lesson will help someone else
                            </li>
                            <li className="flex gap-2">
                              <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                              A source session supports the finding
                            </li>
                          </ul>
                        </div>
                        <Note icon={<Users className="size-4" />}>
                          <strong className="block text-foreground">
                            Shared within this workspace
                          </strong>
                          <span className="mt-1 block">
                            User and operator are knowledge categories. Access
                            permissions still determine who can retrieve each
                            memo.
                          </span>
                        </Note>
                      </div>
                    </Panel>
                  </div>
                  <Note icon={<Database className="size-4" />}>
                    <strong className="text-foreground">
                      One searchable memo library
                    </strong>
                    <span className="mx-2">·</span>Postgres stores the memo
                    content, versions, and evidence. Vector + text indexes make
                    it discoverable across agents.
                  </Note>
                </>
              )}

              {step === 2 && (
                <div className="grid items-stretch gap-4 lg:grid-cols-[1fr_1.08fr]">
                  <Panel
                    title={
                      <>
                        <Bot className="size-4 text-muted-foreground" />
                        Reporting agent
                      </>
                    }
                    extra={<Tag>Session 8f2a</Tag>}
                  >
                    <div className="space-y-5 p-4">
                      <div className="rounded-lg bg-muted p-3">
                        <Eyebrow>Alex · Finance</Eyebrow>
                        <p className="text-sm leading-relaxed">
                          Why is the cross-account total higher than the sum of
                          our active accounts?
                        </p>
                      </div>
                      <div className="flex gap-3">
                        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-border">
                          <Bot className="size-4" />
                        </span>
                        <div className="space-y-3 text-sm leading-relaxed">
                          <p>
                            I compared the account lifecycle rules with the
                            reporting queries.
                          </p>
                          <div className="space-y-2 border-l border-border pl-3 text-xs text-muted-foreground">
                            <p className="flex items-center gap-2">
                              <Check className="size-3" />
                              Read reporting service documentation
                            </p>
                            <p className="flex items-center gap-2">
                              <Check className="size-3" />
                              Traced the aggregation query
                            </p>
                            <p className="flex items-center gap-2">
                              <Check className="size-3" />
                              Verified with and without inactive accounts
                            </p>
                          </div>
                          <p>
                            The service includes inactive accounts by default.
                            Filtering them out reconciled the total.
                          </p>
                        </div>
                      </div>
                      <div className="rounded-lg border border-border p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="flex items-center gap-2 font-mono text-xs">
                            <BookOpen className="size-3.5" />
                            save_memo
                          </span>
                          <Tag>{saved ? "Saved" : "Proposed"}</Tag>
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          This took 14 minutes of investigation. I’ll record the
                          behavior and the fix so other agents can reuse it.
                        </p>
                      </div>
                      <Button
                        block
                        onClick={() => setEvidenceOpen(true)}
                        icon={<FileText className="size-3.5" />}
                      >
                        View Source Evidence
                      </Button>
                    </div>
                  </Panel>
                  <Panel
                    title={
                      <>
                        <FileText className="size-4 text-muted-foreground" />
                        {saved ? "Published memo" : "New memo"}
                      </>
                    }
                    extra={
                      saved ? (
                        <Tag color="green">v1 · Published</Tag>
                      ) : (
                        <Tag>Draft</Tag>
                      )
                    }
                  >
                    <div className="space-y-4 p-4">
                      <div className="flex flex-wrap gap-1">
                        <Tag>Account reporting</Tag>
                        <Tag>User systems</Tag>
                      </div>
                      <div>
                        <label
                          htmlFor="memo-title"
                          className="mb-1.5 block text-xs font-medium"
                        >
                          Title
                        </label>
                        <Input.TextArea
                          id="memo-title"
                          rows={2}
                          value={memoTitle}
                          disabled={saved}
                          onChange={(e) => setMemoTitle(e.target.value)}
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="memo-summary"
                          className="mb-1.5 block text-xs font-medium"
                        >
                          Summary
                        </label>
                        <Input.TextArea
                          id="memo-summary"
                          rows={3}
                          value={summary}
                          disabled={saved}
                          onChange={(e) => setSummary(e.target.value)}
                        />
                      </div>
                      <div>
                        <Eyebrow>Guidance</Eyebrow>
                        <p className="text-sm leading-relaxed">
                          Explicitly filter to active accounts when calculating
                          a cross-account total. Compare the result with the
                          active-account report.
                        </p>
                      </div>
                      <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                        <span>Source: session 8f2a</span>
                        <span>Author: Reporting agent</span>
                      </div>
                      {!enabled[0] && (
                        <p role="alert" className="text-xs text-destructive">
                          Enable Account reporting in step 1 to save this memo.
                        </p>
                      )}
                      <Button
                        type="primary"
                        block
                        disabled={!canSave || saved}
                          onClick={() => {
                            setSaved(true);
                            setVersion(1);
                            setProposalBaseVersion(1);
                            setJudge("pending");
                            setProposal("supported");
                            setLoads([]);
                            setActiveLoad(null);
                            setSkillVersion(null);
                          }}
                        icon={
                          saved ? (
                            <CheckCheck className="size-4" />
                          ) : (
                            <BookOpen className="size-4" />
                          )
                        }
                      >
                        {saved
                          ? "Memo Saved · Available to Other Agents"
                          : "Save Memo to Shared Knowledge"}
                      </Button>
                      <p className="text-[11px] text-muted-foreground">
                        Demo action · stored in this page only
                      </p>
                    </div>
                  </Panel>
                </div>
              )}

              {step === 3 && (
                <>
                  <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
                    <Panel
                      title={
                        <>
                          <GitBranch className="size-4 text-muted-foreground" />
                          Proposed correction
                        </>
                      }
                      extra={
                        <span className="font-mono text-xs text-muted-foreground">
                          v{proposalBaseVersion} → v{proposalBaseVersion + 1}
                        </span>
                      }
                    >
                      <div className="space-y-4 p-4">
                        <div>
                          <h3 className="text-sm font-semibold tracking-tight">
                            {publishedTitle}
                          </h3>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Proposed by Reconciliation agent · session b71c
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="small"
                            type={
                              proposal === "supported" ? "primary" : "default"
                            }
                            disabled={version >= 2}
                            onClick={() => chooseProposal("supported")}
                          >
                            Evidence-backed Update
                          </Button>
                          <Button
                            size="small"
                            type={
                              proposal === "unsupported" ? "primary" : "default"
                            }
                            onClick={() => chooseProposal("unsupported")}
                          >
                            Try Unsupported Update
                          </Button>
                        </div>
                        <div className="overflow-hidden rounded-lg border border-border text-sm leading-relaxed">
                          <div className="border-b border-border bg-muted/50 p-3">
                            <Eyebrow>Current · v{proposalBaseVersion}</Eyebrow>
                            {proposalBaseVersion === 1
                              ? "Filter to active accounts when calculating the total."
                              : "Filter inactive parent and child accounts before aggregation."}
                          </div>
                          <div
                            className={`p-3 ${proposal === "supported" ? "bg-emerald-500/5" : "bg-amber-500/5"}`}
                          >
                            <Eyebrow>
                              Proposed · v{proposalBaseVersion + 1}
                            </Eyebrow>
                            {proposal === "supported" ? (
                              <>
                                Filter inactive accounts{" "}
                                <strong>
                                  before aggregation, including child accounts
                                </strong>
                                . A parent-only filter can still overcount.
                              </>
                            ) : (
                              <>
                                Remove the active-account filter. All accounts
                                should always be included.
                              </>
                            )}
                          </div>
                        </div>
                        <Button
                          size="small"
                          type="text"
                          icon={<FileText className="size-3.5" />}
                          onClick={() => setEvidenceOpen(true)}
                        >
                          Evidence: 3 Query Checks in Session b71c
                        </Button>
                        <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                          <Clock3 className="size-3.5" />
                          Version history retained ·{" "}
                          {version > 1
                            ? `v1 → v${version} (current)`
                            : "v1 remains current"}
                        </div>
                      </div>
                    </Panel>
                    <Panel
                      title={
                        <>
                          <ShieldCheck className="size-4 text-muted-foreground" />
                          Service-side LLM judge
                        </>
                      }
                      extra={<Tag>Simulated</Tag>}
                    >
                      <div className="space-y-4 p-4">
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          A small model checks the correction against the
                          current memo and its source evidence.
                        </p>
                        <ul className="space-y-3 text-sm">
                          <li className="flex items-center gap-2">
                            <ShieldCheck className="size-4 text-muted-foreground" />
                            Supported by the evidence
                          </li>
                          <li className="flex items-center gap-2">
                            <ShieldCheck className="size-4 text-muted-foreground" />
                            Consistent with the original scope
                          </li>
                          <li className="flex items-center gap-2">
                            <ShieldCheck className="size-4 text-muted-foreground" />
                            Specific enough to apply safely
                          </li>
                        </ul>
                        <div
                          aria-live="polite"
                          className={`rounded-lg border p-3 ${judge === "accepted" ? "border-emerald-500/30 bg-emerald-500/5" : judge === "rejected" ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-muted/40"}`}
                        >
                          <p className="flex items-center gap-2 text-sm font-medium">
                            {judge === "accepted" ? (
                              <>
                                <Check className="size-4 text-emerald-600 dark:text-emerald-400" />
                                Accepted · v{version} published
                              </>
                            ) : judge === "rejected" ? (
                              <>
                                <X className="size-4 text-amber-600 dark:text-amber-400" />
                                Rejected · v{version} remains published
                              </>
                            ) : (
                              <>
                                <Clock3 className="size-4" />
                                Awaiting review
                              </>
                            )}
                          </p>
                          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                            {judge === "accepted"
                              ? "The query results support filtering before aggregation. The correction adds a verified child-account edge case."
                              : judge === "rejected"
                                ? "The proposed change contradicts the query evidence. No new version is published."
                                : "The published memo stays available while the proposed correction is checked."}
                          </p>
                        </div>
                        <Button
                          type="primary"
                          block
                          disabled={judge !== "pending"}
                          onClick={() => {
                            setJudge(
                              proposal === "supported"
                                ? "accepted"
                                : "rejected",
                            );
                            if (proposal === "supported")
                              setVersion((current) => current + 1);
                            setActiveLoad(null);
                          }}
                          icon={<ShieldCheck className="size-4" />}
                        >
                          Run Judge Review
                        </Button>
                      </div>
                    </Panel>
                  </div>
                  <Panel
                    title={
                      <>
                        <Search className="size-4 text-muted-foreground" />
                        The next agent finds the published memo
                      </>
                    }
                    extra={
                      <span className="text-[11px] text-muted-foreground">
                        Postgres · vector + text search
                      </span>
                    }
                  >
                    <div className="space-y-3 p-4">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          setSearch(query);
                          setActiveLoad(null);
                        }}
                        className="flex gap-2"
                      >
                        <Input
                          aria-label="Search shared knowledge"
                          prefix={
                            <Search className="size-3.5 text-muted-foreground" />
                          }
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                        <Button htmlType="submit">Search</Button>
                      </form>
                      {hasMatch ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {publishedTitle}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              v{version} · Semantic + keyword match · Account
                              reporting
                            </p>
                          </div>
                          <Button
                            onClick={() => {
                              setActiveLoad(loads.length);
                              setLoads((previous) => [
                                ...previous,
                                { version, helpful: false },
                              ]);
                            }}
                            disabled={loaded}
                          >
                            {loaded
                              ? `v${version} Loaded`
                              : `Load v${version} into Session`}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2 py-4 text-center">
                          <Search className="size-6 text-muted-foreground" />
                          <p className="text-sm font-medium">
                            No matching demo memos
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Try “inactive accounts” or “reporting totals”.
                          </p>
                        </div>
                      )}
                      {loaded && (
                        <div
                          className="flex flex-wrap items-center justify-between gap-2"
                          aria-live="polite"
                        >
                          <Success>
                            {outcome
                              ? "Helpful outcome recorded · linked to this memo version"
                              : `Finance assistant loaded v${loadedVersion} into a different user’s session`}
                          </Success>
                          <Button
                            size="small"
                            disabled={outcome}
                            icon={<ThumbsUp className="size-3.5" />}
                            onClick={() =>
                              setLoads((previous) =>
                                previous.map((load, index) =>
                                  index === activeLoad
                                    ? { ...load, helpful: true }
                                    : load,
                                ),
                              )
                            }
                          >
                            {outcome
                              ? "Outcome Recorded"
                              : "Record Helpful Outcome"}
                          </Button>
                        </div>
                      )}
                    </div>
                  </Panel>
                </>
              )}

              {step === 4 && (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      {
                        label: "Memo loads",
                        value: 32 + loads.length,
                        detail: "Across 8 agents",
                      },
                      {
                        label: "Helpful",
                        value: 28 + helpfulCount,
                        detail: "Task resolved after use",
                      },
                      {
                        label: "Unhelpful",
                        value: 2,
                        detail: "Did not resolve the task",
                      },
                      {
                        label: "Unknown",
                        value: 2 + loads.length - helpfulCount,
                        detail: "No outcome reported",
                      },
                    ].map((stat) => (
                      <div
                        key={stat.label}
                        className="rounded-xl border border-border bg-card p-4"
                      >
                        <p className="text-xs text-muted-foreground">
                          {stat.label}
                        </p>
                        <p className="my-2 text-3xl font-semibold tracking-tight">
                          {stat.value}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {stat.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                  <Panel
                    title={
                      <>
                        <Clock3 className="size-4 text-muted-foreground" />
                        Weekly knowledge review
                      </>
                    }
                    extra={
                      <Tag>{reviewed ? "Review complete" : "Ready to run"}</Tag>
                    }
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                      <p className="text-xs text-muted-foreground">
                        Last 30 days · outcomes are attached to the memo version
                        used
                      </p>
                      <Button
                        type="primary"
                        disabled={reviewed}
                        onClick={() => setSkillVersion(version)}
                        icon={<Sparkles className="size-3.5" />}
                      >
                        {reviewed ? "Review Applied" : "Run Periodic Review"}
                      </Button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                          <tr>
                            <th className="px-4 py-3 font-medium">Memo</th>
                            <th className="px-3 py-3 font-medium">
                              Usefulness
                            </th>
                            <th className="px-4 py-3 font-medium">
                              {reviewed ? "Decision" : "Recommendation"}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          <tr>
                            <td className="max-w-72 px-4 py-4">
                              <p className="text-sm font-medium">
                                {publishedTitle}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Account reporting · User
                              </p>
                            </td>
                            <td className="whitespace-nowrap px-3 py-4">
                              <p>
                                {28 + helpfulCount} helpful /{" "}
                                {30 + helpfulCount} known
                              </p>
                              <p className="mt-1 text-muted-foreground">
                                {32 + loads.length} loads · 8 agents
                              </p>
                            </td>
                            <td className="px-4 py-4">
                              <Tag color="green">
                                {reviewed
                                  ? "Promoted to skill"
                                  : "Promote to skill"}
                              </Tag>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                Frequent + consistently useful
                              </p>
                            </td>
                          </tr>
                          <tr>
                            <td className="px-4 py-4">
                              <p className="text-sm font-medium">
                                Legacy account-total workaround
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Account reporting · User
                              </p>
                            </td>
                            <td className="px-3 py-4">
                              <p>1 helpful / 10 known</p>
                              <p className="mt-1 text-muted-foreground">
                                Superseded by current guidance
                              </p>
                            </td>
                            <td className="px-4 py-4">
                              <Tag>{reviewed ? "Archived" : "Archive"}</Tag>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                Removed from retrieval; history kept
                              </p>
                            </td>
                          </tr>
                          <tr>
                            <td className="px-4 py-4">
                              <p className="text-sm font-medium">
                                Bazel: recover from a corrupted JAR
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Bazel & builds · Operator
                              </p>
                            </td>
                            <td className="px-3 py-4">
                              <p>2 helpful / 2 known</p>
                              <p className="mt-1 text-muted-foreground">
                                Rare failure · last used 8 months ago
                              </p>
                            </td>
                            <td className="px-4 py-4">
                              <Tag color="blue">
                                {reviewed ? "Retained" : "Keep"}
                              </Tag>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                Rare does not mean low value
                              </p>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </Panel>
                  <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
                    <Panel
                      title={
                        <>
                          <Sparkles className="size-4 text-muted-foreground" />
                          {reviewed ? "Added to Skills" : "Skill preview"}
                        </>
                      }
                      extra={<Tag>{reviewed ? "Available" : "Candidate"}</Tag>}
                    >
                      <div className="space-y-3 p-4">
                        <h3 className="text-base font-semibold tracking-tight">
                          Account reporting checks
                        </h3>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          A reusable procedure: select active accounts, filter
                          before aggregation, and reconcile the final total.
                        </p>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">
                            Source: memo_014 · v{skillVersion ?? version}
                          </span>
                          <Button
                            size="small"
                            onClick={() => setSkillOpen(true)}
                          >
                            View Skill
                          </Button>
                        </div>
                      </div>
                    </Panel>
                    <Panel title="Review policy">
                      <div className="space-y-3 p-4 text-xs leading-relaxed text-muted-foreground">
                        <p>
                          <strong className="text-foreground">Promote</strong>{" "}
                          after 20+ loads and at least 90% helpful outcomes
                          among 10+ known outcomes.
                        </p>
                        <p>
                          <strong className="text-foreground">Archive</strong>{" "}
                          superseded guidance with less than 20% helpful
                          outcomes across 10+ known outcomes.
                        </p>
                        <p>
                          <strong className="text-foreground">Retain</strong>{" "}
                          useful rare fixes. Unknown outcomes do not count as
                          failures.
                        </p>
                      </div>
                    </Panel>
                  </div>
                </>
              )}

              <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <div className="text-[11px] text-muted-foreground">
                  Demo data · actions are simulated · resets on reload
                </div>
                <div className="flex items-center gap-2">
                  <Button size="small" type="text" onClick={reset}>
                    Reset Demo
                  </Button>
                  {step > 1 && (
                    <Button onClick={() => go(step - 1)}>Back</Button>
                  )}
                  {step < 4 && (
                    <Button
                      type="primary"
                      onClick={() => go(step + 1)}
                      icon={<ArrowRight className="size-3.5" />}
                      iconPosition="end"
                    >
                      {steps[step]}
                    </Button>
                  )}
                </div>
              </footer>
            </div>
          </main>
        </div>
      </div>
      <Modal
        title="Source evidence · demo session"
        open={evidenceOpen}
        onCancel={() => setEvidenceOpen(false)}
        footer={
          <Button onClick={() => setEvidenceOpen(false)}>Close Evidence</Button>
        }
      >
        <div className="space-y-4 py-3 text-sm">
          <p>
            The agent checked the same reporting period with three query
            variants:
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>Unfiltered total: 1,280 account units.</li>
            <li>Parent-only active filter: 1,120 account units.</li>
            <li>
              Active parent and child accounts filtered before aggregation:
              1,000 account units, matching the active-account report.
            </li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Synthetic evidence for the prototype. No customer data is loaded.
          </p>
        </div>
      </Modal>
      <Modal
        title="Account reporting checks"
        open={skillOpen}
        onCancel={() => setSkillOpen(false)}
        footer={
          <Button onClick={() => setSkillOpen(false)}>Close Skill</Button>
        }
      >
        <div className="space-y-4 py-3 text-sm">
          <Tag>{reviewed ? "Promoted in demo" : "Preview"}</Tag>
          <p>Use when calculating or debugging totals across accounts.</p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>Identify active accounts for the reporting period.</li>
            <li>
              {(skillVersion ?? version) >= 2
                ? "Exclude inactive parent and child accounts before aggregation."
                : "Explicitly exclude inactive accounts from the total."}
            </li>
            <li>Reconcile against the active-account report.</li>
            <li>Record whether the procedure resolved the discrepancy.</li>
          </ol>
          <p className="text-xs text-muted-foreground">
            Derived from memo_014 · v{skillVersion ?? version}. Source evidence
            and version history are preserved.
          </p>
        </div>
      </Modal>
    </ConfigProvider>
  );
}
