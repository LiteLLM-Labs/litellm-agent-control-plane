import assert from "node:assert/strict";
import test from "node:test";
import { modelOptions, preferredModel, selectedRuntimeModel } from "../src/lib/model-options.ts";

const current = ["minimax/MiniMax-M3.1-Flash", "minimax/MiniMax-M3"];

test("uses the Flash-first catalog for a new MiniMax selection", () => {
  assert.equal(selectedRuntimeModel(current, ""), current[0]);
  assert.equal(preferredModel(current), current[0]);
  assert.deepEqual(modelOptions(current, ""), current);
});

test("retains saved legacy, custom, and media models when discovery changes", () => {
  for (const saved of ["minimax/MiniMax-M2.7", "saved-alias", "custom-model", "minimax/speech-02-hd"]) {
    assert.equal(selectedRuntimeModel(current, saved), saved);
    assert.deepEqual(modelOptions(current, saved), [saved, ...current]);
    assert.equal(selectedRuntimeModel([], saved), saved);
    assert.deepEqual(modelOptions([], saved), [saved]);
  }
});

test("deduplicates the current choice and retains existing default scoring", () => {
  assert.deepEqual(modelOptions([...current, current[0]], current[0]), current);
  assert.equal(preferredModel(["gpt-5", "claude-sonnet-4-6"]), "claude-sonnet-4-6");
  assert.equal(selectedRuntimeModel([], ""), "");
});
