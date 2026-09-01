// multiplicity.mjs — Holm-Bonferroni and Benjamini-Hochberg correction.
// Pure functions of a p-value array; no knowledge of what produced them.
//
// §6.2 / B7 (closing line): "Holm-Bonferroni is applied across the 5
// registered hypotheses regardless of which rung each lane landed on." The
// family Holm corrects is FIXED IN SLOT COUNT, not hypothesis count — H1,
// H2, H4, H5 each contribute one p-value slot, but H3 is registered as TWO
// sub-contrasts (G-D, G-H; see contrasts.mjs's H3 doc comment), so the
// REGISTERED family is 6 SLOTS across 5 hypotheses (1+1+2+1+1), not 5 or 6
// hypotheses. H5 stays unimplemented but still occupies its slot with p=1
// (contrasts.mjs's evaluateSpec()) precisely so wiring it later changes
// only its own result, never rescales the other four. Callers must pass
// exactly `registeredFamilySlotCount()`'s worth of p-values (in H1..H5
// order, H3 expanded) — pass `familySize` (from contrasts.mjs's
// `registeredFamilySlotCount(family)`) to have holmBonferroni() ENFORCE
// this itself rather than trusting the caller got the count right.
// Exploratory contrasts (per-arm-vs-A breakdowns, etc.) get their own,
// separately-sized BH family — see benjaminiHochberg().

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
 * @param {object} [opts]
 *   @param {number} [opts.familySize]  when given, the family this call is
 *     REQUIRED to represent (e.g. contrasts.mjs's
 *     `registeredFamilySlotCount(family)`) — a `pValues.length` mismatch is
 *     a hard error instead of a silently-different multiplicity correction.
 * @returns {number[]} adjusted p-values, same order/length as input
 */
export function holmBonferroni(pValues, opts = {}) {
  if (!Array.isArray(pValues) || pValues.length === 0) {
    throw new Error("holmBonferroni: pValues must be a non-empty array");
  }
  if (opts.familySize !== undefined && pValues.length !== opts.familySize) {
    throw new Error(`holmBonferroni: expected exactly ${opts.familySize} p-values (the registered family size) but got ${pValues.length}`);
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
