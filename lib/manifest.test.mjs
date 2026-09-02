// Tests for additive run planning: results accumulate across sessions without
// re-running completed work and without silently pooling incomparable results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CONFIG_FIELDS, armsConfigHash, cellKey, configHash, planCells, planRun } from "./manifest.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A fresh parse of the REAL arms.config.json. Read per-call so a test can
 *  mutate its copy freely — the point of most of these tests is to edit an
 *  arm and watch the hash react, and the file itself is never written. */
const readArmsConfig = () => JSON.parse(readFileSync(join(REPO_ROOT, "arms.config.json"), "utf8"));

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

test("clusterDistanceThreshold participates in configHash once supplied (issue #42)", () => {
  // Same additive-backward-compatibility property as corpusHash above: a
  // config that never mentions clusterDistanceThreshold hashes exactly as
  // it did before this field existed.
  const withoutThreshold = configHash({ harnessVersion: "1", engineSha: "abc", promptHash: "p" });
  const sameButExplicitlyUndefined = configHash({
    harnessVersion: "1",
    engineSha: "abc",
    promptHash: "p",
    clusterDistanceThreshold: undefined,
  });
  assert.equal(withoutThreshold, sameButExplicitlyUndefined, "an undefined clusterDistanceThreshold must not perturb the hash");

  // A threshold change is comparability-relevant — distinct_k is a direct
  // function of it (issue #42's headline finding) — so changing it must
  // change configHash the same way a prompt or judge change does.
  const configA = configHash({ harnessVersion: "1", engineSha: "abc", promptHash: "p", clusterDistanceThreshold: 0.2314 });
  const configB = configHash({ harnessVersion: "1", engineSha: "abc", promptHash: "p", clusterDistanceThreshold: 0.4923 });
  assert.notEqual(configA, configB, "a changed clusterDistanceThreshold must change configHash");
  assert.notEqual(configA, withoutThreshold, "supplying a clusterDistanceThreshold at all changes the hash vs. omitting it");
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

// ── issue #101: arms.config.json participates in configHash ─────────────────
//
// The headline regression guard. Before #101, arms.config.json was hashed
// nowhere at all: editing an arm's model assignment left configHash — and
// therefore every cellKey — completely unchanged, so planRun classified the
// new cells `reuse` and two different experiments were pooled with no `stale`
// warning. These tests fail if that coverage is ever removed again.

test("AC1/AC2 (#101) — changing an arm's model assignment moves configHash and cellKey", () => {
  const before = readArmsConfig();
  const after = readArmsConfig();

  // The issue's own worked example: arm C, homogeneous Sonnet, one slot
  // promoted to Opus. The smallest edit the study can express.
  assert.equal(after.arms.C.slots[0].model, "claude-sonnet-5", "fixture drifted: arm C should be homogeneous Sonnet");
  after.arms.C.slots[0].model = "claude-opus-5";

  assert.notEqual(
    armsConfigHash(after),
    armsConfigHash(before),
    "editing an arm's model assignment MUST change armsConfigHash — this is the single variable the study manipulates",
  );

  // And it must reach configHash / cellKey, not merely differ in isolation.
  const cfgBefore = configHash({ harnessVersion: "0.0.1", engineSha: "abc", armsConfigHash: armsConfigHash(before) });
  const cfgAfter = configHash({ harnessVersion: "0.0.1", engineSha: "abc", armsConfigHash: armsConfigHash(after) });
  assert.notEqual(cfgAfter, cfgBefore, "a changed armsConfigHash must change configHash");

  const keyBefore = cellKey({ armId: "C", briefId: "b1", replicate: 0, cfg: cfgBefore });
  const keyAfter = cellKey({ armId: "C", briefId: "b1", replicate: 0, cfg: cfgAfter });
  assert.notEqual(keyAfter, keyBefore, "a changed armsConfigHash must change cellKey");

  // The consequence that actually matters: prior cells are surfaced as stale,
  // never silently reused. This is the end-to-end statement of the defect.
  const spec = { arms: [{ id: "C" }], briefs: [{ id: "b1" }], replicates: 1, config: { armsConfigHash: armsConfigHash(before) } };
  const stored = planCells(spec).map((c) => c.key);
  const bumped = { ...spec, config: { armsConfigHash: armsConfigHash(after) } };
  const { reuse, stale } = planRun(bumped, stored);
  assert.equal(reuse.length, 0, "cells generated under the old model assignment are never auto-reused");
  assert.equal(stale.length, 1, "they are surfaced as stale instead");
});

test("#101 — the panel block's shape participates too, not only model assignment", () => {
  const before = readArmsConfig();
  for (const [field, value] of [["size", 6], ["ideasPerAgent", 7], ["maxRounds", 3]]) {
    const after = readArmsConfig();
    after.panel[field] = value;
    assert.notEqual(
      armsConfigHash(after),
      armsConfigHash(before),
      `changing panel.${field} must change armsConfigHash — this is what subsumes the removed per-spec ideasPerAgent/maxRounds fields`,
    );
  }
  // Per-ARM overrides too: arm A's totalIdeasRequested is the value the
  // retired per-spec fields could never have represented honestly.
  const armA = readArmsConfig();
  armA.arms.A.totalIdeasRequested = 31;
  assert.notEqual(armsConfigHash(armA), armsConfigHash(before), "a per-arm override must change armsConfigHash");
});

test("#101 — slot ORDER is significant, but key order is not", () => {
  const before = readArmsConfig();

  const reordered = readArmsConfig();
  // Arm E is a tiered mix (2xHaiku, 2xSonnet, 1xOpus), so reversing its slots
  // genuinely reassigns which persona runs which model.
  reordered.arms.E.slots.reverse();
  assert.notEqual(armsConfigHash(reordered), armsConfigHash(before), "slots are an ORDERED persona->model assignment");

  // Literal key order in the JSON is not a config change, and canonicalization
  // must absorb it — otherwise a reformatting pass invalidates the dataset.
  const rekeyed = readArmsConfig();
  rekeyed.panel = { maxRounds: rekeyed.panel.maxRounds, ideasPerAgent: rekeyed.panel.ideasPerAgent, size: rekeyed.panel.size };
  assert.equal(armsConfigHash(rekeyed), armsConfigHash(before), "key order must not change the hash");
});

test("#101 — documentation-only edits do NOT move the hash", () => {
  // The counterweight to the guard above, and what makes the denylist in
  // manifest.mjs legible: prose changes what a reader is TOLD about an arm,
  // never what was measured of it. Hashing it would falsely invalidate every
  // stored cell on a typo fix — the same reasoning Appendix B item 15 uses to
  // keep analysisHash out of configHash.
  const before = armsConfigHash(readArmsConfig());
  for (const mutate of [
    (c) => { c._comment += " (typo fixed)"; },
    (c) => { c._modelIdSource = "rewritten prose"; },
    (c) => { c.arms.C.label = "Homogeneous Sonnet 5 (mid tier)"; },
    (c) => { c.arms.A.purpose = "clarified"; },
    (c) => { c._newlyAddedNote = "an underscore-prefixed key added later"; },
  ]) {
    const after = readArmsConfig();
    mutate(after);
    assert.equal(armsConfigHash(after), before, "a documentation-only edit must not invalidate the dataset");
  }
});

test("#101 — a NEW non-prose field is hashed by default (denylist, not allowlist)", () => {
  // Deliberate: the failure mode this issue exists to end is under-coverage.
  // An allowlist would silently omit a measurement-relevant field added
  // later; a denylist errs toward a loud, conservative `stale` instead.
  const before = armsConfigHash(readArmsConfig());
  const after = readArmsConfig();
  after.arms.C.temperature = 0.7;
  assert.notEqual(armsConfigHash(after), before, "an unrecognized field must be hashed, not silently ignored");
});

test("#101 — armsConfigHash is a deterministic sha256-12 and refuses a non-object", () => {
  const cfg = readArmsConfig();
  assert.equal(armsConfigHash(cfg), armsConfigHash(readArmsConfig()), "hashing the same config twice must be deterministic");
  assert.match(armsConfigHash(cfg), /^[0-9a-f]{12}$/);
  for (const bad of [undefined, null, "arms.config.json", [], 42]) {
    assert.throws(() => armsConfigHash(bad), /armsConfigHash: the parsed arms\.config\.json object is required/);
  }
});

test("#101 — CONFIG_FIELDS declares armsConfigHash and no longer declares the per-arm values it subsumes", () => {
  // A declared-but-never-set field reads as covered and is worse than an
  // absent one (the issue's own AC). ideasPerAgent/maxRounds were per-ARM
  // values in a per-SPEC slot and could never have been set honestly, so they
  // are removed rather than stamped with the panel constant.
  assert.ok(CONFIG_FIELDS.includes("armsConfigHash"));
  assert.ok(!CONFIG_FIELDS.includes("ideasPerAgent"), "retired: subsumed by armsConfigHash");
  assert.ok(!CONFIG_FIELDS.includes("maxRounds"), "retired: subsumed by armsConfigHash");
  assert.equal(new Set(CONFIG_FIELDS).size, CONFIG_FIELDS.length, "no duplicate field names");
});

test("#101 — armsConfigHash is additive: a config that never sets it hashes as before", () => {
  // Same backward-compatibility property corpusHash and clusterDistanceThreshold
  // each established: configHash skips `undefined` fields.
  const base = { harnessVersion: "1", engineSha: "abc", promptHash: "p" };
  assert.equal(configHash(base), configHash({ ...base, armsConfigHash: undefined }));
});
