"use client";

import { Check, ChevronDown } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { cn } from "@/ui/lib/utils";

export interface HarnessOption {
  id: string;
  label: string;
  description: string;
  model: string;
  logo: string;
}

export const HARNESS_OPTIONS: HarnessOption[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic's terminal coding agent.",
    model: "anthropic/claude-sonnet-4-5",
    logo: "/brands/claude-code.svg",
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI for coding tasks.",
    model: "openai/gpt-5.1-codex",
    logo: "/brands/codex.svg",
  },
  {
    id: "pi-ai",
    label: "Pi AI",
    description: "Pi coding agent via LiteLLM.",
    model: "openai/gpt-4o",
    logo: "/brands/pi-ai.svg",
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "Open source coding agent harness.",
    model: "anthropic/claude-haiku-4-5",
    logo: "/brands/opencode.svg",
  },
];

export const DEFAULT_HARNESS_ID = "opencode";

interface HarnessPickerProps {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function HarnessPicker({ value, onChange, disabled }: HarnessPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = HARNESS_OPTIONS.find((opt) => opt.id === value) ?? HARNESS_OPTIONS[0];

  function selectHarness(id: string) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className="flex h-12 w-full items-center gap-3 rounded-lg border bg-background px-3 text-left shadow-sm outline-none transition hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
      >
        <HarnessLogo option={selected} className="size-7" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{selected.label}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {selected.model}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Harness"
          className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 overflow-hidden rounded-xl border bg-card p-1.5 shadow-xl"
        >
          {HARNESS_OPTIONS.map((opt) => {
            const active = opt.id === value;
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => selectHarness(opt.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors",
                  active ? "bg-muted text-foreground" : "hover:bg-muted/60",
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm">
                  <HarnessLogo option={opt} className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{opt.label}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {opt.description}
                  </span>
                </span>
                {active ? <Check className="size-4 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function HarnessLogo({
  option,
  className,
}: {
  option: HarnessOption;
  className?: string;
}) {
  return (
    <Image
      src={option.logo}
      alt={`${option.label} logo`}
      width={28}
      height={28}
      className={cn(
        "shrink-0 object-contain",
        option.id === "opencode" && "dark:invert",
        className,
      )}
    />
  );
}
