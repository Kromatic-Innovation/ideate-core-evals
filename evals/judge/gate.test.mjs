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
import { computeJudgeHash, computeJudgeRequestHash, MAX_JUDGE_TOKENS, JUDGE_REQUEST_SHAPE } from "./score.mjs";

// #170: the CURRENT instrument — the shape a run happening now writes, and the
// hash of it. Derived from the constants rather than restated as literals, so
// this file cannot drift from what score.mjs actually sends.
const CURRENT_SHAPE = { maxTokens: MAX_JUDGE_TOKENS, ...JUDGE_REQUEST_SHAPE };
const CURRENT_REQ_HASH = computeJudgeRequestHash({ requestShape: CURRENT_SHAPE });

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
    judgeHash, judgeRequestHash: CURRENT_REQ_HASH, sliceId: "sliceW",
    metric: "balanced-accuracy", construction: CONSTRUCTION_ID,
    n: 147, accuracy: 0.62, floor: SI_ET_AL_BALANCED_ACCURACY_FLOOR, verdict: "pass", rho: 0.41,
  });
  const stored = store.get(validationKey({ judgeHash, judgeRequestHash: CURRENT_REQ_HASH, sliceId: "sliceW" }));
  assert.deepEqual(stored.result, {
    kind: "judge-validation",
    metric: "balanced-accuracy",
    construction: CONSTRUCTION_ID,
    n: 147,
    accuracy: 0.62,
    floor: 0.561,
    verdict: "pass",
    rho: 0.41,
    judgeRequestHash: CURRENT_REQ_HASH,
  });
});

test("recordValidation requires a store, a valid verdict, a finite accuracy, and a positive-integer n", () => {
  const store = makeTempStore("judge-gate-test-");
  const base = { judgeHash: "x", judgeRequestHash: CURRENT_REQ_HASH, sliceId: "y", accuracy: 0.6, floor: 0.561, verdict: "pass", n: 30, rho: 0.3 };
  assert.throws(() => recordValidation(undefined, base), /store is required/);
  assert.throws(() => recordValidation(store, { ...base, judgeRequestHash: undefined }), /judgeRequestHash is required/);
  assert.throws(() => recordValidation(store, { ...base, verdict: "maybe" }), /verdict must be/);
  assert.throws(() => recordValidation(store, { ...base, accuracy: "high" }), /accuracy must be a finite number/);
  assert.throws(() => recordValidation(store, { ...base, n: 0 }), /n must be a positive integer/);
});

// ── AC8: fails closed (unchanged behavior, new record shape) ──────────────────

test("AC8 — attachIdeaLevelScores THROWS with no validation record at all", () => {
  const store = makeTempStore("judge-gate-test-");
  assert.throws(
    () => attachIdeaLevelScores({ store, judgeHash: "nonexistent-hash", judgeRequestHash: CURRENT_REQ_HASH, pools: [{ poolKey: "p1" }], ideaLevelScores: [{ idea: "x" }] }),
    /no validation record found/,
  );
});

test("#170 — attachIdeaLevelScores REFUSES without a current judgeRequestHash", () => {
  // The instrument's identity is required on the licensing path for the same
  // reason judgeHash is: an optional gate on a function with no production
  // caller is a gate nobody turns on. This repo already shipped `requestShape:
  // null` under a green suite once.
  const store = makeTempStore("judge-gate-test-");
  recordValidation(store, { judgeHash: "jh-req", judgeRequestHash: CURRENT_REQ_HASH, sliceId: "s1", accuracy: 0.7, floor: 0.561, verdict: "pass", n: 98, rho: 0.4 });
  assert.throws(
    () => attachIdeaLevelScores({ store, judgeHash: "jh-req", pools: [], ideaLevelScores: [] }),
    /judgeRequestHash is required/,
  );
});

test("AC8 — a recorded FAILING validation forces pool-level-only output", () => {
  const store = makeTempStore("judge-gate-test-");
  const judgeHash = "judgehashdrop";
  recordValidation(store, { judgeHash, judgeRequestHash: CURRENT_REQ_HASH, sliceId: "sliceB", accuracy: 0.5, floor: 0.561, verdict: "drop", n: 147, rho: -0.2 });

  const result = attachIdeaLevelScores({
    store,
    judgeHash,
    judgeRequestHash: CURRENT_REQ_HASH,
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
  recordValidation(store, { judgeHash, judgeRequestHash: CURRENT_REQ_HASH, sliceId: "sliceC", accuracy: 0.7, floor: 0.561, verdict: "pass", n: 147, rho: 0.5 });

  const ideaLevelScores = [{ idea: "z", originality: 9, feasibility: 3 }];
  const result = attachIdeaLevelScores({ store, judgeHash, judgeRequestHash: CURRENT_REQ_HASH, pools: [{ poolKey: "p1" }], ideaLevelScores });
  assert.deepEqual(result.pools, [{ poolKey: "p1" }]);
  assert.deepEqual(result.ideas, ideaLevelScores);
  assert.ok(!("idea_level_metrics" in result), "a passing judge must not carry a 'dropped' marker");
});

test("validationKey is reserved and cannot collide with a real cellKey shape", () => {
  const key = validationKey({ judgeHash: "abc123", judgeRequestHash: "req456", sliceId: "sliceA" });
  assert.equal(key, "judge-validation|judge=abc123|req=req456|slice=sliceA");
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

// ── issue #119: judge-call rows are the OTHER cost-row shape -- flat, no
// tokens_by_model -- and must carry pricing_regime exactly like a
// generation row does, or every judge leg (the dominant cost driver) stays
// on the store-wide default while looking like the issue is closed. ───────
test("issue #119 — meterJudgeCall stamps pricing_regime from `mode`, defaulting to batch", () => {
  const store = makeTempStore("judge-gate-test-");
  const defaulted = meterJudgeCall({
    store,
    cellKey: "arm=B|brief=b1|rep=0|cfg=deadbeef1234",
    judgeModel: "claude-sonnet-5",
    tokens: { input_tokens: 100, output_tokens: 50 },
    timestamp: "2026-07-31T00:00:00Z",
  });
  assert.equal(store.get(defaulted.key).costRows[0].pricing_regime, "batch", "no mode passed -- defaults to batch, the pre-#119 effective behaviour");

  const single = meterJudgeCall({
    store,
    cellKey: "arm=B|brief=b1|rep=0|cfg=deadbeef1234",
    judgeModel: "claude-sonnet-5",
    tokens: { input_tokens: 100, output_tokens: 50 },
    timestamp: "2026-07-31T00:00:01Z",
    mode: "single",
  });
  assert.equal(store.get(single.key).costRows[0].pricing_regime, "single");

  assert.throws(
    () =>
      meterJudgeCall({
        store,
        cellKey: "arm=B|brief=b1|rep=0|cfg=deadbeef1234",
        judgeModel: "claude-sonnet-5",
        tokens: { input_tokens: 1, output_tokens: 1 },
        timestamp: "2026-07-31T00:00:02Z",
        mode: "bogus",
      }),
    /mode must be "batch" or "single"/,
  );
});

// ── #108: max+1, not a count ────────────────────────────────────────
// These assert the numbering directly against a store the prune has already
// folded, WITHOUT running the prune -- the record shapes are the contract
// between the two modules, and a test that goes through pruneStore() would
// pass even if meterJudgeCall only agreed with today's pruner by accident.
// (The end-to-end pairing lives in evals/harness/prune.test.mjs.)

const NUMBERING_CELL = "arm=B|brief=b1|rep=0|cfg=deadbeef1234";
const NUMBERING_JUDGE = "claude-sonnet-5";

/** A compacted judge-call record in the exact shape planPrune writes. */
function putCompactedJudgeCall(store, through) {
  const scope = `${NUMBERING_CELL}|judge=${NUMBERING_JUDGE}`;
  store.put({
    key: `judge-call-compacted|cell=${scope}|through=${through}`,
    armId: "__judge-call-compacted__",
    briefId: scope,
    replicate: 0,
    cfg: NUMBERING_JUDGE,
    result: { kind: "judge-call-compacted", cellKey: scope, through },
    resolvedModels: { models: [NUMBERING_JUDGE] },
    accounting: { state: "completed" },
    costRows: [{ cellKey: scope, timestamp: "2026-09-01T00:00:00Z", billing_mode: "api", model: NUMBERING_JUDGE, input_tokens: 10, output_tokens: 5 }],
  });
}

const meterNext = (store) =>
  meterJudgeCall({
    store,
    cellKey: NUMBERING_CELL,
    judgeModel: NUMBERING_JUDGE,
    tokens: { input_tokens: 100, output_tokens: 20 },
    timestamp: "2026-09-02T00:00:00Z",
  });

test("#108 — meterJudgeCall numbers the next attempt max+1 across a COMPACTED record, not by counting keys", () => {
  const store = makeTempStore("judge-gate-test-");
  // The exact post-fold shape: attempts 0..4 folded into one, 5 retained.
  putCompactedJudgeCall(store, 4);
  meterJudgeCall({
    store,
    cellKey: NUMBERING_CELL,
    judgeModel: NUMBERING_JUDGE,
    tokens: { input_tokens: 1, output_tokens: 1 },
    timestamp: "2026-09-01T00:00:01Z",
  });
  // ^ that call is itself the first assertion: under the old count it would
  // have been numbered 1 (one key present), and here it must be 5.
  assert.ok(store.has(`judge-call|cell=${NUMBERING_CELL}|judge=${NUMBERING_JUDGE}|attempt=5`));

  // Two records in the store, next attempt is 6 -- a count would say 2.
  const outcome = meterNext(store);
  assert.equal(outcome.key, `judge-call|cell=${NUMBERING_CELL}|judge=${NUMBERING_JUDGE}|attempt=6`);
  assert.equal(outcome.written, true);
  assert.equal(store.get(outcome.key).result.attempt, 6, "and the body agrees with the key");
});

test("#108 — the numbering is unchanged from the old count when nothing has been folded", () => {
  const store = makeTempStore("judge-gate-test-");
  for (let n = 0; n < 4; n++) {
    assert.equal(meterNext(store).key, `judge-call|cell=${NUMBERING_CELL}|judge=${NUMBERING_JUDGE}|attempt=${n}`);
  }
});

test("#108 — a second judge model on the same cell gets its own attempt sequence", () => {
  const store = makeTempStore("judge-gate-test-");
  putCompactedJudgeCall(store, 9);
  const other = meterJudgeCall({
    store,
    cellKey: NUMBERING_CELL,
    judgeModel: "gpt-5.6-terra",
    tokens: { input_tokens: 1, output_tokens: 1 },
    timestamp: "2026-09-02T00:00:00Z",
  });
  assert.equal(other.key, `judge-call|cell=${NUMBERING_CELL}|judge=gpt-5.6-terra|attempt=0`, "a fold under one judge must not push another judge's numbering");
  assert.equal(meterNext(store).key, `judge-call|cell=${NUMBERING_CELL}|judge=${NUMBERING_JUDGE}|attempt=10`);
});

test("meterJudgeCall requires store, cellKey, and judgeModel", () => {
  assert.throws(() => meterJudgeCall({ cellKey: "x", judgeModel: "y", tokens: {}, timestamp: "t" }), /store is required/);
  const store = makeTempStore("judge-gate-test-");
  assert.throws(() => meterJudgeCall({ store, judgeModel: "y", tokens: {}, timestamp: "t" }), /cellKey is required/);
  assert.throws(() => meterJudgeCall({ store, cellKey: "x", tokens: {}, timestamp: "t" }), /judgeModel is required/);
});

// ── #16/#170: the record must say WHICH instrument produced the verdict ──────
// judgeHash covers the judge prompt and the model roster, and nothing else —
// not max_tokens, not the thinking mode. #170 closes that with a SECOND hash,
// computeJudgeRequestHash, carried in the record and in validationKey. The
// tests below pin the three properties the fix rests on: two shapes give two
// hashes and therefore two keys; a mismatched instrument is a NAMED diagnosis
// rather than a collision; and the one pre-#170 record is still reachable and
// still licenses idea-level metrics.

test("#170: recordValidation stamps BOTH judgeRequestHash and requestShape onto the record", () => {
  const store = makeTempStore("judge-gate-test-");
  const shape = { maxTokens: 256, thinking: { type: "disabled" } };
  const reqHash = computeJudgeRequestHash({ requestShape: shape });
  recordValidation(store, {
    judgeHash: "jh1", judgeRequestHash: reqHash, sliceId: "s1", accuracy: 0.6, floor: 0.561, verdict: "pass", n: 98, rho: 0.3,
    axis: "originality", expertColumn: "overall_score", requestShape: shape,
  });
  const entry = store.list().find((r) => r.armId === "__judge-validation__");
  assert.ok(entry, "a validation record was written");
  assert.equal(entry.key, `judge-validation|judge=jh1|req=${reqHash}|slice=s1`);
  assert.deepEqual(store.get(entry.key).result.requestShape, shape);
  assert.equal(store.get(entry.key).result.judgeRequestHash, reqHash);
  // `cfg` stays judgeHash ALONE — it is read by the configHash tally paths, and
  // widening it is exactly the re-key #170 chose not to do.
  assert.equal(entry.cfg, "jh1");
});

test("#170: two request shapes give two judgeRequestHashes and therefore two validation keys", () => {
  const thinking = { maxTokens: 256, thinking: { type: "adaptive" } };
  const direct = { maxTokens: 256, thinking: { type: "disabled" } };
  const ceiling = { maxTokens: 2048, thinking: { type: "disabled" } };
  const hThinking = computeJudgeRequestHash({ requestShape: thinking });
  const hDirect = computeJudgeRequestHash({ requestShape: direct });
  const hCeiling = computeJudgeRequestHash({ requestShape: ceiling });
  assert.notEqual(hThinking, hDirect, "the thinking mode must move the hash");
  assert.notEqual(hDirect, hCeiling, "max_tokens must move the hash");
  assert.notEqual(
    validationKey({ judgeHash: "jh", judgeRequestHash: hThinking, sliceId: "s" }),
    validationKey({ judgeHash: "jh", judgeRequestHash: hDirect, sliceId: "s" }),
    "two instruments must occupy two keys — that IS the fix",
  );
});

test("#170: the hash does not depend on key insertion order", () => {
  const a = computeJudgeRequestHash({ requestShape: { maxTokens: 256, thinking: { type: "disabled" } } });
  const b = computeJudgeRequestHash({ requestShape: { thinking: { type: "disabled" }, maxTokens: 256 } });
  assert.equal(a, b);
  // ...and maxTokens may arrive either as its own argument or inside the shape.
  assert.equal(a, computeJudgeRequestHash({ maxTokens: 256, requestShape: { thinking: { type: "disabled" } } }));
  // The pair above alone does NOT exercise the canonicalizer: rebuilding the
  // payload as `{maxTokens, ...rest}` already normalizes maxTokens' position,
  // and `rest` held one key. NESTED keys and top-level SIBLINGS are what the
  // recursive key sort is actually for — a plain JSON.stringify survives the
  // pair above and dies here. (Caught by mutation M5.)
  assert.equal(
    computeJudgeRequestHash({ requestShape: { maxTokens: 256, thinking: { type: "enabled", budget_tokens: 1024 }, temperature: 0 } }),
    computeJudgeRequestHash({ requestShape: { temperature: 0, thinking: { budget_tokens: 1024, type: "enabled" }, maxTokens: 256 } }),
  );
  assert.throws(
    () => computeJudgeRequestHash({ maxTokens: 512, requestShape: { maxTokens: 256, thinking: { type: "disabled" } } }),
    /contradicts requestShape.maxTokens/,
  );
});

test("#170: a passing verdict under a DIFFERENT request shape does not license idea-level metrics — and says so by name", () => {
  const store = makeTempStore("judge-gate-test-");
  const thinking = { maxTokens: 256, thinking: { type: "adaptive" } };
  const hThinking = computeJudgeRequestHash({ requestShape: thinking });
  recordValidation(store, {
    judgeHash: "jh1", judgeRequestHash: hThinking, sliceId: "s1", accuracy: 0.62, floor: 0.561, verdict: "pass",
    n: 98, rho: 0.3, requestShape: thinking,
  });

  assert.throws(
    () => attachIdeaLevelScores({
      store, judgeHash: "jh1", judgeRequestHash: CURRENT_REQ_HASH, requestShape: CURRENT_SHAPE,
      pools: [{ poolKey: "p1" }], ideaLevelScores: [{ idea: "z" }],
    }),
    (err) => {
      assert.match(err.message, /the judge's request shape changed/);
      assert.match(err.message, new RegExp(hThinking), "names the STORED instrument");
      assert.match(err.message, new RegExp(CURRENT_REQ_HASH), "names the CURRENT instrument");
      assert.doesNotMatch(err.message, /already exists under this exact key/, "a named diagnosis, never a key collision");
      return true;
    },
  );
});

test("#170: a record naming NO instrument at all is non-licensing (fails closed)", () => {
  // Pre-#16 records carry neither hash nor shape. An unidentified instrument is
  // not an implicit match, for the same reason an absent record is not an
  // implicit pass — the header block's own doctrine.
  const store = makeTempStore("judge-gate-test-");
  store.put({
    key: validationKey({ judgeHash: "jhOld", sliceId: "sOld" }),
    armId: "__judge-validation__", briefId: "sOld", replicate: 0, cfg: "jhOld",
    result: { kind: "judge-validation", metric: "balanced-accuracy", n: 98, accuracy: 0.62, floor: 0.561, verdict: "pass", rho: 0.2 },
    resolvedModels: { judge: "mixed" }, accounting: { state: "completed" }, costRows: [],
  });
  assert.throws(
    () => attachIdeaLevelScores({
      store, judgeHash: "jhOld", judgeRequestHash: CURRENT_REQ_HASH, requestShape: CURRENT_SHAPE,
      pools: [], ideaLevelScores: [],
    }),
    /UNRECORDED \(the record names no request shape at all\)/,
  );
});

test("#170: the ONE pre-#170 record is still reachable and still licenses idea-level metrics", () => {
  // The real §5.1 gate result: judgeHash 16812833fcd2, accuracy 0.5833, keyed
  // WITHOUT a `req=` segment because it predates this change, carrying only the
  // `requestShape` #16 stamped on it. It must still be found by the prefix scan
  // AND still reconcile against the current instrument — that verdict is what
  // licenses the study's confirmatory idea-level metrics, and the append-only
  // store makes migrating it impossible without breaking its own invariant.
  const store = makeTempStore("judge-gate-test-");
  const judgeHash = "16812833fcd2";
  const sliceId = "si-et-al|axis=originality|expert=overall_score";
  const legacyKey = validationKey({ judgeHash, sliceId });
  assert.equal(legacyKey, `judge-validation|judge=${judgeHash}|slice=${sliceId}`, "omitting judgeRequestHash reproduces the OLD key exactly");
  store.put({
    key: legacyKey, armId: "__judge-validation__", briefId: sliceId, replicate: 0, cfg: judgeHash,
    result: {
      kind: "judge-validation", metric: "balanced-accuracy",
      construction: CONSTRUCTION_ID, n: 98, accuracy: 0.5833333333333334, floor: 0.561,
      verdict: "pass", rho: 0.2141178012495899, axis: "originality", expertColumn: "overall_score",
      requestShape: { maxTokens: 256, thinking: { type: "disabled" } },
    },
    resolvedModels: { judge: "claude-sonnet-5" }, accounting: { state: "completed" }, costRows: [],
  });

  const ideaLevelScores = [{ idea: "z", originality: 9 }];
  const out = attachIdeaLevelScores({
    store, judgeHash, judgeRequestHash: CURRENT_REQ_HASH, requestShape: CURRENT_SHAPE,
    pools: [{ poolKey: "p1" }], ideaLevelScores,
  });
  assert.deepEqual(out.ideas, ideaLevelScores, "the passing 0.5833 verdict still licenses idea-level metrics");
  assert.ok(!("idea_level_metrics" in out));

  // ...and it is reconciled by its stored shape, so a caller that supplies no
  // current shape cannot accidentally launder it through. That refusal names
  // the MISSING ARGUMENT, not a changed instrument — nothing changed, and
  // saying it did would send a reader to re-run the §5.1 gate for $0.58.
  assert.throws(
    () => attachIdeaLevelScores({ store, judgeHash, judgeRequestHash: CURRENT_REQ_HASH, pools: [], ideaLevelScores }),
    (err) => {
      assert.match(err.message, /no current requestShape was supplied/);
      assert.doesNotMatch(err.message, /the judge's request shape changed/);
      return true;
    },
  );
});

test("#170: the legacy requestShape bridge compares shapes STRUCTURALLY, not by key order", () => {
  // gate.mjs cannot import score.mjs (score.mjs -> gate.mjs already), so it
  // reconciles a pre-#170 record by comparing shapes rather than hashing one.
  // That comparison must be order-insensitive for the same reason the hash is.
  //
  // The asymmetry to test is the CALLER's side, not the store's: ResultsStore
  // serializes bodies with sorted keys, so a stored shape always reads back
  // canonical no matter how it was written. The in-memory shape a caller hands
  // in is not canonicalized by anything, so that is where key order can differ.
  const store = makeTempStore("judge-gate-test-");
  store.put({
    key: validationKey({ judgeHash: "jhReorder", sliceId: "s" }),
    armId: "__judge-validation__", briefId: "s", replicate: 0, cfg: "jhReorder",
    result: {
      kind: "judge-validation", n: 98, accuracy: 0.62, floor: 0.561, verdict: "pass", rho: 0.2,
      requestShape: { maxTokens: 256, thinking: { type: "enabled", budget_tokens: 1024 } },
    },
    resolvedModels: { judge: "mixed" }, accounting: { state: "completed" }, costRows: [],
  });
  const callerShape = { thinking: { budget_tokens: 1024, type: "enabled" }, maxTokens: 256 };
  const out = attachIdeaLevelScores({
    store, judgeHash: "jhReorder",
    judgeRequestHash: computeJudgeRequestHash({ requestShape: callerShape }),
    requestShape: callerShape,
    pools: [], ideaLevelScores: [{ idea: "z" }],
  });
  assert.deepEqual(out.ideas, [{ idea: "z" }], "the same instrument written in a different key order is the SAME instrument");
});

test("#170: a same-key re-run still cannot overwrite a verdict — the store's append-only guard is the second backstop", () => {
  // #170 gives two INSTRUMENTS two keys. Within one instrument the store's
  // append-only invariant remains what stops a second run replacing a stored
  // verdict, and that is worth pinning precisely because the protection lives
  // somewhere other than where a reader would look for it.
  const store = makeTempStore("judge-gate-test-");
  const common = { judgeHash: "jh1", judgeRequestHash: CURRENT_REQ_HASH, sliceId: "s1", floor: 0.561, n: 98, rho: 0.1, axis: "originality", expertColumn: "overall_score", requestShape: CURRENT_SHAPE };
  recordValidation(store, { ...common, accuracy: 0.5, verdict: "drop" });

  assert.throws(
    () => recordValidation(store, { ...common, accuracy: 0.62, verdict: "pass" }),
    /already exists under this exact key with DIFFERENT content/,
    "a re-run under the SAME instrument must not be able to replace a stored verdict",
  );

  const rec = store.get(validationKey(common));
  assert.equal(rec.result.verdict, "drop", "the ORIGINAL verdict survives");
});

test("#170: computeJudgeHash is UNMOVED — configHash does not shift", () => {
  // The entire point of a separate request hash: judgeHash is a CONFIG_FIELDS
  // entry, so any change to its payload re-keys the cellKey of all 431
  // collected Stage 1c cells. 16812833fcd2 is the value the real §5.1 record in
  // results-judge-validation is stored under; a golden, not a re-derivation.
  assert.equal(computeJudgeHash({ judgeModels: { anthropic: ["claude-sonnet-5"] } }), "16812833fcd2");
  assert.notEqual(
    computeJudgeHash({ judgeModels: { anthropic: ["claude-sonnet-5"] } }),
    computeJudgeRequestHash(),
    "the two hashes must be independent instruments, not one value under two names",
  );
});
