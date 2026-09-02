import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempStore } from "../../lib/store.mjs";
import { cellKey, configHash } from "../../lib/manifest.mjs";
import { buildFrame, summarizeByArm, DifferentialAttritionError } from "./frame.mjs";

const CONFIG = { harnessVersion: "0.0.1", engineSha: "abc", promptHash: "p1" };
const CFG = configHash(CONFIG);
const STALE_CFG = configHash({ ...CONFIG, promptHash: "p2" });

function put(store, { armId, briefId, replicate, cfg = CFG, state = "completed", distinctK = 3, costs = [] }) {
  const key = cellKey({ armId, briefId, replicate, cfg });
  const costRows = costs.map((c, i) => ({
    cellKey: key,
    timestamp: "2026-07-30T12:00:00Z",
    billing_mode: "api",
    model: "claude-haiku-4-5",
    input_tokens: c.in,
    output_tokens: c.out,
  }));
  const record = {
    key,
    armId,
    briefId,
    replicate,
    cfg,
    resolvedModels: { proposer: "claude-haiku-4-5" },
    costRows,
  };
  if (state === "completed") {
    record.result = { distinct_k: distinctK };
    record.accounting = { state: "completed" };
  } else if (state === "failed") {
    record.result = { failed: true, failureKind: "parse_failure" };
    record.accounting = { state: "failed", kind: "parse_failure", detail: "no json" };
  } else if (state === "skipped") {
    record.result = { skipped: true };
    record.accounting = { state: "skipped", detail: "budget cap" };
  }
  store.put(record);
  return key;
}

test("buildFrame: includes only completed cells under the requested config", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  put(store, { armId: "B", briefId: "b1", replicate: 0 });
  const frame = buildFrame(store, { config: CONFIG });
  assert.equal(frame.rows.length, 2);
  assert.equal(frame.configHash, CFG);
});

test("buildFrame: rows are sorted deterministically by cellKey", () => {
  const store = makeTempStore();
  put(store, { armId: "B", briefId: "b1", replicate: 0 });
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  const frame = buildFrame(store, { config: CONFIG });
  const keys = frame.rows.map((r) => r.cellKey);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test("buildFrame: failed cells are excluded from rows but tallied per arm/kind", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  put(store, { armId: "A", briefId: "b2", replicate: 0, state: "failed" });
  const frame = buildFrame(store, { config: CONFIG });
  assert.equal(frame.rows.length, 1);
  assert.equal(frame.excluded.failed.length, 1);
  assert.deepEqual(frame.failuresByArm.A, { parse_failure: 1 });
});

test("buildFrame: skipped cells are excluded from rows but tallied per arm", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  put(store, { armId: "A", briefId: "b2", replicate: 0, state: "skipped" });
  const frame = buildFrame(store, { config: CONFIG });
  assert.equal(frame.rows.length, 1);
  assert.equal(frame.excluded.skipped.length, 1);
  assert.equal(frame.skippedByArm.A, 1);
});

test("buildFrame: cells under a different configHash are reported as stale, never pooled", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  put(store, { armId: "A", briefId: "b1", replicate: 1, cfg: STALE_CFG });
  const frame = buildFrame(store, { config: CONFIG });
  assert.equal(frame.rows.length, 1);
  assert.equal(frame.excluded.stale.length, 1);
  assert.equal(frame.excluded.stale[0].cfg, STALE_CFG);
});

test("buildFrame: a completed cell missing the response field throws a named error", () => {
  const store = makeTempStore();
  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  store.put({
    key,
    armId: "A",
    briefId: "b1",
    replicate: 0,
    cfg: CFG,
    result: { candidates: [] }, // no distinct_k
    resolvedModels: { proposer: "x" },
    accounting: { state: "completed" },
    costRows: [],
  });
  assert.throws(() => buildFrame(store, { config: CONFIG }), /no numeric result\.distinct_k/);
});

test("buildFrame: responseField is a parameter, not hardcoded to distinct_k", () => {
  const store = makeTempStore();
  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  store.put({
    key,
    armId: "A",
    briefId: "b1",
    replicate: 0,
    cfg: CFG,
    result: { judgeScore: 7.5 },
    resolvedModels: { proposer: "x" },
    accounting: { state: "completed" },
    costRows: [],
  });
  const frame = buildFrame(store, { config: CONFIG, responseField: "judgeScore" });
  assert.equal(frame.rows[0].response, 7.5);
  assert.equal(frame.responseField, "judgeScore");
});

test("buildFrame: prices cost rows at read time via lib/price.mjs, never a stored dollar figure", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0, costs: [{ in: 1_000_000, out: 1_000_000 }] });
  const frame = buildFrame(store, { config: CONFIG });
  // claude-haiku-4-5: $1 in / $5 out per MTok -> 1M in + 1M out = $6
  assert.equal(frame.rows[0].costUsd, 6);
});

test("buildFrame: armLevels/briefLevels default to sorted ids seen, or can be pinned explicitly", () => {
  const store = makeTempStore();
  put(store, { armId: "B", briefId: "b2", replicate: 0 });
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  const derived = buildFrame(store, { config: CONFIG });
  assert.deepEqual(derived.armLevels, ["A", "B"]);
  assert.deepEqual(derived.briefLevels, ["b1", "b2"]);

  const pinned = buildFrame(store, { config: CONFIG, armLevels: ["A", "B", "C"], briefLevels: ["b1", "b2", "b3"] });
  assert.deepEqual(pinned.armLevels, ["A", "B", "C"]);
});

test("summarizeByArm: mean response and mean cost per arm, ordered by armLevels", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0, distinctK: 10, costs: [{ in: 1000, out: 1000 }] });
  put(store, { armId: "A", briefId: "b2", replicate: 0, distinctK: 20, costs: [{ in: 1000, out: 1000 }] });
  put(store, { armId: "B", briefId: "b1", replicate: 0, distinctK: 5, costs: [{ in: 1000, out: 1000 }] });
  const frame = buildFrame(store, { config: CONFIG });
  const summary = summarizeByArm(frame);
  assert.deepEqual(summary.map((s) => s.armId), ["A", "B"]);
  assert.equal(summary[0].n, 2);
  assert.equal(summary[0].meanResponse, 15);
});

test("buildFrame: rejects a non-store argument", () => {
  assert.throws(() => buildFrame({}, { config: CONFIG }), /ResultsStore/);
});

// ── Differential attrition (#46 QA SHOULD): an arm whose cells all failed
//    and/or were skipped must be caught HERE, named accurately, never left
//    to surface downstream as a misleading fit.mjs error. ──────────────────

test("buildFrame: an arm with zero completed rows (all failed) throws DifferentialAttritionError, not silently included", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  put(store, { armId: "B", briefId: "b1", replicate: 0, state: "failed" });
  assert.throws(() => buildFrame(store, { config: CONFIG }), DifferentialAttritionError);
  assert.throws(() => buildFrame(store, { config: CONFIG }), /arm 'B' has zero completed rows/);
});

test("buildFrame: an arm with zero completed rows (all skipped) also throws DifferentialAttritionError", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  put(store, { armId: "B", briefId: "b1", replicate: 0, state: "skipped" });
  assert.throws(() => buildFrame(store, { config: CONFIG }), DifferentialAttritionError);
});

test("buildFrame: a caller-pinned armLevel the store has NO cells for at all is 'not yet run', not attrition", () => {
  const store = makeTempStore();
  put(store, { armId: "A", briefId: "b1", replicate: 0 });
  // "C" never appears in the store in any state (completed/failed/skipped)
  // -- distinct from attrition (an arm that WAS run and all its cells
  // failed/skipped). Pinning a not-yet-run level must still be allowed
  // (existing behavior this fix must not regress).
  const frame = buildFrame(store, { config: CONFIG, armLevels: ["A", "C"] });
  assert.deepEqual(frame.armLevels, ["A", "C"]);
});
