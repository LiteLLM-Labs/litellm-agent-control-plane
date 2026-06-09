"use client";

import { ServerCog } from "lucide-react";

import { ProvidersPanel } from "@/components/providers-panel";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";

export default function ProvidersPage() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <ServerCog className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">LLM Providers</h1>
          </div>
          <ThemeToggle />
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-[calc(100vw-4rem)] max-w-5xl flex-col gap-5 px-4 py-6 sm:w-full">
            <ProvidersPanel />
          </div>
        </main>
      </div>
    </div>
  );
}
