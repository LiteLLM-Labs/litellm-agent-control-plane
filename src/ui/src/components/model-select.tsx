"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelSelectProps {
  value: string;
  models: string[];
  onValueChange: (v: string) => void;
}

export function ModelSelect({ value, models, onValueChange }: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Deduplicate + sort once; duplicates in model IDs cause React key collisions
  const deduped = [...new Set(models)].sort((a, b) => a.localeCompare(b));
  const q = search.trim().toLowerCase();
  const filtered = q ? deduped.filter((m) => m.toLowerCase().includes(q)) : deduped;

  useEffect(() => {
    if (open) {
      // Reset uncontrolled input via ref, not state, to avoid re-render timing issues
      setSearch("");
      if (searchRef.current) searchRef.current.value = "";
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-[220px] items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pl-2.5 pr-2 text-xs whitespace-nowrap transition-colors outline-none select-none hover:bg-accent focus-visible:border-ring dark:bg-input/30 dark:hover:bg-input/50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex-1 truncate text-left font-mono">{value}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-50 w-72 rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            {/* Uncontrolled input: avoids React 19 concurrent-mode controlled-input flicker */}
            <input
              ref={searchRef}
              defaultValue=""
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
              placeholder="Search models…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="max-h-72 overflow-y-auto py-1" role="listbox">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No models found.</div>
            ) : (
              filtered.map((m) => (
                <button
                  key={m}
                  role="option"
                  aria-selected={m === value}
                  onClick={() => { onValueChange(m); setOpen(false); }}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-mono hover:bg-accent hover:text-accent-foreground",
                    m === value && "text-accent-foreground"
                  )}
                >
                  <Check className={cn("size-3 shrink-0", m === value ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{m}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
