import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRarefiedFrame, PoolsUnavailableError, MixedPoolCoverageError } from "./rarefiedFrame.mjs";
import { distinctK } from "../metrics/clustering.mjs";
import { rarefyPools, RAREFACTION_R, RAREFACTION_SEED } from "./rarefaction.mjs";

// ── Local PRNG for TEST FIXTURE construction only, matching
// rarefaction.test.mjs's own vendored copy and comment (never rarefaction.mjs's
// internal sampling RNG). ──────────────────────────────────────────────────
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

const THRESHOLD = 0.5;

function row({ cellKey, armId, briefId, pool }) {
  return {
    cellKey,
    armId,
    briefId,
    replicate: 0,
    cfg: "cfg1",
    response: pool === undefined ? undefined : distinctK(pool, THRESHOLD),
    costUsd: 0,
    pool,
  };
}

function baseFrame(rows, armLevels) {
  return {
    rows,
    armLevels,
    briefLevels: [...new Set(rows.map((r) => r.briefId))],
    responseField: "distinct_k",
    poolField: "pool",
    configHash: "cfg1",
    excluded: { failed: [], skipped: [], stale: [] },
    failuresByArm: {},
    skippedByArm: {},
  };
}

test("buildRarefiedFrame: no pools anywhere in the contrast -> PoolsUnavailableError, never a silent full-pool fallback", () => {
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1" }), // no pool field at all
    row({ cellKey: "P|b1", armId: "P", briefId: "b1" }),
  ];
  const frame = baseFrame(rows, ["A", "P"]);
  assert.throws(
    () => buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD }),
    PoolsUnavailableError,
  );
});

test("buildRarefiedFrame: some cells have a pool, some don't -> MixedPoolCoverageError, refuses a partially rarefied contrast", () => {
  const poolA = makeCategoricalPool(50, 30, 1);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P|b1", armId: "P", briefId: "b1" }), // no pool
  ];
  const frame = baseFrame(rows, ["A", "P"]);
  assert.throws(
    () => buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD }),
    MixedPoolCoverageError,
  );
});

test("buildRarefiedFrame: threshold is required WHEN pools are actually present, no silent default", () => {
  const poolA = makeCategoricalPool(50, 30, 1);
  const poolP = makeCategoricalPool(50, 60, 2);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P|b1", armId: "P", briefId: "b1", pool: poolP }),
  ];
  const frame = baseFrame(rows, ["A", "P"]);
  assert.throws(() => buildRarefiedFrame(frame, { armIds: ["A", "P"] }), /threshold/);
});

test("buildRarefiedFrame: threshold guard ordering -- a pool-less contrast reaches PoolsUnavailableError even with NO threshold supplied (issue #73 fix round, BLOCKING 2)", () => {
  // This is the exact shape of the documented CLI invocation before the fix
  // round: --cluster-distance-threshold was never passed, and today EVERY
  // real store is pool-less (#8/Phase 2a hasn't run). Requiring a valid
  // threshold before checking pool availability would turn this ordinary,
  // expected "not computed yet" state into an opaque, uncaught plain Error
  // that aborts the whole analysis run with zero artifacts -- exactly the
  // regression this test pins against.
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1" }), // no pool
    row({ cellKey: "P|b1", armId: "P", briefId: "b1" }), // no pool
  ];
  const frame = baseFrame(rows, ["A", "P"]);
  assert.throws(
    () => buildRarefiedFrame(frame, { armIds: ["A", "P"] }), // threshold OMITTED, matching the documented CLI
    PoolsUnavailableError,
    "a pool-less contrast must be diagnosed as PoolsUnavailableError, not an opaque 'threshold required' Error, regardless of whether a threshold was ever supplied",
  );
});

test("buildRarefiedFrame: refuses a metric Appendix C excludes from Arm-A contrasts (poolFluency)", () => {
  const poolA = makeCategoricalPool(50, 30, 1);
  const rows = [row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA })];
  const frame = baseFrame(rows, ["A"]);
  assert.throws(
    () => buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD, metric: "poolFluency" }),
    /not "rarefied"/,
  );
});

test("buildRarefiedFrame: refuses a full-pool metric (poolDiversity) — not registered rarefied", () => {
  const poolA = makeCategoricalPool(50, 30, 1);
  const rows = [row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA })];
  const frame = baseFrame(rows, ["A"]);
  assert.throws(
    () => buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD, metric: "poolDiversity" }),
    /not "rarefied"/,
  );
});

test("buildRarefiedFrame: refuses when the stored response disagrees with the pool's recomputed full-pool distinct_k (wrong threshold / stale scalar)", () => {
  const poolA = makeCategoricalPool(50, 30, 1);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P|b1", armId: "P", briefId: "b1", pool: makeCategoricalPool(50, 60, 2) }),
  ];
  // Corrupt the stored scalar so it disagrees with distinctK(poolA, THRESHOLD).
  rows[0].response = rows[0].response + 1000;
  const frame = baseFrame(rows, ["A", "P"]);
  assert.throws(
    () => buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD }),
    /disagrees with the stored result/,
  );
});

test("buildRarefiedFrame: rarefies to the MINIMUM pool size present in THIS contrast, not the whole base frame (per-contrast scoping, Appendix C item 2/4)", () => {
  // Three arms: A (n=20), P1 (n=40), P2 (n=80). A H1-shaped contrast over
  // {A, P1, P2} must rarefy to 20; a narrower {A, P1} contrast must ALSO
  // rarefy to 20 (A is still the min) -- but a {P1, P2} contrast (no A) must
  // rarefy to 40, not 20. This is the discriminator between "contrast-scoped
  // minPoolSize" and "globally-scoped minPoolSize over the whole frame".
  const poolA = makeCategoricalPool(50, 20, 1);
  const poolP1 = makeCategoricalPool(50, 40, 2);
  const poolP2 = makeCategoricalPool(50, 80, 3);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P1|b1", armId: "P1", briefId: "b1", pool: poolP1 }),
    row({ cellKey: "P2|b1", armId: "P2", briefId: "b1", pool: poolP2 }),
  ];
  const frame = baseFrame(rows, ["A", "P1", "P2"]);

  const h1Shaped = buildRarefiedFrame(frame, { armIds: ["A", "P1", "P2"], threshold: THRESHOLD, rarefyOpts: { r: 200, seed: RAREFACTION_SEED } });
  for (const r of h1Shaped.rows) assert.equal(r.rarefiedN, 20, `${r.cellKey}: contrast-wide min is 20 (A)`);

  const narrow = buildRarefiedFrame(frame, { armIds: ["A", "P1"], threshold: THRESHOLD, rarefyOpts: { r: 200, seed: RAREFACTION_SEED } });
  for (const r of narrow.rows) assert.equal(r.rarefiedN, 20, "A vs P1: still 20");
  assert.equal(narrow.rows.length, 2, "P2's row must not be pulled into an {A, P1} contrast");

  const noA = buildRarefiedFrame(frame, { armIds: ["P1", "P2"], threshold: THRESHOLD, rarefyOpts: { r: 200, seed: RAREFACTION_SEED } });
  for (const r of noA.rows) assert.equal(r.rarefiedN, 40, "P1 vs P2 (no A): min is P1's 40, not A's 20 — global min would wrongly give 20");
});

test("buildRarefiedFrame: preserves both values -- responseFullPool (unchanged) and response (rarefied)", () => {
  const poolA = makeCategoricalPool(50, 30, 11);
  const poolP = makeCategoricalPool(50, 60, 22);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P|b1", armId: "P", briefId: "b1", pool: poolP }),
  ];
  const frame = baseFrame(rows, ["A", "P"]);
  const out = buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD, rarefyOpts: { r: 300, seed: RAREFACTION_SEED } });

  const aRow = out.rows.find((r) => r.cellKey === "A|b1");
  const pRow = out.rows.find((r) => r.cellKey === "P|b1");
  assert.equal(aRow.responseFullPool, distinctK(poolA, THRESHOLD));
  assert.equal(pRow.responseFullPool, distinctK(poolP, THRESHOLD));
  // A is already at the target size (min = 30) so response === responseFullPool;
  // P's rarefied response must differ from its (larger-pool) full-pool value.
  assert.equal(aRow.response, aRow.responseFullPool);
  assert.notEqual(pRow.response, pRow.responseFullPool);
});

test("buildRarefiedFrame: never carries the base frame's excluded/failuresByArm/skippedByArm -- those describe the FULL frame, rows here are a contrast-scoped subset (issue #73 fix round, latent-trap fix)", () => {
  const poolA = makeCategoricalPool(50, 30, 11);
  const poolP = makeCategoricalPool(50, 60, 22);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P|b1", armId: "P", briefId: "b1", pool: poolP }),
  ];
  const frame = baseFrame(rows, ["A", "P"]);
  frame.excluded = { failed: [{ key: "arm=B|brief=b1|rep=0|cfg=c" }], skipped: [], stale: [] };
  frame.failuresByArm = { B: { parse_failure: 3 } };
  frame.skippedByArm = { B: 1 };
  const out = buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD, rarefyOpts: { r: 100, seed: RAREFACTION_SEED } });
  assert.ok(!("excluded" in out), "excluded must not be spread from the base frame onto a contrast-scoped subset");
  assert.ok(!("failuresByArm" in out), "failuresByArm must not be spread from the base frame onto a contrast-scoped subset");
  assert.ok(!("skippedByArm" in out), "skippedByArm must not be spread from the base frame onto a contrast-scoped subset");
});

test("buildRarefiedFrame: with NO opts.rarefyOpts, uses the REGISTERED RAREFACTION_R/RAREFACTION_SEED -- never a smaller/faster override (docs/PREREGISTRATION.md Appendix C item 2 pins R=1000 by name)", () => {
  // The bug this pins: buildRarefiedFrame forwards `opts.rarefyOpts || {}` to
  // rarefyPools(), which itself defaults r/seed to RAREFACTION_R/
  // RAREFACTION_SEED when they're absent (rarefiedDistinctK's `opts.r ??
  // RAREFACTION_R`). Nothing PINS that forwarding -- a mutation that
  // hardcodes a smaller r (e.g. {r: 2}) INSIDE buildRarefiedFrame's own call
  // to rarefyPools, discarding whatever the caller passed (or didn't pass),
  // would silently drift the pipeline away from the registered R with every
  // existing test still green, because every OTHER test here deliberately
  // passes a small r for speed. This is the one test that calls
  // buildRarefiedFrame with rarefyOpts OMITTED ENTIRELY, at the real
  // registered R=1000 (verified fast: ~0.2s for a pool of this size), and
  // checks the result against an independently computed rarefyPools() call
  // using the EXPLICIT registered constants on the exact same inputs.
  const poolA = makeCategoricalPool(50, 30, 11);
  const poolP = makeCategoricalPool(50, 60, 22);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P|b1", armId: "P", briefId: "b1", pool: poolP }),
  ];
  const frame = baseFrame(rows, ["A", "P"]);

  const out = buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD }); // no rarefyOpts at all

  const expected = rarefyPools(
    { "A|b1": poolA, "P|b1": poolP },
    THRESHOLD,
    { r: RAREFACTION_R, seed: RAREFACTION_SEED }, // explicit, matching the registered constants by name
  );

  const aRow = out.rows.find((r) => r.cellKey === "A|b1");
  const pRow = out.rows.find((r) => r.cellKey === "P|b1");
  assert.equal(aRow.response, expected["A|b1"].distinctKRarefied, "omitting rarefyOpts must use RAREFACTION_R/RAREFACTION_SEED exactly, not a smaller/faster override");
  assert.equal(pRow.response, expected["P|b1"].distinctKRarefied, "omitting rarefyOpts must use RAREFACTION_R/RAREFACTION_SEED exactly, not a smaller/faster override");
});

test("buildRarefiedFrame: responseField is named distinctly from the base frame's -- a rarefied MEAN must never sit under a raw count's column label (issue #73 fix round, non-blocking rider)", () => {
  const poolA = makeCategoricalPool(50, 30, 11);
  const poolP = makeCategoricalPool(50, 60, 22);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P|b1", armId: "P", briefId: "b1", pool: poolP }),
  ];
  const frame = baseFrame(rows, ["A", "P"]); // frame.responseField === "distinct_k"
  const out = buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD, rarefyOpts: { r: 100, seed: RAREFACTION_SEED } });
  assert.notEqual(out.responseField, frame.responseField, "the rarefied frame's responseField must differ from the base frame's -- reusing it would mislabel a rarefied mean as the raw count");
  assert.equal(out.responseField, "distinct_k_rarefied");
});

test("buildRarefiedFrame: poolFlexibility is derived from distinct_k's own rarefaction, not independently recomputed", () => {
  // poolFlexibility(k) === k identically (operational.mjs) -- there is no
  // separate clustering pass for it. Store the SAME distinctK count under
  // the poolFlexibility metric label and confirm the rarefied output is
  // bit-identical to distinct_k's own rarefaction on the same pools.
  const poolA = makeCategoricalPool(50, 30, 11);
  const poolP = makeCategoricalPool(50, 60, 22);
  const rows = [
    row({ cellKey: "A|b1", armId: "A", briefId: "b1", pool: poolA }),
    row({ cellKey: "P|b1", armId: "P", briefId: "b1", pool: poolP }),
  ];
  const frame = baseFrame(rows, ["A", "P"]);
  const distinctKOut = buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD, metric: "distinct_k", rarefyOpts: { r: 300, seed: RAREFACTION_SEED } });
  const flexOut = buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD, metric: "poolFlexibility", rarefyOpts: { r: 300, seed: RAREFACTION_SEED } });

  for (const key of ["A|b1", "P|b1"]) {
    const dk = distinctKOut.rows.find((r) => r.cellKey === key);
    const fx = flexOut.rows.find((r) => r.cellKey === key);
    assert.equal(fx.response, dk.response, `${key}: poolFlexibility's rarefied value must equal distinct_k's, not an independent computation`);
  }
});
