"use client";

import { useState } from "react";

const KEY = "harness";
const DEFAULT_HARNESS = "claude-code";
type Harness = "opencode" | "claude-code" | "github-copilot";

function normalizeHarness(value: string | null): Harness {
  return value === "claude-code" ? value : DEFAULT_HARNESS;
}

export function useHarness() {
  const [harness, setHarnessState] = useState<Harness>(() => {
    if (typeof window === "undefined") return DEFAULT_HARNESS;
    return normalizeHarness(localStorage.getItem(KEY));
  });

  const setHarness = (v: Harness) => {
    const next = normalizeHarness(v);
    localStorage.setItem(KEY, next);
    setHarnessState(next);
  };

  return [harness, setHarness] as const;
}

export function readHarness(): Harness {
  if (typeof window === "undefined") return DEFAULT_HARNESS;
  return normalizeHarness(localStorage.getItem(KEY));
}
