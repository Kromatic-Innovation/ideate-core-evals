// threshold-selection.mjs — the REGISTERED rule for picking
// CLUSTER_DISTANCE_THRESHOLD from a labelled same/different pair set, plus
// the pair-set content hash. Pure math: no embedder, no network, no
// filesystem — every function here takes plain distances/labels in and
// numbers out, so it is hermetically testable with synthetic data and never
// needs the fixtures/embeddings it will eventually be run against (issue
// #42).
//
// ── Why this replaces deriveClusterThreshold's midpoint-of-gap rule ────────
// calibration.mjs's deriveClusterThreshold (the existing MiniLM-space
// derivation) THROWS if the paraphrase/distinct-idea populations overlap —
// correct for 4+4 short authored pairs with a clean gap, but wrong here: a
// 100+ pair set of HARD NEGATIVES (same-brief distinct ideas, not
// cross-topic freebies — see fixtures/calibration-pairs.mjs) is expected to
// have some overlap between the "same" and "different" distance
// populations. A midpoint-of-gap rule has nothing to compute when there is
// no gap. Balanced accuracy is well-defined with overlap: it just won't
// reach 1.0, and the ACHIEVED balanced accuracy is itself a finding worth
// reporting (a low ceiling means the threshold, however chosen, is a
// blunter instrument than the clean 8-pair fixture suggested).
//
// ── The registered rule ─────────────────────────────────────────────────────
// 1. Candidate thresholds are the MIDPOINTS BETWEEN CONSECUTIVE SORTED
//    OBSERVED DISTANCES — not an arbitrary linspace. Balanced accuracy only
//    changes value at points where the threshold crosses an observed
//    distance, so this is the exact, minimal candidate set: every distinct
//    achievable balanced-accuracy value is reachable by some point in it,
//    and no unregistered grid-resolution knob is introduced.
// 2. For each candidate, balanced accuracy = mean(sensitivity, specificity)
//    where "same" is treated as the positive class predicted by
//    distance < threshold, and "different" by distance >= threshold.
// 3. Select the threshold(s) achieving the MAXIMUM balanced accuracy. When
//    several candidates tie (a plateau — the common case, since balanced
//    accuracy is a step function), the tie-break is the MIDPOINT OF THE
//    WIDEST OPTIMAL PLATEAU: the run of consecutive tied-optimal candidates
//    that spans the largest distance range. This maximises margin against
//    resampling noise in the calibration set, the same rationale
//    deriveClusterThreshold already uses for its own midpoint choice.
//
// ── Deviation from real pool structure — stated, not hidden ────────────────
// The selected threshold is optimal for PAIRWISE same/different
// classification. clusterByThreshold (./clustering.mjs) consumes it under
// AVERAGE-LINKAGE agglomeration over ~30-item pools, where a merge decision
// compares a MEAN distance across cross-cluster pairs, not one pairwise
// distance. Pairwise-optimal is a defensible proxy for average-linkage
// merge behavior, not a proof of it — no labelled 30-item pool exists to
// derive an average-linkage-consistent threshold directly. See
// fixtures/calibration-pairs.mjs header for the fuller writeup.

import { createHash } from "node:crypto";

/**
 * Balanced accuracy of classifying `distances` as "same" when
 * `distance < threshold`, given the true `labels` ("same" | "different").
 * mean(sensitivity, specificity) — the metric this repo's own
 * balancedAccuracy* functions elsewhere (evals/judge/gate.mjs) already use
 * for the same reason: robust to class imbalance, which this pair set has
 * (more "different" pairs than "same" — see calibration-pairs.mjs counts).
 *
 * @param {number[]} distances
 * @param {("same"|"different")[]} labels
 * @param {number} threshold
 */
export function balancedAccuracyAt(distances, labels, threshold) {
  if (distances.length !== labels.length) {
    throw new Error("balancedAccuracyAt: distances and labels must be the same length");
  }
  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (let i = 0; i < distances.length; i++) {
    const predictedSame = distances[i] < threshold;
    const actualSame = labels[i] === "same";
    if (actualSame && predictedSame) tp++;
    else if (actualSame && !predictedSame) fn++;
    else if (!actualSame && !predictedSame) tn++;
    else fp++;
  }
  const sensitivity = tp + fn > 0 ? tp / (tp + fn) : NaN;
  const specificity = tn + fp > 0 ? tn / (tn + fp) : NaN;
  return { balancedAccuracy: (sensitivity + specificity) / 2, sensitivity, specificity, tp, fn, tn, fp };
}

/**
 * Select CLUSTER_DISTANCE_THRESHOLD by the registered rule above: candidates
 * are midpoints between consecutive sorted observed distances, the optimum
 * is the maximum balanced accuracy, ties broken by the widest optimal
 * plateau's midpoint.
 *
 * @param {number[]} distances
 * @param {("same"|"different")[]} labels
 * @returns {{
 *   threshold: number,
 *   achievedBalancedAccuracy: number,
 *   candidates: Array<{ threshold: number, balancedAccuracy: number }>,
 *   selectionRule: string,
 * }}
 */
export function selectThreshold(distances, labels) {
  if (!Array.isArray(distances) || distances.length === 0) {
    throw new Error("selectThreshold: distances must be a non-empty array");
  }
  if (distances.length !== labels.length) {
    throw new Error("selectThreshold: distances and labels must be the same length");
  }

  const sorted = [...new Set(distances)].sort((a, b) => a - b);
  if (sorted.length < 2) {
    throw new Error("selectThreshold: need at least 2 distinct observed distances to form a candidate threshold");
  }

  const candidates = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const t = (sorted[i] + sorted[i + 1]) / 2;
    const { balancedAccuracy } = balancedAccuracyAt(distances, labels, t);
    candidates.push({ threshold: t, balancedAccuracy });
  }

  const maxBA = Math.max(...candidates.map((c) => c.balancedAccuracy));
  // Tolerance for float-equality comparison of balanced-accuracy ties.
  const EPS = 1e-9;

  // Find the widest run of consecutive candidates (by threshold order,
  // already sorted since `sorted` is sorted) whose balancedAccuracy ties the
  // max — a "plateau" in the step function.
  let bestRun = null;
  let runStart = null;
  for (let i = 0; i < candidates.length; i++) {
    const isOptimal = Math.abs(candidates[i].balancedAccuracy - maxBA) < EPS;
    if (isOptimal && runStart === null) runStart = i;
    const atEnd = i === candidates.length - 1;
    if ((!isOptimal || atEnd) && runStart !== null) {
      const runEnd = isOptimal && atEnd ? i : i - 1;
      const width = candidates[runEnd].threshold - candidates[runStart].threshold;
      if (!bestRun || width > bestRun.width) {
        bestRun = { start: runStart, end: runEnd, width };
      }
      runStart = null;
    }
  }

  const threshold = (candidates[bestRun.start].threshold + candidates[bestRun.end].threshold) / 2;

  return {
    threshold,
    achievedBalancedAccuracy: maxBA,
    candidates,
    selectionRule:
      "candidates = midpoints of consecutive sorted observed pairwise distances; " +
      "select threshold(s) maximising balanced accuracy (mean of sensitivity, specificity) on the " +
      "same/different pair labels; ties broken by the midpoint of the widest run of consecutive " +
      "candidate thresholds achieving the maximum",
  };
}

/**
 * Deterministic content hash of a labelled pair set, so a durable
 * calibration record can name exactly which pairs (and labels) produced a
 * given threshold — same sha256/12-hex convention as
 * lib/manifest.mjs configHash / evals/corpus/index.mjs briefContentHash.
 * Hashes `{a, b, label}` only (not stratum/briefId/kind metadata), so the
 * hash reflects exactly the data selectThreshold actually consumes.
 *
 * @param {Array<{a: string, b: string, label: string}>} pairs
 */
export function pairSetHash(pairs) {
  const picked = pairs.map(({ a, b, label }) => ({ a, b, label }));
  return createHash("sha256").update(JSON.stringify(picked)).digest("hex").slice(0, 12);
}
