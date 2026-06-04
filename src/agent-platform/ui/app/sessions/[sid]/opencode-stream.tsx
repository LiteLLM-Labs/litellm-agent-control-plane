"use client";

import { useCallback, useEffect, useState } from "react";

import {
  applyEvent,
  initState,
  seedFromHistory,
  type AgentMessage,
  type AgentState,
  type OpencodeEvent,
  type PermissionRequest,
} from "@/shared/agent-state";
import { browserOpencodeClient } from "@/ui/lib/opencode-client";
import {
  getSessionThread,
  sendMessage,
  streamSessionEvents,
  type HarnessMessagePart,
  type HarnessMessageResponse,
} from "@/ui/lib/api";

export type SendParts = Array<
  { type: "text"; text: string } | { type: "file"; mime: string; url: string }
>;

export type PermissionResponse = "once" | "always" | "reject";

export interface OpencodeThread {
  /** The whole parent thread (user + assistant), in order. */
  messages: AgentMessage[];
  /** Subagent (child session) threads, keyed by child sessionID. A `task`
   *  tool's `state.metadata.sessionId` maps to one of these. */
  subThreads: Map<string, AgentMessage[]>;
  /** Permission prompts the agent (or a subagent) is currently blocked on. */
  permissions: PermissionRequest[];
  /** True between a send and the next session.idle. */
  busy: boolean;
  error?: string;
  send: (
    parts: SendParts,
    model?: { providerID: string; modelID: string },
  ) => Promise<void>;
  respondPermission: (
    permissionID: string,
    permSessionID: string,
    response: PermissionResponse,
  ) => Promise<void>;
}

function childSessionIds(parent: AgentState): Set<string> {
  const ids = new Set<string>();
  for (const m of parent.messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && p.tool === "task") {
        const cid = (p.state?.metadata as { sessionId?: string } | undefined)
          ?.sessionId;
        if (cid) ids.add(cid);
      }
    }
  }
  return ids;
}

/**
 * The entire session tree, driven by LAP's session stream endpoint. The UI no
 * longer talks to the pod's opencode API directly for rendering; it subscribes
 * to `/api/v1/managed_agents/sessions/:id/stream?follow=1`, which filters the
 * harness event bus server-side and works for Claude SDK, opencode, and the
 * managed-agents V0 event shape.
 */
export function useOpencodeThread(
  sessionId: string,
  harnessSessionId: string | null | undefined,
  enabled: boolean,
): OpencodeThread {
  // Per-session reducer states (parent + children). Held in React state so the
  // render derives from it reactively (no refs during render).
  const [states, setStates] = useState<Map<string, AgentState>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState(false);
  // Persisted thread (Session.history) seeded independently of the live stream.
  // Rendered as a fallback when the live thread is empty — e.g. a reaped sandbox
  // or a finished automation run, where there's no live harness to seed from.
  const [dbHistory, setDbHistory] = useState<AgentMessage[]>([]);

  // Seed the DB history once per session, keyed only on sessionId so it runs
  // even when the session isn't `ready` and has no live harness_session_id
  // (reaped / automation sessions). The /messages route returns the live thread
  // when reachable, else the last-known Session.history snapshot.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const persisted = await getSessionThread(sessionId);
        if (cancelled) return;
        const seeded = seedFromHistory(
          persisted as unknown as Parameters<typeof seedFromHistory>[0],
        );
        setDbHistory(seeded.messages);
        if (harnessSessionId) {
          setStates((prev) => new Map(prev).set(harnessSessionId, seeded));
        }
      } catch {
        // no persisted history — nothing to fall back to
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, harnessSessionId]);

  useEffect(() => {
    if (!enabled || !sessionId || !harnessSessionId) return;
    setStates(new Map());
    let cancelled = false;
    const ctl = new AbortController();

    void (async () => {
      // (Re)connect loop. LAP's stream endpoint is long-lived and can still be
      // dropped by a browser, proxy, or dev-server restart. Re-seed from the
      // session history before each connection, then fold live events.
      // Abort-aware so unmount/nav (ctl.abort()) breaks the backoff wait
      // immediately instead of lingering up to the backoff cap.
      const sleep = (ms: number) =>
        new Promise<void>((r) => {
          const timer = setTimeout(r, ms);
          ctl.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              r();
            },
            { once: true },
          );
        });
      let backoffMs = 1000;
      while (!cancelled) {
        try {
          const hist = await getSessionThread(sessionId, { signal: ctl.signal });
          if (cancelled) return;
          const seeded = seedFromHistory(
            hist as unknown as Parameters<typeof seedFromHistory>[0],
          );
          setStates((prev) => new Map(prev).set(harnessSessionId, seeded));
        } catch {
          // pod warming up / aborted — live events will populate the thread.
        }
        if (cancelled) return;

        try {
          await streamSessionEvents(
            sessionId,
            (frame) => {
              if (cancelled) return;
              const e = frame as unknown as OpencodeEvent;
              setStates((prev) => {
                const next = new Map(prev);
                next.set(
                  harnessSessionId,
                  applyEvent(next.get(harnessSessionId) ?? initState(), e),
                );
                return next;
              });
              if (
                e.type === "session.idle" ||
                e.type === "session.aborted" ||
                e.type === "session.error" ||
                e.type === "session.status_idle" ||
                e.type === "session.status_error"
              ) {
                setBusy(false);
              }
            },
            { signal: ctl.signal },
          );
        } catch {
          if (cancelled) return;
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 15000);
          continue;
        }
        if (cancelled) return;
        backoffMs = 1000;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15000);
      }
    })();

    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [sessionId, harnessSessionId, enabled]);

  // Derive parent + subagent sub-threads (scoped to children this parent
  // spawned via a `task` tool) + aggregate permissions.
  const parent = states.get(harnessSessionId ?? "") ?? initState();
  const subThreads = new Map<string, AgentMessage[]>();
  let permissions: PermissionRequest[] = [...parent.permissions];
  for (const cid of childSessionIds(parent)) {
    const st = states.get(cid);
    if (st) {
      subThreads.set(cid, st.messages);
      permissions = permissions.concat(st.permissions);
    }
  }

  const send = useCallback(
    async (
      parts: SendParts,
      model?: { providerID: string; modelID: string },
    ) => {
      if (!harnessSessionId) throw new Error("session not ready");
      setBusy(true);
      try {
        const response = await sendMessage(sessionId, {
          parts: parts as HarnessMessagePart[],
          ...(model ? { model } : {}),
        });
        setStates((prev) => {
          const next = new Map(prev);
          next.set(
            harnessSessionId,
            applyEvent(next.get(harnessSessionId) ?? initState(), {
              type: "message.updated",
              properties: {
                message: responseToHarnessMessage(response, harnessSessionId),
              },
            }),
          );
          return next;
        });
        setBusy(false);
      } catch (e) {
        setBusy(false);
        throw e;
      }
    },
    [sessionId, harnessSessionId],
  );

  const respondPermission = useCallback(
    async (
      permissionID: string,
      permSessionID: string,
      response: PermissionResponse,
    ) => {
      const oc = browserOpencodeClient(sessionId);
      await oc.postSessionIdPermissionsPermissionId({
        path: { id: permSessionID, permissionID },
        body: { response },
        throwOnError: true,
      });
    },
    [sessionId],
  );

  return {
    // Prefer the live thread; fall back to the persisted DB history when there
    // is none (reaped sandbox / finished automation run) so the chat still
    // renders the conversation instead of an empty thread.
    messages: parent.messages.length > 0 ? parent.messages : dbHistory,
    subThreads,
    permissions,
    busy,
    error: parent.error,
    send,
    respondPermission,
  };
}

function responseToHarnessMessage(
  response: HarnessMessageResponse,
  harnessSessionId: string,
) {
  const info =
    response.info && typeof response.info === "object"
      ? (response.info as { id?: string; sessionID?: string; role?: string })
      : {};
  return {
    info: {
      id: info.id ?? `msg_${Date.now()}`,
      sessionID: info.sessionID ?? harnessSessionId,
      role: info.role ?? "assistant",
    },
    parts: Array.isArray(response.parts) ? response.parts : [],
  };
}
