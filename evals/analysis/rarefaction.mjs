// rarefaction.mjs — the registered rarefaction rule for arm-A contrasts
// (issue #70, docs/PREREGISTRATION.md Appendix C).
//
// ── The defect this exists to close ─────────────────────────────────────────
// Arm A (solo) runs 1 round -> pool ~30. Every panel arm runs maxRounds: 2 ->
// pool ~60 (arms.config.json). distinct_k is monotone non-decreasing in pool
// size, so any arm-A contrast (H1, and the A-vs-A' ablation) could be won by
// pool size alone, with the multi-agent machinery contributing nothing. This
// module implements the registered fix: rarefy every pool in a contrast down
// to the SMALLEST pool size present in that contrast, average distinct_k over
// R random subsamples, and report both the rarefied and full-pool values.
//
// ── Why a rule, not a hardcoded pool size (Appendix C) ──────────────────────
// No generation has ever been run. ~60 is a traced upper bound from reading
// ideate-core's source, not a measurement — ideate-core.mjs:354 dedupes the
// panel pool by normalized text, so the observed size may be well under 60.
// Registering "rarefy to 30" would need re-amending the moment #8 measures
// the real pool size. Registering "rarefy to min(pool sizes in the contrast)"
// never needs to change.
//
// ── Why random subsampling, never truncation to the first n ─────────────────
// The first 30 of a panel pool IS that arm's round-1 output (round 2 APPENDS
// candidates — ideate-core.mjs:271/338). Truncating to the first n discards
// exactly the build-on-each-other mechanism the product's claim rests on,
// biasing the rarefied comparison AGAINST the panel arms — the opposite
// direction from the confound this module exists to remove — and it is not
// the registered comparison either. Every subsample this module draws is a
// uniform random draw without replacement over the WHOLE pool, via a seeded
// PRNG (mulberry32, vendored — see order.mjs / sample.mjs / pareto.mjs for
// the same pattern elsewhere in this repo). There is no code path here that
// takes "the first n" of anything.
//
// ── R and the seed are named constants the appendix cites ───────────────────
// RAREFACTION_R and RAREFACTION_SEED below are the single source of truth for
// the CODE. docs/PREREGISTRATION.md's Appendix C item 2 also states the
// numeric values in prose (1000 / 20260901), for a reader who isn't going to
// open this file — the two are not automatically the same thing, so the
// actual anti-drift mechanism is a test (rarefaction.test.mjs's "registered,
// explicit, positive integers" test), not this comment. If the appendix and
// this file ever disagree, the constants here are what evals/analysis/
// actually runs. Averaging over R draws only PARTLY recovers the information
// a single full-pool measurement would have — rarefaction is registered as
// noisier than the full-pool comparison, not as a free lunch (Appendix C item
// 6 / pilot consequences).
//
// ── Which §4.1 metrics this applies to ───────────────────────────────────────
// RAREFACTION_TREATMENT documents the per-metric registration decision so a
// caller doesn't have to re-derive it from the appendix prose.

import { distinctK } from "../metrics/clustering.mjs";

/** R: number of random subsamples averaged per rarefied distinct_k estimate.
 *  Registered in docs/PREREGISTRATION.md Appendix C — cited by name, not by
 *  value, so the document and this constant cannot silently drift apart. */
export const RAREFACTION_R = 1000;

/** Seed for the subsampling PRNG (mulberry32). Registered in
 *  docs/PREREGISTRATION.md Appendix C alongside RAREFACTION_R, for the same
 *  reason. An explicit integer, never wall-clock — see order.mjs's header
 *  comment for why this repo always seeds its randomness explicitly. */
export const RAREFACTION_SEED = 20260901;

/** Which §4.1 primary metrics receive the rarefied treatment in an arm-A
 *  contrast, and why — the per-metric table in Appendix C item 3, as data.
 *
 *  poolFluency and collapseRate are "excluded", NOT "rarefied": an earlier
 *  draft of this registration said poolFluency was rarefied "because it IS
 *  the pool size" — backwards. poolFluency(pool) === pool.length exactly
 *  (operational.mjs), so a "rarefied" poolFluency would just be rarefiedN
 *  restated — a constant with zero variance, not a metric. collapseRate
 *  needs the pre-dedup raw candidate list to rarefy coherently (spans
 *  stage-3 clusters over stage-1 raw candidates), which the harness does not
 *  retain today (Appendix C item 6) — rarefying only the post-dedup
 *  numerator against the full raw-candidate denominator would spuriously
 *  inflate the panel arm's collapse rate. Both are reported full-pool as
 *  descriptives and excluded from Arm-A confirmatory contrasts instead. */
export const RAREFACTION_TREATMENT = Object.freeze({
  distinct_k: "rarefied", // monotone non-decreasing in pool size
  poolFlexibility: "rarefied", // identity pass-through of distinct_k (operational.mjs) — follows it exactly
  poolFluency: "excluded-full-pool-descriptive", // === pool.length exactly; "rarefied" would just be rarefiedN restated
  collapseRate: "excluded-full-pool-descriptive", // needs pre-dedup raw candidates the harness doesn't retain (Appendix C item 6)
  poolDiversity: "full-pool", // mean pairwise distance — point estimate is a mean, roughly n-robust (its VARIANCE still scales ~1/n)
  distinctKPerDollar: "full-pool-self-correcting", // the extra generation is paid for on the cost side
});

/** mulberry32: seeded 32-bit PRNG, vendored per this repo's convention
 *  (order.mjs, sample.mjs, pareto.mjs, gate.mjs each vendor their own copy
 *  rather than sharing a dependency — this repo ships zero runtime deps). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw `n` distinct indices from [0, poolSize) uniformly at random, without
 * replacement, via partial Fisher-Yates over an index pool (same
 * draw-without-replacement shape as evals/corpus/sample.mjs's
 * sampleKeywords). This is the ONLY sampling primitive rarefiedDistinctK
 * uses — there is no "take the first n" path anywhere in this module.
 *
 * @param {number} poolSize
 * @param {number} n
 * @param {() => number} rng   e.g. mulberry32(seed)
 * @returns {number[]} n distinct indices, in draw order
 */
export function sampleIndicesWithoutReplacement(poolSize, n, rng) {
  if (!Number.isInteger(poolSize) || poolSize <= 0) {
    throw new Error(`sampleIndicesWithoutReplacement: poolSize must be a positive integer, got ${poolSize}`);
  }
  if (!Number.isInteger(n) || n <= 0 || n > poolSize) {
    throw new Error(`sampleIndicesWithoutReplacement: n (${n}) must be a positive integer <= poolSize (${poolSize})`);
  }
  const pool = Array.from({ length: poolSize }, (_, i) => i);
  const picked = [];
  for (let i = 0; i < n; i++) {
    const j = Math.floor(rng() * pool.length);
    picked.push(pool[j]);
    pool.splice(j, 1);
  }
  return picked;
}

/**
 * The minimum pool size across every pool in a contrast — the rarefaction
 * target. Registered as "the minimum pool size within that contrast", never
 * a hardcoded number (see module header).
 *
 * @param {Array<Array>} pools  each pool as an array (vectors, or anything
 *                              with a `.length`)
 * @returns {number}
 */
export function minPoolSize(pools) {
  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error("minPoolSize: pools must be a non-empty array of pools");
  }
  return Math.min(...pools.map((p) => p.length));
}

/**
 * Rarefied distinct_k for one embedded pool: draw `r` random subsamples of
 * size `n` (without replacement, uniform over the whole pool — never the
 * first n), compute distinct_k on each, and average. Averaging over R draws
 * only PARTLY recovers the information discarded by subsampling — this is
 * registered as noisier than the full-pool distinct_k, not a free lunch.
 *
 * @param {number[][]} vectors    the full embedded pool
 * @param {number} n              rarefaction target (<= vectors.length) —
 *                                 typically minPoolSize() over a contrast
 * @param {number} threshold      cluster distance threshold (see
 *                                 evals/metrics/clustering.mjs)
 * @param {object} [opts]
 *   @param {number} [opts.r=RAREFACTION_R]
 *   @param {number} [opts.seed=RAREFACTION_SEED]
 * @returns {number}  mean distinct_k over the r subsamples
 */
export function rarefiedDistinctK(vectors, n, threshold, opts = {}) {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new Error("rarefiedDistinctK: vectors must be a non-empty array");
  }
  if (!Number.isInteger(n) || n <= 0 || n > vectors.length) {
    throw new Error(`rarefiedDistinctK: n (${n}) must be a positive integer <= vectors.length (${vectors.length})`);
  }
  const r = opts.r ?? RAREFACTION_R;
  const seed = opts.seed ?? RAREFACTION_SEED;
  if (!Number.isInteger(r) || r < 2) {
    throw new Error(
      `rarefiedDistinctK: r (subsample count) must be an integer >= 2, got ${r} — r=1 is a single draw, not an average, and defeats the point of rarefaction (see the KEY discriminating test in rarefaction.test.mjs for why r matters statistically, not just structurally)`,
    );
  }
  if (!Number.isInteger(seed)) {
    throw new Error(`rarefiedDistinctK: seed must be an explicit integer, got ${JSON.stringify(seed)} — an unseeded draw can't be replayed`);
  }

  const rng = mulberry32(seed);
  let sum = 0;
  for (let i = 0; i < r; i++) {
    const idx = sampleIndicesWithoutReplacement(vectors.length, n, rng);
    const subsample = idx.map((j) => vectors[j]);
    sum += distinctK(subsample, threshold);
  }
  return sum / r;
}

/**
 * Rarefy every pool in a contrast to the minimum pool size present, and
 * report both the rarefied and full-pool distinct_k for each — the
 * registered estimand (rarefied) alongside the secondary descriptive
 * (full-pool), per Appendix C item 5.
 *
 * @param {Record<string, number[][]>} poolsByLabel   e.g. {A: poolA, "A'": poolAPrime}
 *                                                     or {A: poolA, panel: poolPanel}
 * @param {number} threshold
 * @param {object} [opts]  forwarded to rarefiedDistinctK (r, seed)
 * @returns {Record<string, {
 *   poolSize: number,
 *   rarefiedN: number,
 *   distinctKFullPool: number,
 *   distinctKRarefied: number,
 * }>}
 */
export function rarefyPools(poolsByLabel, threshold, opts = {}) {
  const labels = Object.keys(poolsByLabel);
  if (labels.length === 0) {
    throw new Error("rarefyPools: poolsByLabel must have at least one entry");
  }
  const pools = labels.map((label) => poolsByLabel[label]);
  const n = minPoolSize(pools);

  const out = {};
  for (const label of labels) {
    const vectors = poolsByLabel[label];
    out[label] = {
      poolSize: vectors.length,
      rarefiedN: n,
      distinctKFullPool: distinctK(vectors, threshold),
      distinctKRarefied: rarefiedDistinctK(vectors, n, threshold, opts),
    };
  }
  return out;
}
