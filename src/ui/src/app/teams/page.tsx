"use client";

import { Users } from "lucide-react";

import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

export default function TeamsPage() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Teams</h1>
          </div>
          <ThemeToggle />
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto px-4 py-6">
          <div className="rounded-xl border border-dashed border-border py-16 text-center">
            <Users className="mx-auto mb-3 size-7 text-muted-foreground" />
            <h2 className="text-base font-semibold tracking-tight">No teams yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Team access controls are not configured in this build yet.
            </p>
            <Button className="mt-4" disabled>
              Create team
            </Button>
          </div>
        </main>
      </div>
    </div>
  );
}
