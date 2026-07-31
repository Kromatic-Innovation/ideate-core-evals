// Tests for additive run planning: results accumulate across sessions without
// re-running completed work and without silently pooling incomparable results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellKey, configHash, planCells, planRun } from "./manifest.mjs";

const SPEC = {
  arms: [{ id: "B" }, { id: "D" }],
  briefs: [{ id: "b1" }, { id: "b2" }],
  replicates: 2,
  config: { harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" },
};

test("planCells enumerates arms x briefs x replicates", () => {
  const cells = planCells(SPEC);
  assert.equal(cells.length, 2 * 2 * 2);
  assert.equal(new Set(cells.map((c) => c.key)).size, 8, "every cell key is unique");
});

test("configHash is order-independent but content-sensitive", () => {
  const a = configHash({ harnessVersion: "1", engineSha: "abc", promptHash: "p" });
  const b = configHash({ promptHash: "p", engineSha: "abc", harnessVersion: "1" });
  assert.equal(a, b, "key order must not change the hash");
  assert.notEqual(a, configHash({ harnessVersion: "2", engineSha: "abc", promptHash: "p" }));
});

test("corpusHash participates in configHash once supplied (evals/corpus, issue #2)", () => {
  // configHash must stay backward-compatible: a config that never mentions
  // corpusHash (every config that existed before evals/corpus/) hashes
  // exactly as before, because the field loop skips `undefined` entries.
  const withoutCorpus = configHash({ harnessVersion: "1", engineSha: "abc", promptHash: "p" });
  const sameButExplicitlyUndefined = configHash({
    harnessVersion: "1",
    engineSha: "abc",
    promptHash: "p",
    corpusHash: undefined,
  });
  assert.equal(withoutCorpus, sameButExplicitlyUndefined, "an undefined corpusHash must not perturb the hash");

  // Once a corpusHash IS supplied, changing it changes configHash — the
  // load-bearing acceptance criterion from issue #2 ("corpus hash feeds
  // configHash"). This is the same mechanism that already protects
  // engineSha/promptHash/judgeHash; corpusHash is just another field in it.
  const configA = configHash({ harnessVersion: "1", engineSha: "abc", promptHash: "p", corpusHash: "corpus-aaa" });
  const configB = configHash({ harnessVersion: "1", engineSha: "abc", promptHash: "p", corpusHash: "corpus-bbb" });
  assert.notEqual(configA, configB, "a changed corpus hash must change configHash");
  assert.notEqual(configA, withoutCorpus, "supplying a corpusHash at all changes the hash vs. omitting it");
});

test("cellKey refuses to build an unversioned key", () => {
  assert.throws(() => cellKey({ armId: "B", briefId: "b1", replicate: 0 }), /cfg .*required/);
  assert.throws(() => cellKey({ armId: "B", briefId: "b1", replicate: -1, cfg: "x" }), /non-negative integer/);
  assert.throws(() => cellKey({ briefId: "b1", replicate: 0, cfg: "x" }), /required/);
});

// ── The additive core ───────────────────────────────────────────────────────

test("a second run reuses completed cells and only queues the missing ones", () => {
  const all = planCells(SPEC);
  const alreadyDone = all.slice(0, 5).map((c) => c.key);
  const { todo, reuse, stale } = planRun(SPEC, alreadyDone);
  assert.equal(reuse.length, 5, "completed cells are not re-run — the study is additive");
  assert.equal(todo.length, 3);
  assert.equal(stale.length, 0);
});

test("raising the replicate count adds only the new replicates", () => {
  const done = planCells(SPEC).map((c) => c.key); // all 8 done at replicates: 2
  const wider = { ...SPEC, replicates: 4 };
  const { todo, reuse } = planRun(wider, done);
  assert.equal(reuse.length, 8, "the original 8 observations still count");
  assert.equal(todo.length, 8, "only the 8 new replicates run");
  assert.ok(todo.every((c) => c.replicate >= 2));
});

test("adding an arm reuses every existing arm's cells", () => {
  const done = planCells(SPEC).map((c) => c.key);
  const wider = { ...SPEC, arms: [...SPEC.arms, { id: "G" }] };
  const { todo, reuse } = planRun(wider, done);
  assert.equal(reuse.length, 8);
  assert.equal(todo.length, 4, "only the new arm's cells run");
  assert.ok(todo.every((c) => c.armId === "G"));
});

test("a config change does NOT silently reuse prior results — it flags them stale", () => {
  const done = planCells(SPEC).map((c) => c.key);
  const bumped = { ...SPEC, config: { ...SPEC.config, engineSha: "deadbee" } };
  const { todo, reuse, stale } = planRun(bumped, done);
  assert.equal(reuse.length, 0, "results under a different engine SHA are never auto-reused");
  assert.equal(todo.length, 8, "the whole grid re-runs under the new config");
  assert.equal(stale.length, 8, "and the prior results are surfaced, not discarded");
  assert.ok(stale.every((c) => c.priorCfg && c.priorCfg !== c.cfg));
});

test("an unrelated stored key is ignored rather than misread", () => {
  const { todo, reuse, stale } = planRun(SPEC, ["not-a-cell-key", "arm=X|brief=zz|rep=0|cfg=zzz"]);
  assert.equal(reuse.length, 0);
  assert.equal(stale.length, 0);
  assert.equal(todo.length, 8);
});
