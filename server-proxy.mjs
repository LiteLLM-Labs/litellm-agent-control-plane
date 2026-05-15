#!/usr/bin/env node
// server-proxy.mjs
//
// TCP-level reverse proxy that runs in front of the Next.js standalone
// server. It intercepts WebSocket upgrade requests bound for
//   /api/v1/managed_agents/sessions/<id>/tty
// and pipes the raw TCP connection directly to the cluster-internal sandbox
// pod (sandbox_url from the DB). Every other connection is forwarded to the
// Next.js server running on NEXT_PORT (default 3001).
//
// Why TCP-level: Next.js 16 App Router route handlers don't support WS
// upgrades (the connection closes after the response is generated). A
// raw-TCP proxy operates below the HTTP layer and avoids that restriction.
//
// Auth: the incoming WS upgrade must carry ?token=<value> matching either
// HARNESS_AUTH_TOKEN or MASTER_KEY. The token is forwarded as-is to the
// sandbox, which performs its own constant-time check.
//
// Startup: CMD ["sh", "-c", "... && node server-proxy.mjs"]
// Next.js is spawned as a child process on NEXT_PORT.

import { createServer } from "net";
import { connect } from "net";
import { spawn } from "child_process";
import { createRequire } from "module";
import { timingSafeEqual } from "crypto";
import { URL } from "url";

const require = createRequire(import.meta.url);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const NEXT_PORT = parseInt(process.env.NEXT_PORT ?? "3001", 10);
// Use BIND_HOST, not HOSTNAME: Kubernetes injects HOSTNAME as the pod name,
// which causes proxy.listen to bind on a single pod IP instead of all
// interfaces (and may fail DNS lookup at startup).
const BIND_HOST = process.env.BIND_HOST ?? "0.0.0.0";

// Token accepted on the incoming WS upgrade: the harness auth token only.
// MASTER_KEY is intentionally excluded — it would appear in plaintext in
// ALB access logs and browser history if used as a URL query parameter.
const HARNESS_TOKEN = (process.env.HARNESS_AUTH_TOKEN ?? "").trim();
const CONTAINER_HARNESS_TOKEN = (process.env.CONTAINER_ENV_HARNESS_AUTH_TOKEN ?? "").trim();
if (!HARNESS_TOKEN && !CONTAINER_HARNESS_TOKEN) {
  console.warn("[tty-proxy] WARNING: neither HARNESS_AUTH_TOKEN nor CONTAINER_ENV_HARNESS_AUTH_TOKEN is set — all TTY WebSocket connections will be rejected");
}

function tokenOk(presented) {
  if (!presented) return false;
  const check = (expected) => {
    if (!expected) return false;
    try {
      const a = Buffer.from(presented, "utf8");
      const b = Buffer.from(expected, "utf8");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  };
  return check(HARNESS_TOKEN) || check(CONTAINER_HARNESS_TOKEN);
}

// --- Prisma lazy singleton ---
let _prisma = null;
function getPrisma() {
  if (!_prisma) {
    const { PrismaClient } = require("@prisma/client");
    _prisma = new PrismaClient({ log: [] });
  }
  return _prisma;
}

// --- Fix 1: DB cache (session_id → sandbox_url, 30s TTL) ---
const SESSION_CACHE_TTL = 30_000;
/** @type {Map<string, {url: string|null, expiresAt: number}>} */
const sessionUrlCache = new Map();

async function getSandboxUrl(sessionId) {
  const now = Date.now();
  const cached = sessionUrlCache.get(sessionId);

  if (cached && cached.expiresAt > now) {
    return cached.url;
  }

  try {
    const session = await getPrisma().session.findUnique({
      where: { session_id: sessionId },
      select: { sandbox_url: true, status: true },
    });
    const url = session?.sandbox_url ?? null;
    // Only cache non-null URLs. A null sandbox_url means the sandbox is still
    // spinning up; caching null would return 503 for 30s even after it's ready.
    if (url !== null) {
      sessionUrlCache.set(sessionId, { url, expiresAt: now + SESSION_CACHE_TTL });
    }
    return url;
  } catch (e) {
    if (cached) {
      console.warn("[tty-proxy] DB lookup failed, using stale cache for session", sessionId, e.message);
      return cached.url;
    }
    throw e;
  }
}

// Parse the HTTP request-line and headers from a raw buffer. Returns null if
// the header block isn't complete yet (caller should buffer more data).
function parseRequest(buf) {
  const str = buf.toString("latin1");
  const eoh = str.indexOf("\r\n\r\n");
  if (eoh === -1) return null;
  const lines = str.slice(0, eoh).split("\r\n");
  const requestLine = lines[0] ?? "";
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon === -1) continue;
    const key = lines[i].slice(0, colon).toLowerCase().trim();
    const val = lines[i].slice(colon + 1).trim();
    headers[key] = val;
  }
  return { requestLine, headers };
}

const TTY_PATH_RE = /\/api\/v1\/managed_agents\/sessions\/([^/?]+)\/tty/;

// --- Fix 3: active connection tracking and draining flag ---
/** @type {Set<import('net').Socket>} */
const activeSockets = new Set();
let draining = false;

// Forward raw bytes to the Next.js server (running on NEXT_PORT locally).
// Fix 3: return 503 immediately if draining.
function forwardToNext(clientSocket, initialBuf) {
  if (draining) {
    try {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  const target = connect(NEXT_PORT, "127.0.0.1");
  target.once("connect", () => {
    target.write(initialBuf);
    clientSocket.pipe(target);
    target.pipe(clientSocket);
    clientSocket.on("error", () => { try { target.destroy(); } catch {} });
    target.on("error", () => { try { clientSocket.destroy(); } catch {} });
  });
  target.once("error", () => {
    try {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
  });
}

async function handleTtyUpgrade(clientSocket, buf, sessionId, token) {
  if (!tokenOk(token)) {
    try {
      clientSocket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  let sandboxUrl;
  try {
    sandboxUrl = await getSandboxUrl(sessionId);
  } catch (e) {
    console.error("[tty-proxy] DB lookup failed:", e.message);
    try {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  if (!sandboxUrl) {
    try {
      clientSocket.write(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      clientSocket.destroy();
    } catch {}
    return;
  }

  let parsed;
  try {
    parsed = new URL(sandboxUrl);
  } catch {
    console.error("[tty-proxy] bad sandbox_url:", sandboxUrl);
    try { clientSocket.destroy(); } catch {}
    return;
  }

  const host = parsed.hostname;
  const port = parseInt(parsed.port || "80", 10);

  // Rewrite the request line before forwarding to the sandbox.
  // The browser sends: GET /api/v1/managed_agents/sessions/{id}/tty?token=X HTTP/1.1
  // The harness only handles:            GET /tty?token=X HTTP/1.1
  const rawStr = buf.toString("latin1");
  const lineEnd = rawStr.indexOf("\r\n");
  const parts = rawStr.slice(0, lineEnd).split(" ");
  const origPath = parts[1] ?? "/tty";
  const qIdx = origPath.indexOf("?");
  const ttyPath = "/tty" + (qIdx >= 0 ? origPath.slice(qIdx) : "");
  // Default the HTTP version to avoid "undefined" in the forwarded line if the
  // request line is somehow malformed with fewer than 3 space-delimited tokens.
  const httpVersion = parts[2] ?? "HTTP/1.1";
  const forwardBuf = Buffer.from(
    `${parts[0]} ${ttyPath} ${httpVersion}` + rawStr.slice(lineEnd),
    "latin1",
  );

  const target = connect(port, host);
  target.once("connect", () => {
    target.write(forwardBuf);
    clientSocket.pipe(target);
    target.pipe(clientSocket);
    clientSocket.on("error", () => { try { target.destroy(); } catch {} });
    target.on("error", () => { try { clientSocket.destroy(); } catch {} });
  });
  target.once("error", (e) => {
    console.error(`[tty-proxy] sandbox connect error (${host}:${port}):`, e.message);
    try { clientSocket.destroy(); } catch {}
  });
}

function createProxy() {
  return createServer((clientSocket) => {
    // Fix 3: track active connections for graceful drain
    activeSockets.add(clientSocket);
    clientSocket.once("close", () => activeSockets.delete(clientSocket));

    let buf = Buffer.alloc(0);
    let decided = false;

    // Fix 4: idle timeout while buffering headers (10s)
    const idleTimer = setTimeout(() => {
      if (!decided) {
        try { clientSocket.destroy(); } catch {}
      }
    }, 10_000);

    const onData = (chunk) => {
      if (decided) return;
      buf = Buffer.concat([buf, chunk]);

      const parsed = parseRequest(buf);
      // Wait for full header block (max 16 KB before giving up).
      if (!parsed && buf.length < 16_384) return;

      decided = true;
      clearTimeout(idleTimer);
      clientSocket.removeListener("data", onData);

      if (!parsed) {
        forwardToNext(clientSocket, buf);
        return;
      }

      const { requestLine, headers } = parsed;
      const isUpgrade = (headers["upgrade"] ?? "").toLowerCase() === "websocket";

      if (isUpgrade) {
        const urlPart = requestLine.split(" ")[1] ?? "";
        const match = urlPart.match(TTY_PATH_RE);
        if (match) {
          const sessionId = match[1];
          const qIdx = urlPart.indexOf("?");
          const qParams = new URLSearchParams(qIdx >= 0 ? urlPart.slice(qIdx + 1) : "");
          // Accept the bearer in either form. The lap CLI sends it as an
          // Authorization header so the token doesn't land in ALB / proxy
          // access logs that record the request line; browsers can't set
          // headers on the WS handshake, so they use ?token= instead.
          // Prefer the header form when present so that an intermediary
          // (CDN rewrite, misconfigured proxy) appending a query-string
          // credential can never silently downgrade a CLI request from the
          // log-safe header form to the logged query-param form.
          const headerAuth = (headers["authorization"] ?? "").trim();
          const headerToken = headerAuth.toLowerCase().startsWith("bearer ")
            ? headerAuth.slice(7).trim()
            : "";
          const token = headerToken || qParams.get("token") || "";
          handleTtyUpgrade(clientSocket, buf, sessionId, token).catch((e) => {
            console.error("[tty-proxy] unhandled error:", e.message);
            try { clientSocket.destroy(); } catch {}
          });
          return;
        }
      }

      forwardToNext(clientSocket, buf);
    };

    clientSocket.on("data", onData);
    clientSocket.on("error", () => {});
  });
}

// Start Next.js on an internal port so only the proxy faces the network.
// Returns the child process so the SIGTERM handler can kill it.
function startNextServer() {
  const child = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(NEXT_PORT), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.error(`[tty-proxy] Next.js exited (code=${code ?? "?"})`);
    process.exit(code ?? 1);
  });
  process.on("exit", () => {
    try { child.kill(); } catch {}
  });
  return child;
}

// Fix 2: poll for Next.js TCP readiness before starting proxy
function waitForNextReady(port, intervalMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new Error(`Next.js did not become ready within ${timeoutMs}ms`));
          return;
        }
        console.debug(`[tty-proxy] waiting for Next.js on port ${port}...`);
        setTimeout(attempt, intervalMs);
      });
    }
    attempt();
  });
}

const nextChild = startNextServer();

waitForNextReady(NEXT_PORT, 200, 60_000)
  .then(() => {
    console.log(`[tty-proxy] Next.js ready on 127.0.0.1:${NEXT_PORT}`);

    const proxy = createProxy();

    // Fix 3: SIGTERM graceful drain
    process.on("SIGTERM", () => {
      draining = true;
      proxy.close();

      const drainTimeout = setTimeout(() => {
        for (const sock of activeSockets) {
          try { sock.destroy(); } catch {}
        }
        try { nextChild.kill(); } catch {}
        process.exit(0);
      }, 30_000);

      function checkDrained() {
        if (activeSockets.size === 0) {
          clearTimeout(drainTimeout);
          try { nextChild.kill(); } catch {}
          process.exit(0);
        } else {
          setTimeout(checkDrained, 100);
        }
      }
      checkDrained();
    });

    proxy.listen(PORT, BIND_HOST, () => {
      console.log(
        `[tty-proxy] listening on ${BIND_HOST}:${PORT} — Next.js on 127.0.0.1:${NEXT_PORT}`,
      );
    });
    proxy.on("error", (e) => {
      console.error("[tty-proxy] server error:", e.message);
      process.exit(1);
    });
  })
  .catch((e) => {
    console.error("[tty-proxy]", e.message);
    process.exit(1);
  });
