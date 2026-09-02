import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RAREFACTION_R,
  RAREFACTION_SEED,
  RAREFACTION_TREATMENT,
  sampleIndicesWithoutReplacement,
  minPoolSize,
  rarefiedDistinctK,
  rarefyPools,
} from "./rarefaction.mjs";
import { distinctK } from "../metrics/clustering.mjs";

// ── Local PRNG for TEST FIXTURE generation only — deliberately separate from
// rarefaction.mjs's internal mulberry32 (which drives subsampling, not pool
// construction). Same algorithm, matching this repo's usual per-file vendoring. ──
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
 * Build a pool of `n` one-hot vectors over `categoryCount` categories, each
 * draw's category chosen uniformly at random WITH replacement (so repeats —
 * i.e. semantic duplicates — are possible, exactly like a real idea pool).
 * One-hot vectors give exact, deterministic clustering: cosine distance is
 * 0 between two draws of the SAME category and 1 (orthogonal) between two
 * DIFFERENT categories, so distinct_k for the resulting pool is exactly the
 * number of distinct categories drawn — no calibration/threshold noise to
 * control for, only the pool-size effect this test targets.
 *
 * @param {number} categoryCount
 * @param {number} n
 * @param {number} seed
 * @returns {number[][]}
 */
function makeCategoricalPool(categoryCount, n, seed) {
  const rng = mulberry32(seed);
  const pool = [];
  for (let i = 0; i < n; i++) {
    const category = Math.floor(rng() * categoryCount);
    const vec = new Array(categoryCount).fill(0);
    vec[category] = 1;
    pool.push(vec);
  }
  return pool;
}

const THRESHOLD = 0.5; // anywhere in (0, 1) works: one-hot distances are exactly 0 or 1

test("RAREFACTION_R and RAREFACTION_SEED are registered, explicit, positive integers", () => {
  assert.ok(Number.isInteger(RAREFACTION_R) && RAREFACTION_R > 1, "R must be > 1 — a single draw is not an average");
  assert.ok(Number.isInteger(RAREFACTION_SEED), "seed must be an explicit integer");
});

// Pins the EXACT values docs/PREREGISTRATION.md Appendix C item 2 states in
// prose (RAREFACTION_R = 1000, RAREFACTION_SEED = 20260901). The test above
// only checks shape (positive integer, integer) — mutating R to 137 or the
// seed to 12345 leaves it green while silently disagreeing with the frozen
// document. This is the actual anti-drift mechanism (see rarefaction.mjs's
// header comment on why the code comment alone isn't one).
test("RAREFACTION_R and RAREFACTION_SEED match the exact values registered in docs/PREREGISTRATION.md Appendix C item 2", () => {
  assert.equal(RAREFACTION_R, 1000);
  assert.equal(RAREFACTION_SEED, 20260901);
});

test("RAREFACTION_TREATMENT registers the per-metric decision from Appendix C item 3", () => {
  assert.equal(RAREFACTION_TREATMENT.distinct_k, "rarefied");
  assert.equal(RAREFACTION_TREATMENT.poolFlexibility, "rarefied"); // identity pass-through of distinct_k — must follow it exactly
  assert.equal(RAREFACTION_TREATMENT.poolFluency, "excluded-full-pool-descriptive"); // === pool.length; NOT rarefied
  assert.equal(RAREFACTION_TREATMENT.collapseRate, "excluded-full-pool-descriptive"); // needs pre-dedup raw candidates the harness doesn't retain
  assert.equal(RAREFACTION_TREATMENT.poolDiversity, "full-pool");
  assert.equal(RAREFACTION_TREATMENT.distinctKPerDollar, "full-pool-self-correcting");
});

test("sampleIndicesWithoutReplacement: n distinct indices in range, no repeats", () => {
  const rng = mulberry32(1);
  const idx = sampleIndicesWithoutReplacement(60, 30, rng);
  assert.equal(idx.length, 30);
  assert.equal(new Set(idx).size, 30, "no index drawn twice");
  for (const i of idx) assert.ok(i >= 0 && i < 60);
});

test("sampleIndicesWithoutReplacement: rejects n > poolSize", () => {
  const rng = mulberry32(1);
  assert.throws(() => sampleIndicesWithoutReplacement(10, 11, rng), /n \(11\) must be a positive integer <= poolSize/);
});

test("minPoolSize: the minimum, not the maximum, across pools", () => {
  const pools = [new Array(25), new Array(70), new Array(48)];
  assert.equal(minPoolSize(pools), 25);
});

test("minPoolSize: rejects an empty list of pools", () => {
  assert.throws(() => minPoolSize([]), /non-empty/);
});

test("rarefiedDistinctK: deterministic — same seed produces the same result twice", () => {
  const pool = makeCategoricalPool(50, 60, 7);
  const a = rarefiedDistinctK(pool, 30, THRESHOLD, { r: 200, seed: 99 });
  const b = rarefiedDistinctK(pool, 30, THRESHOLD, { r: 200, seed: 99 });
  assert.equal(a, b);
});

test("rarefiedDistinctK: rejects n > vectors.length", () => {
  const pool = makeCategoricalPool(50, 30, 1);
  assert.throws(() => rarefiedDistinctK(pool, 31, THRESHOLD), /n \(31\) must be a positive integer <= vectors\.length \(30\)/);
});

test("rarefiedDistinctK: rejects r < 2 or non-integer — a single draw is not an average", () => {
  const pool = makeCategoricalPool(50, 30, 1);
  assert.throws(() => rarefiedDistinctK(pool, 30, THRESHOLD, { r: 0 }), /r \(subsample count\) must be an integer >= 2/);
  assert.throws(() => rarefiedDistinctK(pool, 30, THRESHOLD, { r: 1 }), /r \(subsample count\) must be an integer >= 2/);
  assert.throws(() => rarefiedDistinctK(pool, 30, THRESHOLD, { r: 2.5 }), /r \(subsample count\) must be an integer >= 2/);
});

test("rarefiedDistinctK: rejects a non-integer seed", () => {
  const pool = makeCategoricalPool(50, 30, 1);
  assert.throws(() => rarefiedDistinctK(pool, 30, THRESHOLD, { seed: 1.5 }), /seed must be an explicit integer/);
});

test("rarefiedDistinctK: at n === vectors.length, every draw is a full permutation, so the result is exact and R-invariant", () => {
  const pool = makeCategoricalPool(50, 30, 3);
  const raw = distinctK(pool, THRESHOLD);
  const rarefiedFull = rarefiedDistinctK(pool, 30, THRESHOLD, { r: 50, seed: 5 });
  assert.equal(rarefiedFull, raw, "subsampling the whole pool must recover the exact full-pool distinct_k every time");
});

// R is registered because it controls the ESTIMATOR'S VARIANCE, not merely
// because it's a number the API happens to accept — a mutation that quietly
// stopped honoring `opts.r` (always drawing r=2 internally, the function's
// floor) would slip past a test that only checks r is validated. This test
// makes r's effect on variance itself the assertion: at the registered R,
// five independent seeds on the SAME pool/n must agree tightly
// (rarefiedDistinctK is an AVERAGE, so its spread across seeds shrinks as R
// grows); at r=2 (barely an average at all), the same five seeds disagree by
// several units. If a future change silently ignores `opts.r`, this goes red
// on the r=RAREFACTION_R
// assertion regardless of whether r's own input-validation guard survives.
test("rarefiedDistinctK: R controls estimator variance — high R agrees tightly across seeds, r=1 does not", () => {
  const pool = makeCategoricalPool(50, 60, 4242);
  const seeds = [11, 22, 33, 44, 55];

  const spreadAt = (r) => {
    const vals = seeds.map((seed) => rarefiedDistinctK(pool, 30, THRESHOLD, { r, seed }));
    return Math.max(...vals) - Math.min(...vals);
  };

  const highRSpread = spreadAt(RAREFACTION_R);
  const lowRSpread = spreadAt(2); // r's floor (r=1 is rejected by validation) — still far noisier than R=1000

  assert.ok(
    highRSpread <= 1,
    `at the registered R=${RAREFACTION_R}, five independent seeds should agree tightly (spread=${highRSpread}) — ` +
      "if this fails, R is not doing what averaging is supposed to do",
  );
  assert.ok(
    lowRSpread > highRSpread,
    `a low r (2) should disagree across seeds MORE than the registered R=${RAREFACTION_R} (low spread=${lowRSpread}, high spread=${highRSpread}) — ` +
      "if r stopped controlling variance (e.g. opts.r silently ignored), these would be equal",
  );
});

// ── THE KEY TEST ─────────────────────────────────────────────────────────────
// Two pools drawn from the IDENTICAL underlying generative process (uniform
// draw over the same 50 categories, with replacement) but different sizes —
// exactly the shape of the real defect: Arm A's pool (~30) and a panel arm's
// pool (~60) can differ in size for reasons that have nothing to do with the
// panel's multi-agent machinery being "better". The un-rarefied distinct_k
// MUST be sensitive to this pool-size difference (more draws -> more
// categories discovered, a pure sampling artifact). The rarefied distinct_k
// -- both pools rarefied down to the smaller pool's size -- must NOT be
// sensitive to it, within sampling tolerance. If this test doesn't go red
// when rarefaction is removed (i.e. if you just compare raw distinct_k
// directly), it isn't testing anything -- so both a "removed" and a
// "present" assertion are made explicit below.
test("KEY: rarefaction removes a pool-size confound that raw distinct_k is sensitive to", () => {
  const CATEGORY_COUNT = 50;
  const N_SMALL = 30; // Arm A shape
  const N_LARGE = 60; // panel-arm shape

  // Same generative process (uniform over the same 50 categories), different
  // seeds so the two pools are independent draws -- not the same pool
  // truncated, which would trivially pass and prove nothing.
  const poolSmall = makeCategoricalPool(CATEGORY_COUNT, N_SMALL, 1001);
  const poolLarge = makeCategoricalPool(CATEGORY_COUNT, N_LARGE, 2002);

  const rawSmall = distinctK(poolSmall, THRESHOLD);
  const rawLarge = distinctK(poolLarge, THRESHOLD);

  // Expected distinct categories under n draws w/ replacement over C
  // categories: C * (1 - (1 - 1/C)^n). For C=50: n=30 -> ~22.7, n=60 -> ~35.1
  // -- a real, large gap, not noise. Assert the un-rarefied metric shows it:
  // this is the "confound exists and raw distinct_k is sensitive to it" half.
  assert.ok(
    rawLarge - rawSmall >= 8,
    `expected the un-rarefied pool-size confound to produce a large gap (raw distinct_k small=${rawSmall}, large=${rawLarge}) -- ` +
      "if this assertion fails, the fixture isn't constructing the confound this test exists to catch",
  );

  // Now rarefy the larger pool down to the smaller pool's size and compare
  // against the smaller pool's own (unrarefied, since it's already at the
  // target size) distinct_k. If rarefaction works, these should agree within
  // sampling tolerance -- the "confound is removed" half.
  const rarefiedLarge = rarefiedDistinctK(poolLarge, N_SMALL, THRESHOLD, { r: 500, seed: RAREFACTION_SEED });

  const diff = Math.abs(rarefiedLarge - rawSmall);
  assert.ok(
    diff <= 4,
    `rarefied distinct_k (large pool rarefied to ${N_SMALL}: ${rarefiedLarge}) should be close to the small pool's ` +
      `raw distinct_k (${rawSmall}) -- both are draws of size ${N_SMALL} from the same generative process. Got diff=${diff}`,
  );

  // And the rarefied estimate must actually have moved substantially away
  // from the raw (unrarefied) large-pool value -- otherwise rarefaction did
  // nothing and this test would pass by coincidence.
  assert.ok(
    rawLarge - rarefiedLarge >= 5,
    `rarefaction should pull the large pool's distinct_k down substantially from its raw value (raw=${rawLarge}, rarefied=${rarefiedLarge})`,
  );
});

test("rarefyPools: rarefies every pool in the contrast to the minimum pool size present, reports both values", () => {
  const poolA = makeCategoricalPool(50, 30, 11);
  const poolPanel = makeCategoricalPool(50, 60, 22);

  const result = rarefyPools({ A: poolA, panel: poolPanel }, THRESHOLD, { r: 300, seed: RAREFACTION_SEED });

  assert.equal(result.A.poolSize, 30);
  assert.equal(result.panel.poolSize, 60);
  assert.equal(result.A.rarefiedN, 30, "rarefaction target must be the MINIMUM across the contrast");
  assert.equal(result.panel.rarefiedN, 30, "both entries in a contrast rarefy to the same target");

  assert.equal(result.A.distinctKFullPool, distinctK(poolA, THRESHOLD));
  assert.equal(result.panel.distinctKFullPool, distinctK(poolPanel, THRESHOLD));

  // A is already at the target size, so its rarefied value equals its raw
  // value exactly (see the n===vectors.length test above).
  assert.equal(result.A.distinctKRarefied, result.A.distinctKFullPool);

  // The panel's rarefied value should be pulled down from its full-pool
  // value, and be in the same ballpark as A's (same generative process).
  assert.ok(result.panel.distinctKRarefied < result.panel.distinctKFullPool);
  assert.ok(Math.abs(result.panel.distinctKRarefied - result.A.distinctKFullPool) <= 5);
});

test("rarefyPools: three-way contrast (e.g. A vs A' vs a differently-sized third pool) rarefies to the global minimum", () => {
  const poolA = makeCategoricalPool(50, 28, 31);
  const poolAPrime = makeCategoricalPool(50, 60, 32);
  const poolThird = makeCategoricalPool(50, 45, 33);

  const result = rarefyPools({ A: poolA, "A'": poolAPrime, third: poolThird }, THRESHOLD, { r: 100, seed: RAREFACTION_SEED });

  assert.equal(result.A.rarefiedN, 28);
  assert.equal(result["A'"].rarefiedN, 28);
  assert.equal(result.third.rarefiedN, 28);
});

test("rarefyPools: rejects an empty contrast", () => {
  assert.throws(() => rarefyPools({}, THRESHOLD), /must have at least one entry/);
});
