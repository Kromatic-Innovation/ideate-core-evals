// sensitivity.mjs — the registered sensitivity-analysis capability (issue
// #42, item 6): report distinct_k at threshold ±0.05 alongside the
// threshold-free companion metric (mean pairwise distance / poolDiversity,
// which clustering.mjs/diversity.mjs already compute independently of any
// threshold).
//
// ── Scope boundary, stated explicitly ───────────────────────────────────────
// §6.1's H1–H4 are hypotheses about `distinct_k` DIFFERENCES BETWEEN ARMS
// (e.g. H1: "any panel arm > Arm A on distinct_k") computed over real study
// data that does not exist yet — this repo has not run the comparative
// study (docs/PREREGISTRATION.md: "Nothing has been run. Every number below
// is a projection.", and issue #42 itself BLOCKS #1/#48, the issues that run
// cells and analyze them). So "report H1–H4 at threshold ±0.05" cannot mean
// producing actual hypothesis-test results here — there is nothing to test
// yet. What this module provides is the REUSABLE CAPABILITY: given any set
// of embedded pools (real or, for now, these hermetic fixtures),
// poolSensitivityReport computes distinct_k at threshold-0.05, threshold,
// and threshold+0.05 plus the threshold-free companion metric for each pool,
// in the exact shape a future H1–H4 analysis step (#1/#48) can diff across
// arms without re-deriving the "what does ±0.05 mean" question itself. The
// band is a single source of truth (SENSITIVITY_BAND below) rather than a
// magic number repeated at each call site.
//
// ── Why ±0.05, and why it's flagged as MiniLM-scale ─────────────────────────
// §42's issue text registers "±0.05" without deriving it from either
// embedding space. It is left as the registered band here (changing it would
// be its own pre-registration amendment, out of scope for this issue), but
// poolSensitivityReport also reports it AS A FRACTION of the observed
// same/different gap in whichever calibration record is passed in, so a
// reader can see whether ±0.05 is a meaningful perturbation or a rounding
// error in the space actually being measured — see
// fixtures/voyage-calibration-result.json, where the gap between the
// selected threshold and the achieved-balanced-accuracy plateau is Voyage-
// space-specific and numerically nothing like the MiniLM gap ±0.05 was
// presumably sized against.

import { distinctK } from "./clustering.mjs";
import { poolDiversity } from "./diversity.mjs";

export const SENSITIVITY_BAND = 0.05;

/**
 * distinct_k + poolDiversity for one embedded pool, evaluated at
 * threshold - SENSITIVITY_BAND, threshold, and threshold + SENSITIVITY_BAND.
 * poolDiversity (mean pairwise cosine distance) is computed once and
 * reported alongside — it does not depend on the threshold at all, which is
 * the point of a "threshold-free companion metric": if distinct_k swings
 * wildly across the band while poolDiversity stays flat, that is itself
 * evidence the threshold, not the underlying pool, is doing the moving.
 *
 * @param {number[][]} vectors        one embedded pool
 * @param {number} threshold          the base CLUSTER_DISTANCE_THRESHOLD to perturb
 * @param {number} [band]             defaults to SENSITIVITY_BAND
 * @returns {{
 *   threshold: number,
 *   poolDiversity: number,
 *   atLow: { threshold: number, distinctK: number },
 *   atBase: { threshold: number, distinctK: number },
 *   atHigh: { threshold: number, distinctK: number },
 * }}
 */
export function poolSensitivityReport(vectors, threshold, band = SENSITIVITY_BAND) {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error("poolSensitivityReport: threshold must be a non-negative finite number");
  }
  if (!Number.isFinite(band) || band < 0) {
    throw new Error("poolSensitivityReport: band must be a non-negative finite number");
  }
  const low = Math.max(0, threshold - band);
  const high = threshold + band;

  return {
    threshold,
    poolDiversity: poolDiversity(vectors),
    atLow: { threshold: low, distinctK: distinctK(vectors, low) },
    atBase: { threshold, distinctK: distinctK(vectors, threshold) },
    atHigh: { threshold: high, distinctK: distinctK(vectors, high) },
  };
}

/**
 * Sensitivity reports for several NAMED pools at once (e.g. one per arm) —
 * the shape a future cross-arm H1–H4 analysis step consumes directly,
 * without each caller re-deriving the ±band bookkeeping.
 *
 * @param {Record<string, number[][]>} poolsByName
 * @param {number} threshold
 * @param {number} [band]
 * @returns {Record<string, ReturnType<typeof poolSensitivityReport>>}
 */
export function sensitivityReportForPools(poolsByName, threshold, band = SENSITIVITY_BAND) {
  const out = {};
  for (const [name, vectors] of Object.entries(poolsByName)) {
    out[name] = poolSensitivityReport(vectors, threshold, band);
  }
  return out;
}

/**
 * Express SENSITIVITY_BAND as a fraction of an observed same/different gap
 * (e.g. from a voyage-calibration-result.json record's
 * narrowFixtureTransferCheck, or achievedBalancedAccuracy plateau width) —
 * so a reader can see whether ±0.05 is a large or negligible perturbation in
 * the space actually being measured, rather than trusting the registered
 * number's MiniLM-era intuition to carry over silently.
 *
 * @param {number} gapWidth  e.g. minDistinctDistance - maxParaphraseDistance
 * @param {number} [band]
 * @returns {number} band as a fraction of the gap (can exceed 1 if the band
 *   is larger than the whole gap — itself a diagnostic finding)
 */
export function bandAsFractionOfGap(gapWidth, band = SENSITIVITY_BAND) {
  if (!Number.isFinite(gapWidth) || gapWidth <= 0) {
    throw new Error("bandAsFractionOfGap: gapWidth must be a positive finite number");
  }
  return band / gapWidth;
}
