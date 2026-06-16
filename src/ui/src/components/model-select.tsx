"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelSelectProps {
  value: string;
  models: string[];
  onValueChange: (v: string) => void;
  className?: string;
  buttonClassName?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function ModelSelect({
  value,
  models,
  onValueChange,
  className,
  buttonClassName,
  disabled = false,
  ariaLabel = "Select model",
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    listMaxHeight: number;
    top: number;
  } | null>(null);

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
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const updateMenuPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 4;
      const viewportPadding = 8;
      const menuWidth = 288;
      const menuChromeHeight = 52;
      const preferredListHeight = 288;
      const belowSpace = window.innerHeight - rect.bottom - gap - viewportPadding;
      const aboveSpace = rect.top - gap - viewportPadding;
      const openAbove = belowSpace < 180 && aboveSpace > belowSpace;
      const availableSpace = openAbove ? aboveSpace : belowSpace;
      const listMaxHeight = Math.max(120, Math.min(preferredListHeight, availableSpace - menuChromeHeight));
      const left = Math.min(
        Math.max(viewportPadding, rect.right - menuWidth),
        window.innerWidth - menuWidth - viewportPadding,
      );
      const top = openAbove
        ? Math.max(viewportPadding, rect.top - gap - menuChromeHeight - listMaxHeight)
        : rect.bottom + gap;
      setMenuPosition({ left, listMaxHeight, top });
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const menu =
    open && menuPosition && typeof document !== "undefined" ? (
      <div
        ref={menuRef}
        className="fixed z-[1000] w-72 rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
        style={{ left: menuPosition.left, top: menuPosition.top }}
      >
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

        <div className="overflow-y-auto py-1" role="listbox" style={{ maxHeight: menuPosition.listMaxHeight }}>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">No models found.</div>
          ) : (
            filtered.map((m) => (
              <button
                key={m}
                type="button"
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
    ) : null;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 w-[220px] items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pl-2.5 pr-2 text-xs whitespace-nowrap transition-colors outline-none select-none hover:bg-accent focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30 dark:hover:bg-input/50",
          buttonClassName,
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="flex-1 truncate text-left font-mono">{value || "No model"}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
