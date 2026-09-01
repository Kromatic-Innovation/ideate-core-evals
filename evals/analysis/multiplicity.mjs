// multiplicity.mjs — Holm-Bonferroni and Benjamini-Hochberg correction.
// Pure functions of a p-value array; no knowledge of what produced them.
//
// §6.2 / B7 (closing line): "Holm-Bonferroni is applied across the 5
// registered hypotheses regardless of which rung each lane landed on." The
// family Holm corrects is FIXED at 5 (H1..H5) — callers must pass exactly
// that many p-values (in H1..H5 order) to holmBonferroni() for the
// registered family; it is not "however many contrasts happened to get
// computed this run." Exploratory contrasts (per-arm-vs-A breakdowns, etc.)
// get their own, separately-sized BH family — see benjaminiHochberg().

/**
 * Holm-Bonferroni step-down correction. Returns ADJUSTED p-values in the
 * SAME order as the input (not sorted) so a caller can zip them back onto
 * hypothesis labels without re-deriving the sort.
 *
 * Standard step-down: sort ascending, adjust p_(i) by (m - i), enforce
 * monotonicity (each adjusted p is at least as large as the previous one in
 * sorted order), cap at 1.
 *
 * @param {number[]} pValues
 * @returns {number[]} adjusted p-values, same order/length as input
 */
export function holmBonferroni(pValues) {
  if (!Array.isArray(pValues) || pValues.length === 0) {
    throw new Error("holmBonferroni: pValues must be a non-empty array");
  }
  for (const p of pValues) {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`holmBonferroni: every p-value must be finite in [0,1], got ${p}`);
    }
  }
  const m = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);

  const adjustedSorted = [];
  let runningMax = 0;
  for (let rank = 0; rank < m; rank++) {
    const raw = (m - rank) * indexed[rank].p;
    runningMax = Math.max(runningMax, Math.min(raw, 1));
    adjustedSorted.push(runningMax);
  }

  const out = new Array(m);
  for (let rank = 0; rank < m; rank++) {
    out[indexed[rank].i] = adjustedSorted[rank];
  }
  return out;
}

/**
 * Benjamini-Hochberg step-up FDR correction. Returns adjusted p-values
 * (q-values) in the SAME order as the input.
 *
 * @param {number[]} pValues
 * @returns {number[]} adjusted p-values, same order/length as input
 */
export function benjaminiHochberg(pValues) {
  if (!Array.isArray(pValues) || pValues.length === 0) {
    throw new Error("benjaminiHochberg: pValues must be a non-empty array");
  }
  for (const p of pValues) {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`benjaminiHochberg: every p-value must be finite in [0,1], got ${p}`);
    }
  }
  const m = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);

  const adjustedSorted = new Array(m);
  let runningMin = 1;
  for (let rank = m - 1; rank >= 0; rank--) {
    const raw = (indexed[rank].p * m) / (rank + 1);
    runningMin = Math.min(runningMin, Math.min(raw, 1));
    adjustedSorted[rank] = runningMin;
  }

  const out = new Array(m);
  for (let rank = 0; rank < m; rank++) {
    out[indexed[rank].i] = adjustedSorted[rank];
  }
  return out;
}
