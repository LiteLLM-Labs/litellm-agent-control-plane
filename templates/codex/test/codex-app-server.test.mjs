import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServer, fingerprintForKey } from "../src/codex-app-server.mjs";

test("formats SSH host keys like OpenSSH SHA256 fingerprints", () => {
  assert.match(fingerprintForKey(Buffer.from("host-key")), /^SHA256:[A-Za-z0-9+/]+$/);
});

test("keeps remote Codex sandboxed while using the container permission profile locally", async () => {
  const local = new CodexAppServer({ mode: "chatgpt" });
  const remote = new CodexAppServer({ mode: "remote_ssh" });
  let localTurn;
  let remoteTurn;
  local.request = async (_method, params) => { localTurn = params; };
  remote.request = async (_method, params) => { remoteTurn = params; };

  assert.equal(local.localPermissionProfile, ":danger-full-access");
  assert.deepEqual(local.localArgs().slice(-2), ["-c", 'default_permissions=":danger-full-access"']);
  assert.equal(remote.sandbox, "workspace-write");
  await local.startTurn("local-thread", "hello", "gpt-test");
  await remote.startTurn("remote-thread", "hello", "gpt-test");
  assert.equal(localTurn.permissionProfile, ":danger-full-access");
  assert.equal(remoteTurn.permissionProfile, undefined);
});

test("ChatGPT mode uses native account and model RPCs without an API provider", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const executable = path.join(root, "codex");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("model_provider=\\\"runtime_backend\\\"")) process.exit(91);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  let result = {};
  if (message.method === "account/read") result = { account: null, requiresOpenaiAuth: true };
  if (message.method === "account/login/start") result = { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://example.test/device", userCode: "ABCD-1234" };
  if (message.method === "model/list") result = { data: [{ id: "gpt-test", model: "gpt-test" }] };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`, { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const codex = new CodexAppServer({
    mode: "chatgpt",
    defaultModel: "gpt-test",
    codexHome: path.join(root, "home"),
    codexBin: executable,
  });
  t.after(() => codex.stop());
  await codex.start();
  assert.equal((await codex.readAccount()).account, null);
  assert.equal((await codex.startDeviceLogin()).userCode, "ABCD-1234");
  assert.equal((await codex.listModels()).data[0].id, "gpt-test");
  assert.equal(codex.healthy(), true);
});
