"use client";

// Renders an xterm.js terminal attached to a TUI harness (claude-code / codex)
// via a single WebSocket.
//
// URL resolution priority:
//   1. ttyUrl (non-null): platform-provided browser-accessible endpoint.
//      - IN_CLUSTER deployments: a relative path like
//        /api/v1/managed_agents/sessions/{id}/tty that the platform's TCP
//        proxy (server-proxy.mjs) pipes to the cluster-internal sandbox pod.
//      - Absolute ws(s):// URL for any other pre-resolved case.
//   2. sandboxUrl (non-null): local dev — derive ws URL directly from the
//      NodePort sandbox URL (http://host:port → ws://host:port/tty).
//   3. Neither: session still creating — show a waiting state, do not attempt
//      a connection. The localhost:4098 fallback is intentionally removed
//      because it produces a misleading "closed" error in production.
//
// Wire protocol:
//   browser → server : raw text (keystrokes)  OR  JSON {"type":"resize",cols,rows}
//                      OR  JSON {"type":"ping"} (keepalive — harness silently ignores)
//   server  → browser: raw bytes (PTY stdout)
//
// Keepalive: a ping is sent every 30 s to prevent ALB/ELB idle-timeout drops
// (default 60 s). On close, auto-reconnect with exponential backoff up to
// MAX_RECONNECT_ATTEMPTS before giving up and showing "closed".

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

interface Props {
  sessionId: string;
  harnessId: string;
  // Browser-accessible WS base URL provided by the backend.
  // Non-null when the session is ready and the platform can supply a
  // reachable endpoint (IN_CLUSTER proxy path or direct NodePort URL).
  // Null while the session is still creating or the sandbox URL isn't set.
  ttyUrl: string | null;
  // From SessionRow.sandbox_url — the raw cluster-internal URL.
  // Only used as a fallback for local dev (not IN_CLUSTER) when ttyUrl is
  // null but sandbox_url is already set on the session row.
  sandboxUrl: string | null;
  // Bearer token required by the harness's /tty WebSocket. Appended as
  // ?token=… because browsers can't set arbitrary headers on new WebSocket().
  ttyToken: string | null;
}

const PING_INTERVAL_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_MS = 2_000;

// http(s)://host:port  →  ws(s)://host:port/tty(?token=…)
function deriveTtyUrl(sandboxUrl: string, token: string | null): string {
  const base = sandboxUrl.replace(/^http(s?):\/\//i, "ws$1://").replace(/\/+$/, "") + "/tty";
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// Resolve a ttyUrl (may be a relative path like /api/.../tty) to an absolute
// ws(s):// URL using the browser's current origin.
function resolveWsUrl(ttyUrl: string, token: string | null): string {
  let base: string;
  if (ttyUrl.startsWith("ws://") || ttyUrl.startsWith("wss://")) {
    base = ttyUrl.replace(/\/+$/, "");
  } else if (ttyUrl.startsWith("/")) {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    base = `${proto}://${window.location.host}${ttyUrl}`.replace(/\/+$/, "");
  } else {
    base = ttyUrl.replace(/\/+$/, "");
  }
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

type ConnState = "waiting" | "connecting" | "connected" | "closed" | "error";

export function TerminalPanel({ sessionId, harnessId, ttyUrl, sandboxUrl, ttyToken }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConnState>("waiting");
  const [reason, setReason] = useState<string>("");

  useEffect(() => {
    // Resolve the WS URL. If neither ttyUrl nor sandboxUrl is available the
    // session is still creating — render the waiting indicator and don't open
    // a socket (avoids the misleading "closed" error from the old localhost
    // fallback).
    let resolvedUrl: string | null = null;
    if (ttyUrl) {
      resolvedUrl = resolveWsUrl(ttyUrl, ttyToken);
    } else if (sandboxUrl) {
      resolvedUrl = deriveTtyUrl(sandboxUrl, ttyToken);
    }

    if (!resolvedUrl) {
      setState("waiting");
      return;
    }

    const wsUrl: string = resolvedUrl;

    // hostRef is always mounted (the overlay pattern keeps the div in the DOM).
    // This guard is kept as a defensive check against future render changes.
    if (!hostRef.current) return;

    let disposed = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    let ws: WebSocket | null = null;

    function connectWs() {
      if (disposed || !term) return;

      setState("connecting");
      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempts = 0;
        setState("connected");
        ws!.send(
          JSON.stringify({
            type: "resize",
            cols: term!.cols,
            rows: term!.rows,
          }),
        );
        term!.focus();
        pingInterval = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (e) => {
        if (typeof e.data === "string") term?.write(e.data);
        else term?.write(new Uint8Array(e.data as ArrayBuffer));
      };

      ws.onclose = () => {
        if (disposed) return;
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        attempts++;
        if (attempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(BASE_RECONNECT_MS * 2 ** (attempts - 1), 30_000);
          const secs = Math.round(delay / 1000);
          // The server kills the PTY on every WS close (ws.on("close", term.kill())).
          // Reconnecting opens a brand-new process — not a resume of the old one.
          term?.write(
            `\r\n\x1b[2m[ws closed — starting fresh session in ${secs}s (${attempts}/${MAX_RECONNECT_ATTEMPTS})]\x1b[0m\r\n`,
          );
          setState("connecting");
          reconnectTimer = setTimeout(connectWs, delay);
        } else {
          setState("closed");
          term?.write("\r\n\x1b[2m[ws closed]\x1b[0m\r\n");
        }
      };

      // onerror always precedes onclose; onclose drives reconnect logic.
      // Write the error detail into the terminal so users can distinguish a
      // failed connection from a normal idle-timeout drop.
      ws.onerror = (e) => {
        if (disposed) return;
        term?.write(
          `\r\n\x1b[2m[ws error — ${(e as ErrorEvent).message ?? "connection failed"}]\x1b[0m\r\n`,
        );
      };
    }

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed || !hostRef.current) return;

      term = new Terminal({
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        theme: {
          background: "#0b0c10",
          foreground: "#d4d4d8",
          cursor: "#a78bfa",
          selectionBackground: "#3f3f46",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(hostRef.current);
      // Some browsers haven't laid the container out by the time we open;
      // fit needs a real width/height. requestAnimationFrame waits one frame.
      requestAnimationFrame(() => fit?.fit());

      term.onData((d) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
      });

      const onResize = () => {
        fit?.fit();
        if (ws && ws.readyState === WebSocket.OPEN && term) {
          ws.send(
            JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
          );
        }
      };
      window.addEventListener("resize", onResize);

      // Stash cleanup on the closure so the outer effect can pick it up.
      (term as unknown as { _onResize?: () => void })._onResize = onResize;

      connectWs();
    })();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingInterval) clearInterval(pingInterval);
      try {
        const cleanup = (term as unknown as { _onResize?: () => void } | null)
          ?._onResize;
        if (cleanup) window.removeEventListener("resize", cleanup);
      } catch {}
      try {
        ws?.close();
      } catch {}
      try {
        term?.dispose();
      } catch {}
    };
  }, [sessionId, harnessId, ttyUrl, sandboxUrl, ttyToken]);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[#0b0c10] relative">
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-[#1f2229] text-[11px] font-mono text-[#71717a]">
        <span
          aria-hidden
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            state === "connected"
              ? "bg-emerald-500"
              : state === "connecting" || state === "waiting"
                ? "bg-amber-500"
                : "bg-red-500"
          }`}
        />
        <span>tty · {harnessId}</span>
        <span className="text-[#3f3f46]">·</span>
        <span>{state}</span>
        {reason && (
          <>
            <span className="text-[#3f3f46]">·</span>
            <span className="text-red-400">{reason}</span>
          </>
        )}
      </div>
      {/* xterm host: always in DOM so hostRef is non-null when resolvedUrl
          arrives. The waiting overlay sits on top; removing it reveals the
          terminal that was already opened into this div. */}
      <div ref={hostRef} className="flex-1 min-h-0 p-2" />
      {state === "waiting" && (
        <div className="absolute inset-x-0 bottom-0 top-[33px] flex items-center justify-center bg-[#0b0c10] text-[#71717a] text-[13px] font-mono pointer-events-none">
          waiting for sandbox…
        </div>
      )}
    </div>
  );
}
