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
import {
  planPrune,
  pruneStore,
  foldCostRows,
  parseCellKey,
  parseAttemptKey,
  nextAttemptNumber,
  spendToDate,
  DEFAULT_ATTEMPT_RETENTION,
} from "./runner.mjs";

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

  assert.deepEqual(planPrune(store, { armIds: ["A"] }).evictions.map((e) => e.key).sort(), [a1, a2].sort());
  assert.deepEqual(planPrune(store, { briefIds: ["b1"] }).evictions.map((e) => e.key).sort(), [a1, b1].sort());
  assert.deepEqual(planPrune(store, { kinds: ["parse_failure"] }).evictions.map((e) => e.key), [a2]);
  assert.deepEqual(planPrune(store, { armIds: ["A"], kinds: ["rate_limited"] }).evictions.map((e) => e.key), [a1]);
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
  assert.equal(parseAttemptKey(`judge-call|cell=${cell}|judge=claude-opus-5|attempt=0`), null);
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
