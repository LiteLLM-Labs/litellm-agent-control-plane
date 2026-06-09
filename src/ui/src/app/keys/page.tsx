"use client";

import { KeyRound } from "lucide-react";

import { ApiKeysPanel } from "@/components/api-keys-dialog";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";

export default function KeysPage() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Keys</h1>
          </div>
          <ThemeToggle />
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold">API Keys</h2>
              <p className="text-sm text-muted-foreground">
                Create and revoke gateway keys for local CLIs and AI agents.
              </p>
            </div>
            <ApiKeysPanel />
          </div>
        </main>
      </div>
    </div>
  );
}
