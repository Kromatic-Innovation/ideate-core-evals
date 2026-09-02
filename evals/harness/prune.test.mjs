// Tests for the store prune and attempt-record retention policy (issue #98).
//
// Two loose ends from #90 closed by one capability: nothing could remove a
// record from the store. The two properties that matter, and that every test
// here is arranged around:
//
//   1. A legacy transient failure stored under `cell.key` can be cleared, and
//      afterwards `planRun` plans that cell `todo` again. Asserted end-to-end
//      through planRun, not by checking a key disappeared -- "the key is
//      gone" is the easy substitute assertion and it does not test the
//      operator story.
//   2. The money survives every removal. Asserted through `spendToDate()`,
//      never by reading bodies -- spendToDate is what enforces the spend
//      ceilings and what the study's cost is ultimately reported from, so it
//      is the only reader whose agreement counts.
//
// Hermetic: temp stores only, no provider, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ResultsStore } from "../../lib/store.mjs";
import { cellKey, configHash, planRun } from "../../lib/manifest.mjs";
import { RATE_TABLE } from "../../lib/price.mjs";
import { INTRINSIC_FAILURE_KINDS } from "../../lib/accounting.mjs";
import {
  planPrune,
  pruneStore,
  foldCostRows,
  parseCellKey,
  parseAttemptKey,
  nextAttemptNumber,
  spendToDate,
  ATTEMPT_FAMILIES,
  DEFAULT_ATTEMPT_RETENTION,
} from "./runner.mjs";
// The real judge-call writer (issue #108). Imported so these tests exercise
// the actual numbering, not a fixture's guess at the key shape.
import { meterJudgeCall } from "../judge/gate.mjs";

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-prune-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new ResultsStore(dir);
}

const CONFIG = { harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" };
const CFG = configHash(CONFIG);
const SPEC = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CONFIG };

/** A generation cost row, priced by the real pinned rate table. `2026-09-01`
 *  is deliberately AFTER claude-sonnet-5's `introUntil` (2026-08-31) so the
 *  default fixtures never straddle a dated rate change -- the test that DOES
 *  straddle it does so on purpose and says so. */
function row(cellKeyStr, { model = "claude-haiku-4-5", input = 1000, output = 500, timestamp = "2026-09-01T00:00:00Z" } = {}) {
  return { cellKey: cellKeyStr, timestamp, billing_mode: "api", model, input_tokens: input, output_tokens: output };
}

function putCell(store, { armId = "A", briefId = "b1", replicate = 0, cfg = CFG, state = "failed", kind = "rate_limited", rows, storedAt } = {}) {
  const key = cellKey({ armId, briefId, replicate, cfg });
  store.put({
    key,
    armId,
    briefId,
    replicate,
    cfg,
    storedAt,
    result: state === "completed" ? { candidates: ["idea"], distinct_k: 1 } : { candidates: [] },
    resolvedModels: { proposer: "claude-haiku-4-5" },
    accounting: state === "completed" ? { state } : { state, kind, detail: "429 after retries" },
    costRows: rows || [row(key)],
  });
  return key;
}

function putAttempt(store, { family = "generation-attempt", cell, attempt, rows } = {}) {
  const key = `${family}|cell=${cell}|attempt=${attempt}`;
  store.put({
    key,
    armId: `__${family}__`,
    briefId: cell,
    replicate: 0,
    cfg: CFG,
    result: { kind: family, cellKey: cell, attempt, failureKind: "rate_limited", detail: "429" },
    resolvedModels: { proposer: "claude-haiku-4-5" },
    accounting: { state: "failed", kind: "rate_limited", detail: "429" },
    costRows: rows || [row(cell, { input: 100 * (attempt + 1), output: 50 * (attempt + 1) })],
  });
  return key;
}

// ── AC 1: a legacy store can be repaired, end to end ────────────────────────

test("prune clears a legacy transient failure and planRun plans that cell `todo` again", (t) => {
  const store = tempStore(t);
  const key = putCell(store, { state: "failed", kind: "rate_limited" });
  assert.equal(planRun(SPEC, store.keys()).reuse.length, 1, "precondition: it is `reuse` forever before the prune");

  const before = spendToDate(store);
  const result = pruneStore(store, { kinds: ["rate_limited"], configHash: CFG });

  const plan = planRun(SPEC, store.keys());
  assert.equal(plan.todo.length, 1, "the operator story: the cell is re-attemptable");
  assert.equal(plan.todo[0].key, key);
  assert.equal(plan.reuse.length, 0);
  assert.equal(plan.stale.length, 0, "and it does NOT reappear as stale under some other hash");

  // The money did not go with it.
  const after = spendToDate(store);
  assert.equal(after.totalUsd, before.totalUsd);
  assert.deepEqual(after.byProvider, before.byProvider);
  assert.ok(after.totalUsd > 0, "guard: a fixture that cost nothing would make the assertion above vacuous");
  assert.ok(result.written.some((k) => k.startsWith(`pruned-cell|cell=${key}|`)), "the spend was re-homed under a salvage key");
});

test("the salvage record is invisible to planRun -- it must never masquerade as a cell", (t) => {
  const store = tempStore(t);
  putCell(store, { state: "failed", kind: "timeout" });
  pruneStore(store, { kinds: ["timeout"] });
  for (const key of store.keys()) {
    assert.equal(parseCellKey(key), null, `'${key}' must not parse as a cell key`);
  }
  assert.equal(planRun(SPEC, store.keys()).todo.length, 1);
});

test("a prune interrupted between the salvage write and the cell removal converges on re-run", (t) => {
  const store = tempStore(t);
  const key = putCell(store, { state: "failed", kind: "rate_limited", storedAt: "2026-09-01T10:00:00.000Z" });
  const oneSpend = spendToDate(store).totalUsd;

  // Money-first ordering means the crash window over-reports (the same money
  // sits in both the cell and its salvage) and never under-reports. Simulate
  // the crash exactly where it can happen.
  const realRemove = store.remove.bind(store);
  store.remove = () => {
    throw new Error("SIMULATED CRASH between the salvage write and the cell removal");
  };
  assert.throws(() => pruneStore(store, { kinds: ["rate_limited"] }), /SIMULATED CRASH/);
  store.remove = realRemove;
  assert.ok(store.has(key), "the cell is still there");
  assert.ok(store.has(`pruned-cell|cell=${key}|pruned=0`), "and so is its salvage");
  assert.ok(Math.abs(spendToDate(store).totalUsd - 2 * oneSpend) <= 1e-9, "the window over-counts, which is the recoverable direction");

  // Re-running converges: the salvage is recognised as this cell record's
  // own, reused rather than duplicated, and the cell finally goes.
  pruneStore(store, { kinds: ["rate_limited"] });
  assert.equal(store.has(key), false);
  assert.deepEqual(store.keys(), [`pruned-cell|cell=${key}|pruned=0`]);
  assert.ok(Math.abs(spendToDate(store).totalUsd - oneSpend) <= 1e-9, "back to exactly one spend");
});

test("a cell that re-ran and failed identically gets its OWN salvage -- that is a second real spend", (t) => {
  const store = tempStore(t);
  const key = putCell(store, { state: "failed", kind: "rate_limited", storedAt: "2026-09-01T10:00:00.000Z" });
  const oneSpend = spendToDate(store).totalUsd;
  pruneStore(store, { kinds: ["rate_limited"] });

  // The cell is re-attempted, burns tokens again, and fails the same way, so
  // the stored BODY is byte-identical to the one already salvaged. Content
  // equality here would be exactly wrong: two attempts happened and two
  // attempts were paid for.
  putCell(store, { state: "failed", kind: "rate_limited", storedAt: "2026-09-02T10:00:00.000Z" });
  pruneStore(store, { kinds: ["rate_limited"] });
  assert.ok(store.has(`pruned-cell|cell=${key}|pruned=0`));
  assert.ok(store.has(`pruned-cell|cell=${key}|pruned=1`));
  assert.ok(Math.abs(spendToDate(store).totalUsd - 2 * oneSpend) <= 1e-9, "both nights are counted");
});

// ── AC 2: a completed cell is protected ─────────────────────────────────────

test("prune refuses a completed cell without an explicit override, and reports the refusal", (t) => {
  const store = tempStore(t);
  const key = putCell(store, { state: "completed" });
  const plan = planPrune(store, { configHash: CFG, states: ["completed"] });
  assert.equal(plan.evictions.length, 0);
  assert.equal(plan.refused.length, 1);
  assert.equal(plan.refused[0].key, key);
  assert.match(plan.refused[0].reason, /completed/);

  pruneStore(store, { configHash: CFG, states: ["completed"] });
  assert.ok(store.has(key), "an apply without the override still must not delete paid-for data");
});

test("--allow-completed evicts a completed cell AND still preserves its spend", (t) => {
  const store = tempStore(t);
  const key = putCell(store, { state: "completed" });
  const before = spendToDate(store);

  pruneStore(store, { configHash: CFG, states: ["completed"], allowCompleted: true });
  assert.equal(store.has(key), false);
  assert.equal(spendToDate(store).totalUsd, before.totalUsd);
  assert.ok(before.totalUsd > 0);
});

test("the default state selector never reaches a completed cell at all", (t) => {
  const store = tempStore(t);
  const completed = putCell(store, { briefId: "b1", state: "completed" });
  const failed = putCell(store, { briefId: "b2", state: "failed", kind: "rate_limited" });
  const plan = planPrune(store, { configHash: CFG });
  assert.deepEqual(plan.evictions.map((e) => e.key), [failed]);
  assert.equal(plan.refused.length, 0, "a completed cell the default selector never selected is not a 'refusal'");
  assert.ok(store.has(completed));
});

// ── AC 3 + 4: bounded retention that keeps the money ────────────────────────

test("compaction reduces the record count AND leaves spendToDate exactly unchanged", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  for (let n = 0; n < 12; n++) putAttempt(store, { cell, attempt: n });

  const before = spendToDate(store);
  const keysBefore = store.keys().length;
  assert.equal(keysBefore, 12);
  assert.ok(before.totalUsd > 0);

  pruneStore(store, { keepAttempts: DEFAULT_ATTEMPT_RETENTION });

  // Both halves together. Either alone passes trivially: "spend unchanged"
  // is satisfied by doing nothing, and "fewer records" is satisfied by
  // deleting money. Only the conjunction is the property.
  const keysAfter = store.keys().length;
  assert.ok(keysAfter < keysBefore, `compaction must actually reduce the record count (${keysBefore} -> ${keysAfter})`);
  assert.equal(keysAfter, DEFAULT_ATTEMPT_RETENTION + 1, "the 5 newest attempts, plus one compacted record for the other 7");

  const after = spendToDate(store);
  assert.ok(Math.abs(after.totalUsd - before.totalUsd) <= 1e-9, `${before.totalUsd} vs ${after.totalUsd}`);
  assert.deepEqual(Object.keys(after.byProvider).sort(), Object.keys(before.byProvider).sort());
  for (const p of Object.keys(before.byProvider)) {
    assert.ok(Math.abs(after.byProvider[p] - before.byProvider[p]) <= 1e-9, `provider ${p}: ${before.byProvider[p]} vs ${after.byProvider[p]}`);
  }
});

test("compaction bounds the COST ROW count too, not merely the record count", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  for (let n = 0; n < 20; n++) putAttempt(store, { cell, attempt: n });

  pruneStore(store, { keepAttempts: 2 });
  const compacted = store.keys().find((k) => k.includes("-compacted|"));
  assert.ok(compacted, "a compacted record exists");
  // 18 attempts, all the same (cellKey, billing_mode, model) -> one row.
  // This is what makes the policy a BOUND rather than a rename: without the
  // fold, the compacted record would carry all 18 rows and spendToDate would
  // parse exactly as much as before.
  assert.equal(store.get(compacted).costRows.length, 1);
});

test("compaction is repeatable: a second prune folds the new attempts in without double counting", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  for (let n = 0; n < 8; n++) putAttempt(store, { cell, attempt: n });
  pruneStore(store, { keepAttempts: 2 });
  const afterFirst = spendToDate(store).totalUsd;

  // More bad nights arrive. nextAttemptNumber must not hand out a number
  // that collides with a retained record (the count-based derivation would).
  for (let i = 0; i < 5; i++) {
    const n = nextAttemptNumber(store, "generation-attempt", cell);
    assert.equal(store.has(`generation-attempt|cell=${cell}|attempt=${n}`), false, "the next attempt number is free");
    putAttempt(store, { cell, attempt: n });
  }
  const beforeSecond = spendToDate(store).totalUsd;
  assert.ok(beforeSecond > afterFirst);

  pruneStore(store, { keepAttempts: 2 });
  assert.ok(Math.abs(spendToDate(store).totalUsd - beforeSecond) <= 1e-9);
  assert.equal(store.keys().filter((k) => k.includes("-compacted|")).length, 1, "one compacted record per cell, not one per prune");
});

test("nextAttemptNumber derives from the highest attempt accounted for, across both shapes", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  assert.equal(nextAttemptNumber(store, "generation-attempt", cell), 0);
  for (let n = 0; n < 6; n++) putAttempt(store, { cell, attempt: n });
  assert.equal(nextAttemptNumber(store, "generation-attempt", cell), 6);

  pruneStore(store, { keepAttempts: 2 });
  // Records now: compacted through=3, raw 4, raw 5. A COUNT would say 3 --
  // colliding head-on with the retained attempt 4.
  assert.equal(store.keys().filter((k) => k.startsWith("generation-attempt")).length, 3);
  assert.equal(nextAttemptNumber(store, "generation-attempt", cell), 6);
});

test("attempt families are compacted independently -- a metrics attempt never folds into a generation one", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  for (let n = 0; n < 6; n++) putAttempt(store, { cell, attempt: n, family: "generation-attempt" });
  for (let n = 0; n < 6; n++) putAttempt(store, { cell, attempt: n, family: "metrics-attempt" });
  const before = spendToDate(store).totalUsd;

  pruneStore(store, { keepAttempts: 2 });
  assert.ok(store.has(`generation-attempt-compacted|cell=${cell}|through=3`));
  assert.ok(store.has(`metrics-attempt-compacted|cell=${cell}|through=3`));
  assert.ok(Math.abs(spendToDate(store).totalUsd - before) <= 1e-9);
});

// ── The fold's own guard ────────────────────────────────────────────────────

test("foldCostRows refuses to fold rows that straddle a dated rate change, and spend survives anyway", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  // claude-sonnet-5 carries introUntil 2026-08-31 with a cheaper introRate.
  // Rows on either side of that boundary price differently, so collapsing
  // them under one timestamp would silently reprice the ledger.
  const straddling = [
    row(cell, { model: "claude-sonnet-5", timestamp: "2026-08-01T00:00:00Z", input: 1_000_000, output: 1_000_000 }),
    row(cell, { model: "claude-sonnet-5", timestamp: "2026-10-01T00:00:00Z", input: 1_000_000, output: 1_000_000 }),
  ];
  const fold = foldCostRows(straddling, RATE_TABLE, { batch: false });
  assert.equal(fold.folded, false);
  assert.match(fold.reason, /reprice/);
  assert.deepEqual(fold.rows, straddling, "the original rows are returned untouched");

  // And end to end: a prune over such records still preserves the money --
  // the bound degrades, the ledger does not.
  for (let n = 0; n < 6; n++) putAttempt(store, { cell, attempt: n, rows: straddling.map((r) => ({ ...r })) });
  const before = spendToDate(store).totalUsd;
  pruneStore(store, { keepAttempts: 2 });
  assert.ok(Math.abs(spendToDate(store).totalUsd - before) <= 1e-9);
});

test("foldCostRows never folds a row carrying a null token count", (t) => {
  const cell = "arm=A|brief=b1|rep=0|cfg=" + CFG;
  const rows = [
    { cellKey: cell, timestamp: "2026-09-01T00:00:00Z", billing_mode: "api", model: "claude-haiku-4-5", input_tokens: null, output_tokens: 10 },
    { cellKey: cell, timestamp: "2026-09-02T00:00:00Z", billing_mode: "api", model: "claude-haiku-4-5", input_tokens: null, output_tokens: 10 },
  ];
  // null is meaningful in this ledger ("nothing to report" is not "zero"), so
  // these pass through rather than being summed into a fabricated number.
  const fold = foldCostRows(rows, RATE_TABLE, { batch: false });
  assert.equal(fold.folded, false);
  assert.deepEqual(fold.rows, rows);
});

test("foldCostRows sums per (cellKey, billing_mode, model) and keeps tokens_by_model rows in their own shape", (t) => {
  const cell = "arm=A|brief=b1|rep=0|cfg=" + CFG;
  const rows = [
    row(cell, { model: "claude-haiku-4-5", input: 100, output: 10 }),
    row(cell, { model: "claude-haiku-4-5", input: 200, output: 20, timestamp: "2026-09-02T00:00:00Z" }),
    row(cell, { model: "claude-opus-5", input: 5, output: 5 }),
    { cellKey: cell, timestamp: "2026-09-01T00:00:00Z", billing_mode: "api", tokens_by_model: { "claude-opus-5": { input_tokens: 7, output_tokens: 3 } } },
  ];
  const fold = foldCostRows(rows, RATE_TABLE, { batch: false });
  assert.equal(fold.folded, true);
  assert.equal(fold.rows.length, 3, "two haiku rows collapse; the opus row and the by-model row stay distinct");
  const haiku = fold.rows.find((r) => r.model === "claude-haiku-4-5");
  assert.equal(haiku.input_tokens, 300);
  assert.equal(haiku.output_tokens, 30);
  assert.equal(haiku.timestamp, "2026-09-02T00:00:00Z", "the latest timestamp in the group");
  assert.ok(fold.rows.some((r) => r.tokens_by_model), "a tokens_by_model row is never reshaped into single-model rows");
});

// ── Scoping: a store holds more than cells ──────────────────────────────────

test("scoping matches the cellKey grammar, never entry.cfg -- judge-call and phase0 records are unselectable", (t) => {
  const store = tempStore(t);
  const cell = putCell(store, { state: "failed", kind: "rate_limited" });
  // Observed on the #8 smoke store: a judge-call record's `cfg` is the JUDGE
  // MODEL ID and a phase0 record's is an OBJECT. A prune that filtered on
  // `entry.cfg` would treat these as cells.
  store.put({
    key: `judge-call|cell=${cell}|judge=claude-haiku-4-5|attempt=0`,
    armId: "__judge-call__",
    briefId: cell,
    replicate: 0,
    cfg: "claude-haiku-4-5",
    result: { kind: "judge-call" },
    resolvedModels: { judge: "claude-haiku-4-5" },
    accounting: { state: "failed", kind: "rate_limited", detail: "429" },
    costRows: [row(cell)],
  });
  store.put({
    key: "phase0|dat|2026-09-01",
    armId: "__phase0__",
    briefId: "dat",
    replicate: 0,
    cfg: { embedderId: "voyage-4-lite", threshold: 0.42 },
    result: { kind: "phase0" },
    resolvedModels: { embedder: "voyage-4-lite" },
    accounting: { state: "failed", kind: "harness_error", detail: "x" },
    costRows: [],
  });

  const plan = planPrune(store, { kinds: ["rate_limited"] });
  assert.deepEqual(plan.evictions.map((e) => e.key), [cell], "only the study cell is selectable");

  const before = spendToDate(store).totalUsd;
  pruneStore(store, { kinds: ["rate_limited"] });
  assert.ok(store.has(`judge-call|cell=${cell}|judge=claude-haiku-4-5|attempt=0`));
  assert.ok(store.has("phase0|dat|2026-09-01"));
  assert.ok(Math.abs(spendToDate(store).totalUsd - before) <= 1e-9);
});

test("scoping by configHash leaves cells under another config alone", (t) => {
  const store = tempStore(t);
  const otherCfg = configHash({ ...CONFIG, promptHash: "p2" });
  const mine = putCell(store, { briefId: "b1", cfg: CFG, kind: "rate_limited" });
  const theirs = putCell(store, { briefId: "b1", cfg: otherCfg, kind: "rate_limited" });
  pruneStore(store, { configHash: CFG, kinds: ["rate_limited"] });
  assert.equal(store.has(mine), false);
  assert.ok(store.has(theirs));
});

test("scoping by arm/brief/kind each narrow the selection independently", (t) => {
  const store = tempStore(t);
  const a1 = putCell(store, { armId: "A", briefId: "b1", kind: "rate_limited" });
  const a2 = putCell(store, { armId: "A", briefId: "b2", kind: "parse_failure" });
  const b1 = putCell(store, { armId: "B", briefId: "b1", kind: "rate_limited" });

  // --arms A alone does NOT sweep up a2: the default kind filter is the
  // store-absent sets, and `parse_failure` is intrinsic. See the next test.
  assert.deepEqual(planPrune(store, { armIds: ["A"] }).evictions.map((e) => e.key), [a1]);
  assert.deepEqual(planPrune(store, { briefIds: ["b1"] }).evictions.map((e) => e.key).sort(), [a1, b1].sort());
  assert.deepEqual(planPrune(store, { kinds: ["parse_failure"] }).evictions.map((e) => e.key), [a2]);
  assert.deepEqual(planPrune(store, { armIds: ["A"], kinds: ["rate_limited"] }).evictions.map((e) => e.key), [a1]);
  assert.deepEqual(planPrune(store, { armIds: ["A"], kinds: INTRINSIC_FAILURE_KINDS }).evictions.map((e) => e.key), [a2]);
});

test("the default kind filter never reaches an intrinsic failure -- that is a measurement, not a fault", (t) => {
  const store = tempStore(t);
  // The #8 smoke store's nine failed cells are all `empty_pool` -- IC-08's
  // silent mode, one of the behaviours the study exists to measure. The
  // natural "repair my legacy store" invocation is `--prune --cfg <hash>`,
  // and without a default kind filter it would evict every one of them; the
  // arm's real failure rate would then be re-rolled toward zero on the next
  // run. The spend survives an eviction, the observation does not.
  const intrinsic = [
    putCell(store, { briefId: "b1", kind: "empty_pool" }),
    putCell(store, { briefId: "b2", kind: "parse_failure" }),
    putCell(store, { briefId: "b3", kind: "refusal" }),
  ];
  const storeAbsent = [
    putCell(store, { briefId: "b4", kind: "rate_limited" }),
    putCell(store, { briefId: "b5", kind: "timeout" }),
    putCell(store, { briefId: "b6", kind: "payment_required" }),
  ];

  const plan = planPrune(store, { configHash: CFG });
  assert.deepEqual(plan.evictions.map((e) => e.key).sort(), storeAbsent.slice().sort());

  pruneStore(store, { configHash: CFG });
  for (const key of intrinsic) assert.ok(store.has(key), `${key} must survive an unqualified prune`);

  // Naming them explicitly is the opt-in, and it works.
  pruneStore(store, { configHash: CFG, kinds: INTRINSIC_FAILURE_KINDS });
  for (const key of intrinsic) assert.equal(store.has(key), false);
});

test("planPrune with no selector plans zero evictions -- there is no all-or-nothing wipe", (t) => {
  const store = tempStore(t);
  putCell(store, { kind: "rate_limited" });
  putCell(store, { briefId: "b2", state: "completed" });
  const plan = planPrune(store, {});
  assert.equal(plan.selectorsGiven, false);
  assert.equal(plan.evictions.length, 0);
  assert.equal(plan.refused.length, 0);
});

// ── The dry run ─────────────────────────────────────────────────────────────

test("planPrune writes nothing: the store is byte-identical afterwards", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  putCell(store, { kind: "rate_limited" });
  for (let n = 0; n < 9; n++) putAttempt(store, { cell, attempt: n });

  const keysBefore = store.keys();
  const spendBefore = spendToDate(store).totalUsd;
  const plan = planPrune(store, { kinds: ["rate_limited"], keepAttempts: 2 });
  assert.ok(plan.evictions.length > 0 && plan.compactions.length > 0, "guard: the dry run must have had something to report");
  assert.deepEqual(store.keys(), keysBefore);
  assert.equal(spendToDate(store).totalUsd, spendBefore);
  assert.deepEqual(new ResultsStore(store.dir).keys(), keysBefore, "and nothing landed on disk either");
});

test("planPrune's keysAfter matches what an apply actually leaves behind", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  putCell(store, { briefId: "b2", kind: "timeout" });
  for (let n = 0; n < 9; n++) putAttempt(store, { cell, attempt: n });

  const plan = planPrune(store, { kinds: ["timeout"], keepAttempts: 3 });
  pruneStore(store, { kinds: ["timeout"], keepAttempts: 3 });
  assert.equal(store.keys().length, plan.keysAfter, "the dry run's headline number must not lie");
});

// ── Key parsing ─────────────────────────────────────────────────────────────

test("parseAttemptKey handles the embedded cell key, which itself contains | and =", (t) => {
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 3, cfg: CFG });
  assert.deepEqual(parseAttemptKey(`generation-attempt|cell=${cell}|attempt=7`), {
    family: "generation-attempt",
    cellKey: cell,
    through: 7,
    compacted: false,
  });
  assert.deepEqual(parseAttemptKey(`metrics-attempt-compacted|cell=${cell}|through=4`), {
    family: "metrics-attempt",
    cellKey: cell,
    through: 4,
    compacted: true,
  });
  assert.equal(parseAttemptKey(cell), null);
  // #108: judge-call is now a compacted family, and its extra `|judge=<model>`
  // segment is absorbed into the parsed `cellKey` by the same split-on-the-
  // last-`|attempt=` rule -- no per-family branch. The composite IS the
  // identity attempts are numbered and grouped per: two judge models scoring
  // one pool are two independent sequences.
  assert.deepEqual(parseAttemptKey(`judge-call|cell=${cell}|judge=claude-opus-5|attempt=0`), {
    family: "judge-call",
    cellKey: `${cell}|judge=claude-opus-5`,
    through: 0,
    compacted: false,
  });
  assert.deepEqual(parseAttemptKey(`judge-call-compacted|cell=${cell}|judge=gpt-5.6-terra|through=4`), {
    family: "judge-call",
    cellKey: `${cell}|judge=gpt-5.6-terra`,
    through: 4,
    compacted: true,
  });
  // Round-trip: the compacted key planPrune builds from a parsed raw key
  // re-parses to the same family/cellKey. A drift here is a silent restart of
  // the attempt sequence at 0.
  const raw = parseAttemptKey(`judge-call|cell=${cell}|judge=claude-opus-5|attempt=9`);
  const recompacted = parseAttemptKey(`judge-call-compacted|cell=${raw.cellKey}|through=${raw.through}`);
  assert.equal(recompacted.family, raw.family);
  assert.equal(recompacted.cellKey, raw.cellKey);
  assert.equal(recompacted.through, 9);
});

test("parseCellKey accepts a real cell key and rejects every side-ledger shape", (t) => {
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 2, cfg: CFG });
  assert.deepEqual(parseCellKey(cell), { armId: "A", briefId: "b1", replicate: 2, cfg: CFG });
  assert.equal(parseCellKey(`generation-attempt|cell=${cell}|attempt=0`), null);
  assert.equal(parseCellKey(`pruned-cell|cell=${cell}|pruned=0`), null);
  assert.equal(parseCellKey("phase0|dat|2026-09-01"), null);
});

// ── The verification pruneStore does on itself ──────────────────────────────

test("pruneStore reports the spend it verified, and the figure is non-zero for a real store", (t) => {
  const store = tempStore(t);
  putCell(store, { kind: "rate_limited" });
  const result = pruneStore(store, { kinds: ["rate_limited"] });
  assert.ok(result.spendBefore.totalUsd > 0);
  assert.equal(result.spendAfter.totalUsd, result.spendBefore.totalUsd);
  assert.deepEqual(result.removed.length, 1);
});

// ── judge-call compaction (issue #108) ──────────────────────────────────
// #98 left judge-call records out for one reason: meterJudgeCall numbered
// attempts by COUNTING matching keys, so the first fold would have made the
// next attempt collide with a retained record. These exercise the real
// meterJudgeCall rather than a synthetic putAttempt() -- the whole defect was
// a disagreement between the writer's numbering and the pruner's grammar, and
// a fixture that reimplements the key shape cannot catch that disagreement.

const JUDGE_A = "claude-opus-5";
const JUDGE_B = "gpt-5.6-terra";

/** Assert the ledger came through a fold intact, to the SAME tolerance
 *  `pruneStore()` itself throws on (1e-9 relative, see its `close`). Folding
 *  re-associates a float sum -- N rows priced and added, versus their tokens
 *  added and priced once -- so the two agree to within an ULP or so and not
 *  always bit-for-bit. Asserting exact equality here would be asserting a
 *  property of IEEE-754 addition order rather than the property #108 is
 *  about, and it is the production check, not this test, that defines what
 *  "the money survived" means. */
function assertSpendPreserved(after, before, msg) {
  const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  assert.ok(close(after.totalUsd, before.totalUsd), `${msg}: $${before.totalUsd} before, $${after.totalUsd} after`);
  const providers = new Set([...Object.keys(before.byProvider), ...Object.keys(after.byProvider)]);
  for (const p of providers) {
    assert.ok(close(before.byProvider[p] || 0, after.byProvider[p] || 0), `${msg}: provider ${p} drifted`);
  }
}

/** Write one real judge-call record through gate.mjs's own metering path. */
function meterJudge(store, cell, judgeModel, { input = 1200, output = 300, timestamp = "2026-09-01T00:00:00Z" } = {}) {
  return meterJudgeCall({
    store,
    cellKey: cell,
    judgeModel,
    tokens: { input_tokens: input, output_tokens: output },
    timestamp,
  });
}

test("#108 AC3: compacting judge-call records leaves spendToDate() untouched AND strictly shrinks the store", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  for (let n = 0; n < 8; n++) {
    const { key } = meterJudge(store, cell, JUDGE_A, { input: 1000 + 10 * n });
    assert.equal(key, `judge-call|cell=${cell}|judge=${JUDGE_A}|attempt=${n}`, "precondition: attempts number 0..7 with nothing folded");
  }

  const before = spendToDate(store);
  const keysBefore = store.keys().length;
  assert.ok(before.totalUsd > 0, "guard: a fixture that cost nothing makes the spend assertion vacuous");

  const result = pruneStore(store, { keepAttempts: 5 });

  const after = spendToDate(store);
  const keysAfter = store.keys().length;
  // BOTH halves, in one test, deliberately. Either alone passes trivially:
  // doing nothing preserves the spend, and deleting everything shrinks the
  // store. Only the conjunction is the property #108 is about.
  assertSpendPreserved(after, before, "a fold must never change what the study cost");
  assert.ok(keysAfter < keysBefore, `the store must actually shrink (${keysBefore} -> ${keysAfter})`);
  assert.equal(keysAfter, keysBefore - 2, "8 records, keep 5: attempts 0..2 fold into one");

  const compactedKey = `judge-call-compacted|cell=${cell}|judge=${JUDGE_A}|through=2`;
  assert.ok(store.has(compactedKey), "the fold lands under the compacted key shape");
  for (const n of [0, 1, 2]) assert.ok(!store.has(`judge-call|cell=${cell}|judge=${JUDGE_A}|attempt=${n}`), `attempt ${n} was folded away`);
  for (const n of [3, 4, 5, 6, 7]) assert.ok(store.has(`judge-call|cell=${cell}|judge=${JUDGE_A}|attempt=${n}`), `attempt ${n} is inside the retention window`);
  assert.equal(result.plan.compactions.length, 1);
  assert.equal(result.plan.compactions[0].family, "judge-call");

  // The point of the numbering change, asserted where it bites: the NEXT
  // real judge call after a fold. Under the pre-#108 count this is
  // `attempt=6` (6 surviving keys), which collides with the retained
  // attempt 6 and makes put() throw.
  const next = meterJudge(store, cell, JUDGE_A, { input: 4242 });
  assert.equal(next.key, `judge-call|cell=${cell}|judge=${JUDGE_A}|attempt=8`);
  assert.equal(next.written, true, "and it is a genuinely new record, not a byte-identical no-op onto an existing one");
  assert.ok(spendToDate(store).totalUsd > after.totalUsd, "a retry spends real money again and the ledger says so");
});

test("#108: judge-call attempts are numbered and compacted per (cell, judge model), not per cell", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  for (let n = 0; n < 8; n++) meterJudge(store, cell, JUDGE_A);
  for (let n = 0; n < 2; n++) {
    const { key } = meterJudge(store, cell, JUDGE_B);
    assert.equal(key, `judge-call|cell=${cell}|judge=${JUDGE_B}|attempt=${n}`, "a second judge on the same pool starts its own sequence at 0");
  }

  const before = spendToDate(store);
  pruneStore(store, { keepAttempts: 5 });

  assert.ok(store.has(`judge-call-compacted|cell=${cell}|judge=${JUDGE_A}|through=2`), "the busy judge folds");
  for (let n = 0; n < 2; n++) {
    assert.ok(store.has(`judge-call|cell=${cell}|judge=${JUDGE_B}|attempt=${n}`), "the quiet judge is under the bound and is left entirely alone");
  }
  assert.ok(!store.keys().some((k) => k.startsWith(`judge-call-compacted|cell=${cell}|judge=${JUDGE_B}`)));
  assertSpendPreserved(spendToDate(store), before, "folding one judge's records must not move the other's money");
  assert.equal(nextAttemptNumber(store, "judge-call", `${cell}|judge=${JUDGE_B}`), 2, "and its numbering is unaffected by the other judge's fold");
});

test("#108 AC4: a judge-call fold whose rows straddle a dated rate change is abandoned, not mispriced", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  // claude-sonnet-5 is the one model in the pinned RATE_TABLE with an
  // introductory regime (`introUntil: 2026-08-31`). Read from the table
  // rather than hardcoded, so this test fails loudly if the fixture stops
  // being a straddle case at all.
  assert.ok(RATE_TABLE["claude-sonnet-5"].introUntil, "precondition: the straddle fixture needs a model with a dated rate change");
  const STRADDLE_JUDGE = "claude-sonnet-5";
  const beforeIntroEnd = "2026-08-30T00:00:00Z";
  const afterIntroEnd = "2026-09-01T00:00:00Z";

  // Direction 1: a straddling group is refused.
  const straddling = [
    row(cell, { model: STRADDLE_JUDGE, timestamp: beforeIntroEnd }),
    row(cell, { model: STRADDLE_JUDGE, timestamp: afterIntroEnd }),
  ];
  const refused = foldCostRows(straddling, RATE_TABLE, { batch: true });
  assert.equal(refused.folded, false);
  assert.match(refused.reason, /reprice/);
  assert.deepEqual(refused.rows, straddling, "the ORIGINAL rows come back, untouched");

  // Direction 2: the otherwise-identical non-straddling group DOES fold --
  // without this half, "abandoned correctly" is indistinguishable from
  // "never folds anything".
  const sameSide = [
    row(cell, { model: STRADDLE_JUDGE, timestamp: afterIntroEnd }),
    row(cell, { model: STRADDLE_JUDGE, timestamp: afterIntroEnd }),
  ];
  assert.equal(foldCostRows(sameSide, RATE_TABLE, { batch: true }).folded, true);

  // And end to end through the prune: the RECORD count still comes down (the
  // bound is the point), the ROWS are carried through unfolded, the reason is
  // reported to the operator, and the ledger is bit-for-bit unchanged.
  for (let n = 0; n < 8; n++) {
    meterJudge(store, cell, STRADDLE_JUDGE, { timestamp: n % 2 === 0 ? beforeIntroEnd : afterIntroEnd });
  }
  const before = spendToDate(store);
  const keysBefore = store.keys().length;
  const result = pruneStore(store, { keepAttempts: 5 });

  assert.equal(result.plan.compactions.length, 1);
  const c = result.plan.compactions[0];
  assert.equal(c.rowsFolded, false, "the fold was abandoned");
  assert.match(c.foldSkippedReason, /reprice/);
  assert.equal(c.rows.length, c.rowsBefore, "every original row survives verbatim");
  assert.ok(store.keys().length < keysBefore, "but the record count still comes down");
  assert.equal(spendToDate(store).totalUsd, before.totalUsd);
  assert.deepEqual(spendToDate(store).byProvider, before.byProvider);
});

test("#108: compaction removes `completed` judge-call records without the operator reaching for --allow-completed", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  const keys = [];
  for (let n = 0; n < 8; n++) keys.push(meterJudge(store, cell, JUDGE_A).key);

  // The guard is real and still armed for anyone else: a bare remove() of
  // one of these refuses, exactly as it does for a paid-for cell.
  assert.throws(() => store.remove([keys[0]]), /allowCompleted/);

  // The prune reaches them anyway, because a compaction deletes no
  // measurement: judge SCORES are a separate family, and the fold is
  // priced-verified before it is written.
  const before = spendToDate(store);
  pruneStore(store, { keepAttempts: 5 });
  assert.ok(!store.has(keys[0]));
  assertSpendPreserved(spendToDate(store), before, "a compaction deletes records, never money");

  // A completed CELL is still protected -- the flag above is scoped to the
  // compaction path and cannot be reached by an eviction.
  const completed = putCell(store, { briefId: "b9", state: "completed" });
  const plan = planPrune(store, { configHash: CFG, states: ["completed"], keepAttempts: null });
  assert.equal(plan.evictions.length, 0);
  assert.equal(plan.refused.length, 1);
  assert.equal(plan.refused[0].key, completed);
  assert.ok(store.has(completed));
});

test("#108 AC5: judge-call records are covered by the SAME prune invocation as every other family", (t) => {
  const store = tempStore(t);
  const cell = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG });
  for (let n = 0; n < 8; n++) putAttempt(store, { cell, attempt: n });
  for (let n = 0; n < 8; n++) meterJudge(store, cell, JUDGE_A);

  const before = spendToDate(store);
  // One call, one option (`keepAttempts`), no judge-specific selector.
  const result = pruneStore(store, { keepAttempts: 5 });

  const families = result.plan.compactions.map((c) => c.family).sort();
  assert.deepEqual(families, ["generation-attempt", "judge-call"], "both families in one plan");
  assertSpendPreserved(spendToDate(store), before, "one prune, two families, same ledger");
  assert.ok(ATTEMPT_FAMILIES.includes("judge-call"), "and it is a first-class member of the family list, not a special case");
});
