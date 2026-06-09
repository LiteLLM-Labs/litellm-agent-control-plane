/**
 * OpenSandbox-backed command executor.
 *
 * Talks to the OpenSandbox controller + execd over RAW HTTP (global fetch).
 * No npm SDK, no dependencies — Node 20 built-ins only.
 *
 * Reverse-engineered OpenSandbox HTTP API:
 *
 *  CONTROLLER (base = `${OPENSANDBOX_API_URL stripped of trailing /v1}/v1`;
 *  auth header `OPEN-SANDBOX-API-KEY: <key>` only when a key is set):
 *   - Create:  POST {base}/sandboxes -> 202 { id, ... }
 *   - Delete:  DELETE {base}/sandboxes/{id} -> 204
 *   - Resolve execd endpoint:
 *       GET {base}/sandboxes/{id}/endpoints/44772?use_server_proxy=true
 *         -> { endpoint: "<host/path>", headers: {..optional..} }
 *       execd base = `http://${endpoint}` (prepend http:// if no scheme);
 *       the returned headers must be sent on EVERY execd call.
 *
 *  EXECD (base = resolved `http://{endpoint}`; send resolved headers):
 *   - Run command: POST {execdBase}/command  (SSE / newline-delimited JSON).
 *       body { command, background:false, timeout:<ms>, cwd?, envs? }
 *       events: stdout|stderr|result|execution_complete|error
 *   - Read file:   GET  {execdBase}/files/download?path=<encodeURIComponent>
 *   - Write file:  POST {execdBase}/files/upload  (multipart: metadata, file)
 */

import { basename } from "node:path";

/**
 * Build a sandbox provider from env (mirrors lite-harness):
 *   - explicit SANDBOX_PROVIDER wins;
 *   - else auto-detect by OPENSANDBOX_API_URL.
 * Returns { provider } | { error } | { provider: null } (no sandbox configured).
 */
export function buildSandboxProvider(env = process.env) {
  const p = (env.SANDBOX_PROVIDER || "").toLowerCase();
  const url = env.OPENSANDBOX_API_URL;
  if (p === "opensandbox" || (!p && url)) {
    if (!url) return { error: "OPENSANDBOX_API_URL not set" };
    return {
      provider: new OpenSandboxProvider(
        url,
        env.OPENSANDBOX_IMAGE,
        env.OPENSANDBOX_API_KEY
      ),
    };
  }
  if (p && p !== "opensandbox") {
    return {
      error: `unsupported SANDBOX_PROVIDER: ${p} (only opensandbox supported)`,
    };
  }
  return { provider: null };
}

export class OpenSandboxProvider {
  constructor(apiUrl, image, apiKey) {
    this.apiUrl = apiUrl;
    this.image = image;
    this.apiKey = apiKey;
    /** @type {Map<string, {base: string, headers: Record<string,string>}>} */
    this._endpoints = new Map();
  }

  get providerName() {
    return "opensandbox";
  }

  _controllerBase() {
    let u = String(this.apiUrl || "").replace(/\/+$/, "");
    u = u.replace(/\/v1$/, "");
    return `${u}/v1`;
  }

  _controllerHeaders(extra = {}) {
    const h = { ...extra };
    if (this.apiKey) h["OPEN-SANDBOX-API-KEY"] = this.apiKey;
    return h;
  }

  async create(name) {
    const body = {
      image: { uri: this.image || "default" },
      entrypoint: ["tail", "-f", "/dev/null"],
      resourceLimits: { cpu: "1", memory: "2Gi" },
      secureAccess: false,
      env: {},
      metadata: {},
      extensions: {},
      timeout: 600,
    };
    const res = await fetch(`${this._controllerBase()}/sandboxes`, {
      method: "POST",
      headers: this._controllerHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 202) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `OpenSandbox create failed: ${res.status} ${res.statusText} ${txt}`
      );
    }
    const data = await res.json();
    const id = data && data.id;
    if (!id) throw new Error("OpenSandbox create: no sandbox id in response");
    return { id, display: name || id };
  }

  async terminate(id) {
    this._endpoints.delete(id);
    try {
      await fetch(`${this._controllerBase()}/sandboxes/${id}`, {
        method: "DELETE",
        headers: this._controllerHeaders(),
      });
    } catch {
      // best-effort
    }
  }

  async _resolveEndpoint(id) {
    const res = await fetch(
      `${this._controllerBase()}/sandboxes/${id}/endpoints/44772?use_server_proxy=true`,
      { headers: this._controllerHeaders() }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `OpenSandbox resolve endpoint failed: ${res.status} ${res.statusText} ${txt}`
      );
    }
    const data = await res.json();
    let endpoint = data && data.endpoint;
    if (!endpoint) throw new Error("OpenSandbox resolve: no endpoint returned");
    if (!/^https?:\/\//.test(endpoint)) endpoint = `http://${endpoint}`;
    const resolved = { base: endpoint, headers: (data && data.headers) || {} };
    this._endpoints.set(id, resolved);
    return resolved;
  }

  async _execd(id) {
    const cached = this._endpoints.get(id);
    if (cached) return cached;
    return this._resolveEndpoint(id);
  }

  async execute(id, cmd, opts = {}) {
    const run = (ep) => this._executeOnce(ep, cmd, opts);
    let ep = await this._execd(id);
    try {
      return await run(ep);
    } catch (err) {
      // Re-resolve once on failure, then retry.
      this._endpoints.delete(id);
      ep = await this._resolveEndpoint(id);
      return run(ep);
    }
  }

  async _executeOnce(ep, cmd, opts = {}) {
    const timeout =
      typeof opts.timeout === "number" ? opts.timeout : 180000;
    const body = { command: cmd, background: false, timeout };
    if (opts.cwd) body.cwd = opts.cwd;
    if (opts.envs) body.envs = opts.envs;

    const res = await fetch(`${ep.base}/command`, {
      method: "POST",
      headers: {
        ...ep.headers,
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `OpenSandbox command failed: ${res.status} ${res.statusText} ${txt}`
      );
    }

    let stdout = "";
    let stderr = "";
    let completed = false;
    let exitCode = null;

    const decoder = new TextDecoder();
    let buf = "";

    const handleLine = (line) => {
      let s = line.trim();
      if (!s) return;
      if (s.startsWith(":")) return;
      if (/^(event:|id:|retry:)/.test(s)) return;
      if (s.startsWith("data:")) s = s.slice(5).trim();
      if (!s) return;
      let evt;
      try {
        evt = JSON.parse(s);
      } catch {
        return;
      }
      if (!evt || typeof evt !== "object") return;
      switch (evt.type) {
        case "stdout":
          if (typeof evt.text === "string") stdout += evt.text;
          break;
        case "stderr":
          if (typeof evt.text === "string") stderr += evt.text;
          break;
        case "execution_complete":
          completed = true;
          break;
        case "error": {
          const evalue = evt.error && evt.error.evalue;
          if (evalue != null) {
            const n = parseInt(String(evalue), 10);
            if (Number.isInteger(n)) exitCode = n;
          }
          break;
        }
        case "result":
        default:
          break;
      }
    };

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    }
    buf += decoder.decode();
    if (buf) handleLine(buf);

    // Infer exit code: 0 if execution_complete with no error event set a code;
    // else the parsed numeric evalue; else null.
    let code;
    if (exitCode != null) code = exitCode;
    else if (completed) code = 0;
    else code = null;

    const out = stdout + stderr;
    if (typeof code === "number" && code !== 0) {
      return out + "\n[exit " + code + "]";
    }
    return out;
  }

  async readFile(id, path) {
    const ep = await this._execd(id);
    const doFetch = (e) =>
      fetch(`${e.base}/files/download?path=${encodeURIComponent(path)}`, {
        headers: { ...e.headers },
      });
    let res = await doFetch(ep);
    if (!res.ok) {
      this._endpoints.delete(id);
      const re = await this._resolveEndpoint(id);
      res = await doFetch(re);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `OpenSandbox readFile failed: ${res.status} ${res.statusText} ${txt}`
      );
    }
    const ab = await res.arrayBuffer();
    return new TextDecoder().decode(ab);
  }

  async writeFile(id, path, content) {
    const ep = await this._execd(id);
    const doUpload = (e) => {
      const form = new FormData();
      const meta = JSON.stringify({
        path,
        owner: "root",
        group: "root",
        mode: "0644",
      });
      form.append(
        "metadata",
        new Blob([meta], { type: "application/json" })
      );
      form.append("file", new Blob([content]), basename(path));
      return fetch(`${e.base}/files/upload`, {
        method: "POST",
        headers: { ...e.headers },
        body: form,
      });
    };
    let res = await doUpload(ep);
    if (!res.ok) {
      this._endpoints.delete(id);
      const re = await this._resolveEndpoint(id);
      res = await doUpload(re);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `OpenSandbox writeFile failed: ${res.status} ${res.statusText} ${txt}`
      );
    }
  }
}
