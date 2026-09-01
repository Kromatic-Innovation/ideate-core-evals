// threshold-selection.test.mjs — hermetic tests for the balanced-accuracy
// threshold-selection rule. Pure synthetic data only; never imports an
// embedder or touches the network (see threshold-selection.mjs header).
import { test } from "node:test";
import assert from "node:assert/strict";

import { balancedAccuracyAt, selectThreshold, pairSetHash } from "./threshold-selection.mjs";

// ── balancedAccuracyAt ───────────────────────────────────────────────────

test("balancedAccuracyAt is 1.0 for a perfectly separated population", () => {
  const distances = [0.1, 0.2, 0.8, 0.9];
  const labels = ["same", "same", "different", "different"];
  const { balancedAccuracy, sensitivity, specificity } = balancedAccuracyAt(distances, labels, 0.5);
  assert.equal(balancedAccuracy, 1);
  assert.equal(sensitivity, 1);
  assert.equal(specificity, 1);
});

test("balancedAccuracyAt is 0.5 for a threshold that classifies everything as one class", () => {
  const distances = [0.1, 0.2, 0.8, 0.9];
  const labels = ["same", "same", "different", "different"];
  // threshold above every distance -> everything predicted "same"
  const { balancedAccuracy } = balancedAccuracyAt(distances, labels, 10);
  assert.equal(balancedAccuracy, 0.5);
});

test("balancedAccuracyAt rejects mismatched-length inputs", () => {
  assert.throws(() => balancedAccuracyAt([0.1], ["same", "different"], 0.5), /same length/);
});

// ── selectThreshold ───────────────────────────────────────────────────────

test("selectThreshold finds the clean midpoint when populations are perfectly separated", () => {
  const distances = [0.1, 0.2, 0.8, 0.9];
  const labels = ["same", "same", "different", "different"];
  const { threshold, achievedBalancedAccuracy } = selectThreshold(distances, labels);
  assert.equal(achievedBalancedAccuracy, 1);
  // Widest optimal plateau is the single gap between 0.2 and 0.8 -> midpoint 0.5.
  assert.equal(threshold, 0.5);
});

test("selectThreshold picks the widest plateau, not the first candidate, when several tie", () => {
  // "same" at 0.1; "different" at 0.4, 0.6, 0.9 -> the only candidate
  // achieving balanced accuracy 1.0 is anything strictly between 0.1 and 0.4
  // (a narrow plateau) since every other candidate misclassifies something.
  // Construct a case with two disjoint clean gaps of different widths to
  // confirm the wider one wins.
  const distances = [0.1, 0.15, 0.5, 0.9, 0.95];
  const labels = ["same", "same", "different", "different", "different"];
  // Candidates: mid(0.1,0.15)=0.125 [BA<1], mid(0.15,0.5)=0.325 [BA=1, gap width 0.35],
  // mid(0.5,0.9)=0.7 [BA<1 if 0.5 misclassified as same already handled], mid(0.9,0.95)=0.925 [BA<1]
  const { threshold, achievedBalancedAccuracy } = selectThreshold(distances, labels);
  assert.equal(achievedBalancedAccuracy, 1);
  assert.equal(threshold, 0.325);
});

test("selectThreshold on overlapping populations achieves balanced accuracy below 1", () => {
  // "same" and "different" overlap in [0.4, 0.6] -- no clean separator exists.
  const distances = [0.1, 0.3, 0.5, 0.5, 0.7, 0.9];
  const labels = ["same", "same", "same", "different", "different", "different"];
  const { achievedBalancedAccuracy, threshold } = selectThreshold(distances, labels);
  assert.ok(achievedBalancedAccuracy < 1, `expected imperfect separation, got BA=${achievedBalancedAccuracy}`);
  assert.ok(achievedBalancedAccuracy > 0.5, `expected better than chance, got BA=${achievedBalancedAccuracy}`);
  assert.ok(Number.isFinite(threshold));
});

test("selectThreshold rejects empty input and mismatched lengths", () => {
  assert.throws(() => selectThreshold([], []), /non-empty/);
  assert.throws(() => selectThreshold([0.1, 0.2], ["same"]), /same length/);
});

test("selectThreshold rejects a single distinct observed distance (no candidate exists)", () => {
  assert.throws(() => selectThreshold([0.5, 0.5, 0.5], ["same", "different", "same"]), /at least 2 distinct/);
});

test("selectThreshold returns candidates as midpoints of consecutive sorted distances, not an arbitrary grid", () => {
  const distances = [0.9, 0.1, 0.5, 0.3];
  const labels = ["different", "same", "different", "same"];
  const { candidates } = selectThreshold(distances, labels);
  // sorted unique distances: 0.1, 0.3, 0.5, 0.9 -> 3 midpoint candidates
  assert.equal(candidates.length, 3);
  assert.deepEqual(
    candidates.map((c) => Number(c.threshold.toFixed(2))),
    [0.2, 0.4, 0.7],
  );
});

// ── pairSetHash ───────────────────────────────────────────────────────────

test("pairSetHash is deterministic and order/field-shape independent within {a,b,label}", () => {
  const pairs = [
    { a: "x", b: "y", label: "same", stratum: "business", briefId: "biz-01" },
    { a: "p", b: "q", label: "different", stratum: "product", briefId: "prod-01" },
  ];
  const h1 = pairSetHash(pairs);
  const h2 = pairSetHash(pairs.map(({ a, b, label }) => ({ a, b, label }))); // strip metadata
  assert.equal(h1, h2);
  assert.equal(h1.length, 12);
});

test("pairSetHash changes when a label changes", () => {
  const pairs = [{ a: "x", b: "y", label: "same" }];
  const flipped = [{ a: "x", b: "y", label: "different" }];
  assert.notEqual(pairSetHash(pairs), pairSetHash(flipped));
});
