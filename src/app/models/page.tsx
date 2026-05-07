"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ApiError, ModelRow, listModels } from "@/lib/api";

function formatCreated(unix?: number): string {
  if (typeof unix !== "number" || !Number.isFinite(unix)) return "—";
  try {
    return new Date(unix * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

function deriveProvider(model: ModelRow): string {
  // `id` may be of the form "anthropic/claude-haiku-4-5" — take the prefix.
  const slashIdx = model.id.indexOf("/");
  if (slashIdx > 0) return model.id.slice(0, slashIdx);
  // Fall back to `owned_by` if present and not the catch-all "openai" sentinel
  // that the proxy assigns to every model regardless of provider.
  if (model.owned_by && model.owned_by !== "openai") return model.owned_by;
  return "—";
}

export default function ModelsListPage() {
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const models = await listModels();
      setRows(models);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setError(msg);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[22px] font-semibold tracking-tight">Models</h1>
          <p className="text-sm tabular-nums text-muted-foreground">
            {rows.length}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh models"
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={3}
                  className="h-32 text-center text-sm text-muted-foreground"
                >
                  No models registered. Configure them in your LiteLLM proxy.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((model) => {
                const provider = deriveProvider(model);
                return (
                  <TableRow key={model.id} className="hover:bg-muted/40">
                    <TableCell className="font-mono text-xs">
                      {model.id}
                    </TableCell>
                    <TableCell>
                      {provider === "—" ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Badge variant="secondary" className="font-mono text-[11px]">
                          {provider}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatCreated(model.created)}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
