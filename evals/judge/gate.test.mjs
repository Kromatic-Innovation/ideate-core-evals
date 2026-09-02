// Tests for the judge validation gate (issue #4, AC7/AC8/AC10; re-scoped by
// #24): the gate now reads Si et al.'s split-half top/bottom-25% BALANCED
// ACCURACY floored at 56.1%, fails closed, lives as a store record, retains
// spearmanRho as a descriptive statistic, and refuses below a minimum n.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTempStore } from "../../lib/store.mjs";
import {
  spearmanRho,
  balancedAccuracyTopBottom,
  balancedAccuracySplitHalf,
  validateJudge,
  resolveAccuracyFloor,
  validationKey,
  recordValidation,
  attachIdeaLevelScores,
  meterJudgeCall,
  SI_ET_AL_BALANCED_ACCURACY_FLOOR,
  MIN_IDEAS_N,
  CONSTRUCTION_ID,
} from "./gate.mjs";

// ── spearmanRho (retained, descriptive) ──────────────────────────────────────

test("spearmanRho: perfect positive correlation is 1", () => {
  assert.equal(spearmanRho([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1);
});

test("spearmanRho: perfect anti-correlation is -1", () => {
  assert.equal(spearmanRho([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]), -1);
});

test("spearmanRho: handles tied ranks via average-rank convention", () => {
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

// ── #24 AC1: the balanced-accuracy construction, against a HAND-WORKED oracle ──

test("balancedAccuracyTopBottom — hand-worked example (expected value derived by hand)", () => {
  // n=8 ideas, quantile 0.25 -> k = floor(8*0.25) = 2 ideas per side.
  //
  // referenceScores (idea 0..7):  [1, 2, 3, 4, 5, 6, 7, 8]
  //   ascending order of indices: 0,1,2,3,4,5,6,7
  //   NEGATIVES (bottom 2) = ideas {0, 1};  POSITIVES (top 2) = ideas {6, 7}
  //   labelled set = {0, 1, 6, 7}; ideas 2..5 are discarded.
  //
  // evaluatorScores:              [9, 1, _, _, _, _, 2, 10]  (middle irrelevant)
  //   labelled evaluator scores:  idea0=9, idea1=1, idea6=2, idea7=10
  //   rank the 4 labelled by evaluator asc: idea1(1), idea6(2), idea0(9), idea7(10)
  //   predicted NEGATIVE = bottom 2 = {1, 6};  predicted POSITIVE = top 2 = {0, 7}
  //
  //   POSITIVES {6,7} vs predicted-positive {0,7}: TP = {7}             -> sensitivity 1/2
  //   NEGATIVES {0,1} vs predicted-negative {1,6}: TN = {1}             -> specificity 1/2
  //   balanced accuracy = (1/2 + 1/2) / 2 = 0.5
  const referenceScores = [1, 2, 3, 4, 5, 6, 7, 8];
  const evaluatorScores = [9, 1, 5, 5, 5, 5, 2, 10];
  const r = balancedAccuracyTopBottom({ referenceScores, evaluatorScores });
  assert.equal(r.k, 2);
  assert.equal(r.n, 8);
  assert.equal(r.sensitivity, 0.5);
  assert.equal(r.specificity, 0.5);
  assert.equal(r.accuracy, 0.5);
});

test("balancedAccuracyTopBottom — perfect agreement is 1.0, perfect disagreement is 0.0", () => {
  const reference = [1, 2, 3, 4, 5, 6, 7, 8];
  const agree = balancedAccuracyTopBottom({ referenceScores: reference, evaluatorScores: [1, 2, 3, 4, 5, 6, 7, 8] });
  assert.equal(agree.accuracy, 1);
  // reverse the evaluator: the reference top-2 become the evaluator's bottom-2
  const disagree = balancedAccuracyTopBottom({ referenceScores: reference, evaluatorScores: [8, 7, 6, 5, 4, 3, 2, 1] });
  assert.equal(disagree.accuracy, 0);
});

test("balancedAccuracyTopBottom — validates inputs and quantile", () => {
  assert.throws(() => balancedAccuracyTopBottom({ referenceScores: [1, 2], evaluatorScores: [1] }), /equal length/);
  assert.throws(() => balancedAccuracyTopBottom({ referenceScores: [1, 2, 3, 4], evaluatorScores: [1, 2, 3, 4], quantile: 0.9 }), /quantile must be in/);
  // n=2, quantile 0.25 -> k=0 -> cannot split
  assert.throws(() => balancedAccuracyTopBottom({ referenceScores: [1, 2], evaluatorScores: [1, 2] }), /cannot form a top\/bottom split/);
});

// ── #24: the gate reads accuracy, floored at 56.1%; rho is retained descriptive ──

// Build aligned expert/judge arrays whose balanced accuracy is exactly
// correctPos/k (see the derivation in the test below).
function makeAligned({ n, correctPos, quantile = 0.25 }) {
  const k = Math.floor(n * quantile);
  const expert = Array.from({ length: n }, (_, i) => i); // positives = top-k indices, negatives = bottom-k
  const judge = new Array(n).fill(500); // middle band; discarded middle ideas keep it
  const positives = [];
  const negatives = [];
  for (let i = 0; i < n; i++) {
    if (i >= n - k) positives.push(i);
    else if (i < k) negatives.push(i);
  }
  // correctPos true positives ranked highest; the rest ranked lowest.
  positives.forEach((idx, j) => { judge[idx] = j < correctPos ? 1000 + j : 0 + j; });
  // all negatives in the middle band so exactly (k-correctPos) of them fill the
  // remaining predicted-positive slots.
  negatives.forEach((idx, j) => { judge[idx] = 500 + j; });
  return { expert, judge, k };
}

test("#24 — validateJudge reads balanced accuracy (correctPos/k), not rho; verdict against the 56.1% floor", () => {
  // n=24, k=6. Balanced accuracy in this balanced 2k construction = correctPos/k.
  const passCase = makeAligned({ n: 24, correctPos: 4 }); // 4/6 = 0.6667 >= 0.561 -> pass
  const rPass = validateJudge({ judgeScores: passCase.judge, expertScores: passCase.expert });
  assert.equal(rPass.metric, "balanced-accuracy");
  assert.equal(rPass.construction, CONSTRUCTION_ID);
  assert.equal(rPass.n, 24);
  assert.ok(Math.abs(rPass.accuracy - 4 / 6) < 1e-9, `expected 4/6, got ${rPass.accuracy}`);
  assert.equal(rPass.floor, SI_ET_AL_BALANCED_ACCURACY_FLOOR);
  assert.equal(rPass.verdict, "pass");
  assert.equal(typeof rPass.rho, "number"); // rho retained as a descriptive statistic

  const dropCase = makeAligned({ n: 24, correctPos: 3 }); // 3/6 = 0.5 < 0.561 -> drop
  const rDrop = validateJudge({ judgeScores: dropCase.judge, expertScores: dropCase.expert });
  assert.ok(Math.abs(rDrop.accuracy - 0.5) < 1e-9, `expected 0.5, got ${rDrop.accuracy}`);
  assert.equal(rDrop.verdict, "drop");
});

test("#24 — perfect judge passes, anti-correlated judge drops; rho tracks alongside", () => {
  const expert = Array.from({ length: 24 }, (_, i) => i);
  const perfect = validateJudge({ judgeScores: expert.slice(), expertScores: expert });
  assert.equal(perfect.accuracy, 1);
  assert.equal(perfect.verdict, "pass");
  assert.equal(perfect.rho, 1);

  const anti = validateJudge({ judgeScores: expert.slice().reverse(), expertScores: expert });
  assert.equal(anti.accuracy, 0);
  assert.equal(anti.verdict, "drop");
  assert.equal(anti.rho, -1);
});

test("#24 — validateJudge REFUSES below the stated minimum n", () => {
  const n = MIN_IDEAS_N - 1;
  const expert = Array.from({ length: n }, (_, i) => i);
  assert.throws(
    () => validateJudge({ judgeScores: expert.slice(), expertScores: expert }),
    new RegExp(`below the minimum ${MIN_IDEAS_N}`),
  );
  // exactly at the minimum is allowed
  const atMin = Array.from({ length: MIN_IDEAS_N }, (_, i) => i);
  assert.doesNotThrow(() => validateJudge({ judgeScores: atMin.slice(), expertScores: atMin }));
});

test("#24 — the floor constant is 0.561 and is the default; config may override", () => {
  assert.equal(SI_ET_AL_BALANCED_ACCURACY_FLOOR, 0.561);
  assert.equal(resolveAccuracyFloor(undefined), 0.561);
  assert.equal(resolveAccuracyFloor({}), 0.561);
  assert.equal(resolveAccuracyFloor({ judge: { accuracyFloor: 0.66 } }), 0.66);
  assert.throws(() => resolveAccuracyFloor({ judge: { accuracyFloor: "0.66" } }), /must be a finite number/);
});

// ── #24: the human-human split-half construction that produces the floor ──────

test("balancedAccuracySplitHalf — reproducible from a seed, reports a distribution", () => {
  // Synthetic reviews with a clean signal: idea i's reviews all cluster near i,
  // so a within-idea split should agree strongly and balanced accuracy is high.
  // This is a HERMETIC exercise of the construction (no real payload); the real
  // 56.1% reproduction against Si et al.'s reviews is the #16 real-data run.
  const ideaReviews = Array.from({ length: 40 }, (_, i) => [i, i + 0.1, i - 0.1, i + 0.2]);
  const a = balancedAccuracySplitHalf({ ideaReviews, splits: 25, seed: 7 });
  const b = balancedAccuracySplitHalf({ ideaReviews, splits: 25, seed: 7 });
  assert.deepEqual(a.values, b.values, "same seed must reproduce the same draws (state the seed, do not tune)");
  assert.equal(a.values.length, 25);
  assert.equal(a.n, 40);
  assert.ok(a.mean > 0.9, `a clean within-idea signal should agree strongly, got mean ${a.mean}`);
});

test("balancedAccuracySplitHalf — refuses below MIN_IDEAS_N and on ideas with <2 reviews", () => {
  const tooFew = Array.from({ length: MIN_IDEAS_N - 1 }, () => [1, 2]);
  assert.throws(() => balancedAccuracySplitHalf({ ideaReviews: tooFew }), new RegExp(`below the minimum ${MIN_IDEAS_N}`));
  const singleReview = Array.from({ length: MIN_IDEAS_N }, (_, i) => (i === 0 ? [1] : [1, 2]));
  assert.throws(() => balancedAccuracySplitHalf({ ideaReviews: singleReview }), /fewer than 2 reviews/);
});

// ── #24: the widened validation record ────────────────────────────────────────

test("#24 — recordValidation stores the widened { metric, construction, n, accuracy, floor, verdict, rho }", () => {
  const store = makeTempStore("judge-gate-test-");
  const judgeHash = "judgehashwide";
  recordValidation(store, {
    judgeHash, sliceId: "sliceW",
    metric: "balanced-accuracy", construction: CONSTRUCTION_ID,
    n: 147, accuracy: 0.62, floor: SI_ET_AL_BALANCED_ACCURACY_FLOOR, verdict: "pass", rho: 0.41,
  });
  const stored = store.get(validationKey({ judgeHash, sliceId: "sliceW" }));
  assert.deepEqual(stored.result, {
    kind: "judge-validation",
    metric: "balanced-accuracy",
    construction: CONSTRUCTION_ID,
    n: 147,
    accuracy: 0.62,
    floor: 0.561,
    verdict: "pass",
    rho: 0.41,
  });
});

test("recordValidation requires a store, a valid verdict, a finite accuracy, and a positive-integer n", () => {
  const store = makeTempStore("judge-gate-test-");
  const base = { judgeHash: "x", sliceId: "y", accuracy: 0.6, floor: 0.561, verdict: "pass", n: 30, rho: 0.3 };
  assert.throws(() => recordValidation(undefined, base), /store is required/);
  assert.throws(() => recordValidation(store, { ...base, verdict: "maybe" }), /verdict must be/);
  assert.throws(() => recordValidation(store, { ...base, accuracy: "high" }), /accuracy must be a finite number/);
  assert.throws(() => recordValidation(store, { ...base, n: 0 }), /n must be a positive integer/);
});

// ── AC8: fails closed (unchanged behavior, new record shape) ──────────────────

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
  recordValidation(store, { judgeHash, sliceId: "sliceB", accuracy: 0.5, floor: 0.561, verdict: "drop", n: 147, rho: -0.2 });

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
  recordValidation(store, { judgeHash, sliceId: "sliceC", accuracy: 0.7, floor: 0.561, verdict: "pass", n: 147, rho: 0.5 });

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

  // Attempt-scoped (PR #76 fix round): the FIRST call for this (cellKey,
  // judgeModel) pair is always attempt 0 -- see meterJudgeCall's own header.
  const key = "judge-call|cell=arm=B|brief=b1|rep=0|cfg=deadbeef1234|judge=claude-sonnet-5|attempt=0";
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
