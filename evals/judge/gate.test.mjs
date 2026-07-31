// Tests for the ρ validation gate (issue #4, AC7/AC8/AC10): fails closed,
// lives as a store record, and judge calls are metered like any other cell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempStore } from "../../lib/store.mjs";
import {
  spearmanRho,
  validateJudge,
  validationKey,
  recordValidation,
  attachIdeaLevelScores,
  meterJudgeCall,
} from "./gate.mjs";

// ── spearmanRho ──────────────────────────────────────────────────────────────

test("spearmanRho: perfect positive correlation is 1", () => {
  assert.equal(spearmanRho([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1);
});

test("spearmanRho: perfect anti-correlation is -1", () => {
  assert.equal(spearmanRho([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]), -1);
});

test("spearmanRho: handles tied ranks via average-rank convention", () => {
  // a has a tie at positions 2,3 (both value 5); Spearman with average ranks
  // should still report a strong positive correlation, not throw or NaN.
  const rho = spearmanRho([1, 5, 5, 8], [1, 6, 5, 9]);
  assert.ok(rho > 0.9, `expected strong positive correlation with ties, got ${rho}`);
});

test("spearmanRho throws on mismatched lengths or too-short input", () => {
  assert.throws(() => spearmanRho([1, 2], [1]), /equal-length arrays/);
  assert.throws(() => spearmanRho([1], [1]), /at least 2 paired observations/);
});

test("spearmanRho throws when an input has zero rank variance (all tied)", () => {
  assert.throws(() => spearmanRho([5, 5, 5], [1, 2, 3]), /zero variance/);
});

// ── AC7: validateJudge — perfect / anti-correlated / just-below-floor ──────

const FLOOR_CONFIG = { judge: { rhoFloor: 0.4 } };

test("AC7 — perfect correlation (rho=1) passes against floor 0.4", () => {
  const judgeScores = [1, 2, 3, 4, 5, 6, 7, 8];
  const expertScores = [10, 20, 30, 40, 50, 60, 70, 80];
  const { rho, floor, verdict } = validateJudge({ judgeScores, expertScores, config: FLOOR_CONFIG });
  assert.equal(rho, 1);
  assert.equal(floor, 0.4);
  assert.equal(verdict, "pass");
});

test("AC7 — anti-correlated (rho=-1) drops", () => {
  const judgeScores = [1, 2, 3, 4, 5, 6, 7, 8];
  const expertScores = [80, 70, 60, 50, 40, 30, 20, 10];
  const { rho, verdict } = validateJudge({ judgeScores, expertScores, config: FLOOR_CONFIG });
  assert.equal(rho, -1);
  assert.equal(verdict, "drop");
});

test("AC7 — just-below-floor rho drops", () => {
  // Constructed so rho lands just under 0.4: mostly concordant ranking with
  // one large inversion to pull it down.
  const judgeScores = [1, 2, 3, 4, 5, 6, 7, 8];
  const expertScores = [8, 7, 3, 4, 5, 6, 2, 1];
  const { rho, verdict } = validateJudge({ judgeScores, expertScores, config: FLOOR_CONFIG });
  assert.ok(rho < 0.4, `test fixture must produce rho < 0.4, got ${rho}`);
  assert.equal(verdict, "drop");
});

test("AC7 — validateJudge throws if the floor is unset (delegates to resolveRhoFloor)", () => {
  assert.throws(
    () => validateJudge({ judgeScores: [1, 2, 3], expertScores: [1, 2, 3], config: {} }),
    /no rho floor is registered/,
  );
});

test("AC7 — a drop is recorded with idea_level_metrics: 'dropped' via recordValidation + attach", (t) => {
  const store = makeTempStore("judge-gate-test-");
  const judgeHash = "judgehashabc1";
  const { rho, floor, verdict } = validateJudge({
    judgeScores: [1, 2, 3, 4, 5],
    expertScores: [5, 4, 3, 2, 1],
    config: FLOOR_CONFIG,
  });
  assert.equal(verdict, "drop");
  recordValidation(store, { judgeHash, sliceId: "sliceA", rho, floor, verdict });

  const result = attachIdeaLevelScores({ store, judgeHash, pools: [{ poolKey: "p1" }], ideaLevelScores: [{ idea: "x", score: 9 }] });
  assert.equal(result.idea_level_metrics, "dropped");
  assert.deepEqual(result.pools, [{ poolKey: "p1" }]);
  assert.ok(!result.ideas, "idea-level scores must never be attached on a drop");
});

// ── AC8: fails closed ────────────────────────────────────────────────────────

test("AC8 — attachIdeaLevelScores THROWS with no validation record at all", () => {
  const store = makeTempStore("judge-gate-test-");
  assert.throws(
    () => attachIdeaLevelScores({ store, judgeHash: "nonexistent-hash", pools: [{ poolKey: "p1" }], ideaLevelScores: [{ idea: "x" }] }),
    /no validation record found/,
  );
});

test("AC8 — a recorded FAILING validation forces pool-level-only output", () => {
  const store = makeTempStore("judge-gate-test-");
  const judgeHash = "judgehashdrop";
  recordValidation(store, { judgeHash, sliceId: "sliceB", rho: -0.2, floor: 0.4, verdict: "drop" });

  const result = attachIdeaLevelScores({
    store,
    judgeHash,
    pools: [{ poolKey: "p1", diversity: 0.7 }],
    ideaLevelScores: [{ idea: "y", originality: 8 }],
  });
  assert.equal(result.idea_level_metrics, "dropped");
  assert.deepEqual(result.pools, [{ poolKey: "p1", diversity: 0.7 }]);
  assert.ok(!("ideas" in result));
});

test("AC8 — a recorded PASSING validation attaches idea-level scores", () => {
  const store = makeTempStore("judge-gate-test-");
  const judgeHash = "judgehashpass";
  recordValidation(store, { judgeHash, sliceId: "sliceC", rho: 0.85, floor: 0.4, verdict: "pass" });

  const ideaLevelScores = [{ idea: "z", originality: 9, feasibility: 3 }];
  const result = attachIdeaLevelScores({ store, judgeHash, pools: [{ poolKey: "p1" }], ideaLevelScores });
  assert.deepEqual(result.pools, [{ poolKey: "p1" }]);
  assert.deepEqual(result.ideas, ideaLevelScores);
  assert.ok(!("idea_level_metrics" in result), "a passing judge must not carry a 'dropped' marker");
});

test("validationKey is reserved and cannot collide with a real cellKey shape", () => {
  const key = validationKey({ judgeHash: "abc123", sliceId: "sliceA" });
  assert.equal(key, "judge-validation|judge=abc123|slice=sliceA");
  assert.ok(!key.startsWith("arm="), "validation keys must never look like a real cell key");
});

test("recordValidation requires a store and a valid verdict", () => {
  const store = makeTempStore("judge-gate-test-");
  assert.throws(() => recordValidation(undefined, { judgeHash: "x", sliceId: "y", rho: 1, floor: 0.4, verdict: "pass" }), /store is required/);
  assert.throws(() => recordValidation(store, { judgeHash: "x", sliceId: "y", rho: 1, floor: 0.4, verdict: "maybe" }), /verdict must be/);
});

// ── AC10: judge calls are metered through lib/accounting.mjs and land in the store ──

test("AC10 — a judge call produces a costRow (tokens x model, no cost_usd) that lands in the store", () => {
  const store = makeTempStore("judge-gate-test-");
  const outcome = meterJudgeCall({
    store,
    cellKey: "arm=B|brief=b1|rep=0|cfg=deadbeef1234",
    judgeModel: "claude-sonnet-5",
    tokens: { input_tokens: 4000, output_tokens: 900 },
    timestamp: "2026-07-31T00:00:00Z",
  });
  assert.equal(outcome.written, true);

  const key = "judge-call|cell=arm=B|brief=b1|rep=0|cfg=deadbeef1234|judge=claude-sonnet-5";
  const stored = store.get(key);
  assert.equal(stored.costRows.length, 1);
  const row = stored.costRows[0];
  assert.equal(row.model, "claude-sonnet-5");
  assert.equal(row.input_tokens, 4000);
  assert.equal(row.output_tokens, 900);
  assert.equal(row.billing_mode, "api");
  assert.ok(!("cost_usd" in row));
  assert.ok(!("notional_usd" in row));
});

test("meterJudgeCall requires store, cellKey, and judgeModel", () => {
  assert.throws(() => meterJudgeCall({ cellKey: "x", judgeModel: "y", tokens: {}, timestamp: "t" }), /store is required/);
  const store = makeTempStore("judge-gate-test-");
  assert.throws(() => meterJudgeCall({ store, judgeModel: "y", tokens: {}, timestamp: "t" }), /cellKey is required/);
  assert.throws(() => meterJudgeCall({ store, cellKey: "x", tokens: {}, timestamp: "t" }), /judgeModel is required/);
});
