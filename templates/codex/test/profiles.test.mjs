import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexProfileManager, profileInternals } from "../src/profiles.mjs";

class FakeCodex extends EventEmitter {
  async start() { this.running = true; }
  healthy() { return this.running === true; }
  stop() { this.running = false; }
  async listModels() { return { data: [{ id: "gpt-test", model: "gpt-test" }] }; }
}

test("validates each Codex profile type without returning secrets", () => {
  const api = profileInternals.validateProfile({
    alias: "api-one", type: "api", baseUrl: "https://example.test", apiKey: "secret", model: "gpt-test",
  });
  assert.equal(api.baseUrl, "https://example.test");

  const remote = profileInternals.validateProfile({
    alias: "remote-one", type: "remote_ssh", model: "gpt-test",
    ssh: { host: "host.test", username: "alice", privateKey: "PRIVATE", workspace: "/srv/work" },
  });
  const publicRemote = profileInternals.publicProfile(remote, { codex: { healthy: () => true } });
  assert.equal(publicRemote.ssh.authMethod, "private_key");
  assert.equal(JSON.stringify(publicRemote).includes("PRIVATE"), false);
});

test("encrypts profile credentials at rest and restores profiles", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profiles-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    dataRoot: root,
    runtimeApiKey: "runtime-secret",
    encryptionSecret: "encryption-secret",
    codexFactory: () => new FakeCodex(),
  };
  const first = new CodexProfileManager(options);
  await first.init();
  await first.create({
    alias: "api-one", type: "api", baseUrl: "https://example.test", apiKey: "upstream-secret", model: "gpt-test",
  });
  const stored = fs.readFileSync(path.join(root, "profiles.enc.json"), "utf8");
  assert.equal(stored.includes("upstream-secret"), false);
  assert.equal(stored.includes("https://example.test"), false);
  first.stop();

  const second = new CodexProfileManager(options);
  await second.init();
  assert.deepEqual(second.list().map(({ alias, type, ready }) => ({ alias, type, ready })), [
    { alias: "api-one", type: "api", ready: true },
  ]);
  assert.equal(await second.delete("api-one"), true);
  assert.equal(second.list().length, 0);
  second.stop();
});

test("rejects incomplete or unsafe profile inputs", () => {
  assert.throws(() => profileInternals.validateProfile({ alias: "bad alias", type: "chatgpt" }), /alias/);
  assert.throws(() => profileInternals.validateProfile({ alias: "remote", type: "remote_ssh", ssh: {} }), /host and username/);
  assert.throws(() => profileInternals.validateProfile({
    alias: "remote", type: "remote_ssh", ssh: { host: "h", username: "u", password: "p", port: 70000 },
  }), /SSH port/);
});
