/**
 * Minimal, dependency-free stdio MCP server exposing an OpenSandbox sandbox.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 — one JSON object per stdout line.
 * All logging goes to stderr ONLY (stdout is the protocol channel).
 *
 * On boot it builds the sandbox provider from env via buildSandboxProvider().
 * If that returns { error } or no provider, we log to stderr and still serve;
 * tools then return an error result.
 *
 * It lazily creates ONE sandbox on first tool use (reused across calls) and
 * terminates it on SIGINT/SIGTERM/stdin close. Lazy creation is serialised
 * via a single in-flight promise so concurrent calls share one sandbox.
 *
 * Tools: exec, read_file, write_file.
 */

import readline from "node:readline";
import { buildSandboxProvider } from "./sandbox.mjs";

const PROTOCOL_VERSION = "2025-06-18";

function log(...args) {
  process.stderr.write("[sandbox-mcp] " + args.join(" ") + "\n");
}

const built = buildSandboxProvider(process.env);
let provider = null;
let providerError = null;
if (built.error) {
  providerError = built.error;
  log("provider error:", built.error);
} else if (!built.provider) {
  providerError = "no sandbox provider configured";
  log("no sandbox provider configured");
} else {
  provider = built.provider;
  log("provider ready:", provider.providerName);
}

let sandboxId = null;
let sandboxPromise = null;

async function ensureSandbox() {
  if (sandboxId) return sandboxId;
  if (!provider) throw new Error(providerError || "no sandbox provider");
  if (!sandboxPromise) {
    sandboxPromise = provider
      .create("opencode-sandbox")
      .then((r) => {
        sandboxId = r.id;
        log("sandbox created:", sandboxId);
        return sandboxId;
      })
      .catch((err) => {
        sandboxPromise = null; // allow retry on next call
        throw err;
      });
  }
  return sandboxPromise;
}

async function terminateSandbox() {
  if (provider && sandboxId) {
    const id = sandboxId;
    sandboxId = null;
    sandboxPromise = null;
    try {
      await provider.terminate(id);
      log("sandbox terminated:", id);
    } catch (err) {
      log("terminate error:", String(err && err.message ? err.message : err));
    }
  }
}

const TOOLS = [
  {
    name: "exec",
    description: "Run a shell command in the sandbox and return its output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        cwd: { type: "string", description: "Optional working directory." },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the sandbox as UTF-8 text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write UTF-8 text content to a file in the sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to write." },
        content: { type: "string", description: "File content." },
      },
      required: ["path", "content"],
    },
  },
];

function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

function errorResult(text) {
  return { content: [{ type: "text", text: String(text) }], isError: true };
}

async function callTool(name, args) {
  args = args || {};
  const id = await ensureSandbox();
  if (name === "exec") {
    if (!args.command) throw new Error("exec: 'command' is required");
    const out = await provider.execute(id, args.command, { cwd: args.cwd });
    return textResult(out);
  }
  if (name === "read_file") {
    if (!args.path) throw new Error("read_file: 'path' is required");
    const out = await provider.readFile(id, args.path);
    return textResult(out);
  }
  if (name === "write_file") {
    if (!args.path) throw new Error("write_file: 'path' is required");
    if (typeof args.content !== "string")
      throw new Error("write_file: 'content' is required");
    await provider.writeFile(id, args.path, args.content);
    return textResult("ok");
  }
  throw new Error(`unknown tool: ${name}`);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const hasId = id !== undefined && id !== null;

  if (typeof method !== "string") return;

  if (method.startsWith("notifications/")) return; // no response

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "sandbox", version: "1.0.0" },
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await callTool(name, args);
      sendResult(id, result);
    } catch (err) {
      // Tool failures are returned as a result with isError, NOT a JSON-RPC error.
      sendResult(id, errorResult(err && err.message ? err.message : String(err)));
    }
    return;
  }

  if (hasId) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch (err) {
    log("invalid JSON line:", s.slice(0, 200));
    return;
  }
  Promise.resolve(handleMessage(msg)).catch((err) => {
    log("handler error:", String(err && err.message ? err.message : err));
  });
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await terminateSandbox();
  process.exit(0);
}

rl.on("close", () => {
  shutdown();
});
process.on("SIGINT", () => {
  shutdown();
});
process.on("SIGTERM", () => {
  shutdown();
});

log("sandbox MCP server started");
