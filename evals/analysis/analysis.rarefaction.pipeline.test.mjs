// analysis.rarefaction.pipeline.test.mjs — issue #73: the PIPELINE-level
// discriminating test. rarefaction.test.mjs already proves rarefyPools()
// itself removes a pool-size confound on raw pools; this file proves the
// same thing end to end through the ACTUAL analysis pipeline this study
// runs — a real ResultsStore, frame.mjs's buildFrame(), rarefiedFrame.mjs's
// buildRarefiedFrame(), fit.mjs's fitR2() (pure Node, no sidecar — this test
// stays hermetic and un-skippable), and contrasts.mjs's evaluateContrast().
// If the wiring between those modules were removed, this test — not
// rarefaction.test.mjs's — is the one that would go red.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeTempStore } from "../../lib/store.mjs";
import { cellKey, configHash } from "../../lib/manifest.mjs";
import { buildFrame } from "./frame.mjs";
import { buildRarefiedFrame, PoolsUnavailableError } from "./rarefiedFrame.mjs";
import { fitR2 } from "./fit.mjs";
import { armCoefficientName, contrastVector, evaluateContrast } from "./contrasts.mjs";
import { distinctK } from "../metrics/clustering.mjs";

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

const THRESHOLD = 0.5; // one-hot vectors: cosine distance is exactly 0 or 1
const CATEGORY_COUNT = 50;
const N_A = 30; // Arm A shape (maxRounds: 1)
const N_PANEL = 60; // panel-arm shape (maxRounds: 2)
const CONFIG = { harnessVersion: "0.0.1", engineSha: "abc", promptHash: "p1", clusterDistanceThreshold: THRESHOLD };
const CFG = configHash(CONFIG);
const BRIEFS = ["b1", "b2", "b3", "b4"]; // >= 3 briefs so fitR2's clusters (4) > params (2)

/**
 * Populate a store with A vs P cells whose pools are drawn from the SAME
 * generative process (uniform over CATEGORY_COUNT categories) at DIFFERENT
 * sizes (30 vs 60, matching Arm A vs a panel arm's registered pool-size
 * asymmetry, docs/PREREGISTRATION.md Appendix C item 1) — there is no real
 * model effect here, only the pool-size confound rarefaction exists to
 * remove.
 */
function seedStore() {
  const store = makeTempStore();
  let seed = 10000;
  for (const briefId of BRIEFS) {
    for (const [armId, n] of [["A", N_A], ["P", N_PANEL]]) {
      const pool = makeCategoricalPool(CATEGORY_COUNT, n, seed++);
      const key = cellKey({ armId, briefId, replicate: 0, cfg: CFG });
      store.put({
        key,
        armId,
        briefId,
        replicate: 0,
        cfg: CFG,
        resolvedModels: { proposer: "claude-haiku-4-5" },
        costRows: [],
        result: { distinct_k: distinctK(pool, THRESHOLD), pool },
        accounting: { state: "completed" },
      });
    }
  }
  return store;
}

function h1Estimate(rows) {
  const fit = fitR2(rows, ["A", "P"], "A");
  assert.equal(fit.converged, true, "fitR2 must converge on this well-behaved balanced fixture");
  const c = contrastVector(fit.coefficientNames, { [armCoefficientName("P", "A")]: 1 });
  return evaluateContrast(fit, c);
}

test("KEY: the pipeline's H1 contrast is insensitive to a pool-size difference the un-rarefied pipeline IS sensitive to", () => {
  const store = seedStore();

  const fullFrame = buildFrame(store, { config: CONFIG, poolField: "pool" });
  assert.equal(fullFrame.rows.length, BRIEFS.length * 2);

  // ── Un-rarefied (full-pool) pipeline: sensitive to the confound ──────────
  const fullRows = fullFrame.rows.map((r) => ({ armId: r.armId, briefId: r.briefId, response: r.response }));
  const fullResult = h1Estimate(fullRows);

  // ── Rarefied pipeline (issue #73's wiring): must remove the confound ────
  const rarefiedFrame = buildRarefiedFrame(fullFrame, {
    armIds: ["A", "P"],
    threshold: THRESHOLD,
    rarefyOpts: { r: 500 }, // registered seed default; smaller r keeps CI fast
  });
  const rarefiedRows = rarefiedFrame.rows.map((r) => ({ armId: r.armId, briefId: r.briefId, response: r.response }));
  const rarefiedResult = h1Estimate(rarefiedRows);

  // The un-rarefied estimate must show a real, large gap driven by pool size
  // alone (expected distinct categories at n=30 vs n=60 draws over 50
  // categories: ~22.7 vs ~35.1 — see rarefaction.test.mjs's identical
  // reasoning for this fixture).
  assert.ok(
    fullResult.estimate >= 8,
    `expected the un-rarefied pipeline's H1 estimate to show the pool-size confound (got ${fullResult.estimate}) -- ` +
      "if this fails, the fixture isn't constructing the confound this test exists to catch",
  );

  // The rarefied estimate must be small — close to zero, since there is no
  // real per-category-draw model effect in this fixture, only pool size.
  assert.ok(
    Math.abs(rarefiedResult.estimate) <= 4,
    `expected the rarefied pipeline's H1 estimate to be near zero once the pool-size confound is removed (got ${rarefiedResult.estimate})`,
  );

  // And it must have actually MOVED away from the un-rarefied estimate --
  // otherwise rarefaction did nothing in this pipeline and the two asserts
  // above passed by coincidence, not because the wiring works.
  assert.ok(
    fullResult.estimate - rarefiedResult.estimate >= 5,
    `rarefaction should pull the pipeline's H1 estimate down substantially (full=${fullResult.estimate}, rarefied=${rarefiedResult.estimate})`,
  );
});

test("MUTATION CHECK: a store with no pools at all refuses to produce a rarefied H1 -- never silently substitutes the full-pool contrast", () => {
  const store = makeTempStore();
  for (const briefId of BRIEFS) {
    for (const [armId, n] of [["A", N_A], ["P", N_PANEL]]) {
      const pool = makeCategoricalPool(CATEGORY_COUNT, n, 1);
      const key = cellKey({ armId, briefId, replicate: 0, cfg: CFG });
      store.put({
        key,
        armId,
        briefId,
        replicate: 0,
        cfg: CFG,
        resolvedModels: { proposer: "claude-haiku-4-5" },
        costRows: [],
        result: { distinct_k: distinctK(pool, THRESHOLD) }, // no `pool` field — pre-#8 shape
        accounting: { state: "completed" },
      });
    }
  }
  // poolField requested, but no cell in the store carries one -- the
  // registered pipeline path when generation predates #8 (Phase 2a).
  const frame = buildFrame(store, { config: CONFIG, poolField: "pool" });
  assert.throws(
    () => buildRarefiedFrame(frame, { armIds: ["A", "P"], threshold: THRESHOLD }),
    PoolsUnavailableError,
    "a caller must never fall back to evaluating H1 against the full-pool frame when pools are unavailable",
  );
});
