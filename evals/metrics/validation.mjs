// validation.mjs — the DAT replication and negative-control LOGIC, extracted
// so it can run against ANY embedder (the hermetic fixture lookup OR the live
// Voyage-4-lite client) instead of being hardwired to the fixture embedder
// the way dat-replication.test.mjs / negative-controls.test.mjs originally
// were.
//
// ── Why this file exists ────────────────────────────────────────────────────
// Issue #20's AC3/AC4 ask for the DAT replication and negative controls to
// "run against the live embedder" and "report ordering pass/fail honestly."
// The ORIGINAL control logic (dat-replication.test.mjs, negative-
// controls.test.mjs) is correct and load-bearing, but it is written as
// `node:test` assertions against a module-level `fixtureEmbedder` instance —
// there is no live-network path in `node --test` (see the repo's #1
// invariant: hermetic CI, zero deps installed). Rather than duplicate the
// clustering/diversity math in a second implementation for the live path
// (which would risk the two silently drifting), this module extracts the
// SAME computation as two plain async functions parameterized on `embedder`,
// so:
//   - the hermetic tests here (validation.test.mjs) call them with
//     fixtureEmbedder(FIXTURES) and assert the exact same properties
//     dat-replication.test.mjs / negative-controls.test.mjs already assert,
//   - ./live-validation.mjs (opt-in, never imported by a test) calls the
//     exact same functions with a real voyageEmbedder, so the live run is
//     provably the same check, not a hand-rolled approximation of it.
//
// This module is PURE: no network, no top-level dependency beyond the other
// metrics modules and the frozen control texts. It never calls fetch itself
// — it only calls `embedder.embed(...)`, so whether a run is hermetic or live
// is entirely determined by which embedder the CALLER passes in.

import { poolDiversity, collapseRate } from "./diversity.mjs";
import { distinctK } from "./clustering.mjs";
import { CLUSTER_DISTANCE_THRESHOLD } from "./calibration.mjs";
import { DAT_LOW, DAT_AVERAGE, DAT_HIGH, DUPLICATE_POOL, RANDOM_TEXT_POOL } from "./fixtures/control-texts.mjs";

/**
 * DAT replication (docs/PREREGISTRATION.md §4.4): embed the three published,
 * human-normed DAT word groups (DAT_LOW/DAT_AVERAGE/DAT_HIGH — real data from
 * jayolson/divergent-association-task, see fixtures/control-texts.mjs and
 * dat-replication.test.mjs's header for full provenance/deviation writeup)
 * and check that this embedder's pool-diversity ordering matches the
 * published ordering (low < average < high). This is an ORDERING-only claim
 * — absolute diversity scores are embedder-specific (GloVe-word-vector scores
 * from the source paper are not expected to reproduce numerically under any
 * sentence embedder, MiniLM or Voyage-4-lite alike) — see
 * dat-replication.test.mjs for the full reasoning, reused verbatim here.
 *
 * @param {{ embed: (texts: string[]) => Promise<number[][]> }} embedder
 * @returns {Promise<{ low: number, average: number, high: number, orderingHolds: boolean, margin: number }>}
 */
export async function datReplication(embedder) {
  const [lowVecs, avgVecs, highVecs] = await Promise.all([
    embedder.embed(DAT_LOW),
    embedder.embed(DAT_AVERAGE),
    embedder.embed(DAT_HIGH),
  ]);

  const low = poolDiversity(lowVecs);
  const average = poolDiversity(avgVecs);
  const high = poolDiversity(highVecs);

  return {
    low,
    average,
    high,
    // The falsifiable claim — computed honestly, never forced. A caller
    // (live-validation.mjs) that gets `orderingHolds: false` back MUST report
    // that as a failure, per the issue's "never worked around" requirement.
    orderingHolds: low < average && average < high,
    margin: high - low,
  };
}

/**
 * Negative controls (docs/PREREGISTRATION.md §4.4): a duplicate pool (30
 * copies of one idea sentence) should collapse to distinct_k=1 / diversity≈0,
 * and a random/unrelated-sentence pool should stay close to distinct_k≈30
 * with high diversity. Reuses the SAME frozen texts (DUPLICATE_POOL,
 * RANDOM_TEXT_POOL from fixtures/control-texts.mjs) as
 * negative-controls.test.mjs so the hermetic test of this function and any
 * live run are checking the identical inputs, not a second hand-picked set —
 * per this issue's own guidance, any text fed to fixtureEmbedder in a
 * hermetic test must already be in the committed fixture map, and these
 * already are (see control-texts.mjs ALL_FIXTURE_TEXTS).
 *
 * Uses CLUSTER_DISTANCE_THRESHOLD (./calibration.mjs) — the same
 * data-derived threshold every other distinct_k computation in this repo
 * uses — so a live-embedder run and the hermetic fixture run are clustering
 * under a consistent, non-arbitrary rule (not re-tuned per embedder).
 *
 * @param {{ embed: (texts: string[]) => Promise<number[][]> }} embedder
 * @returns {Promise<{
 *   duplicate: { distinctK: number, diversity: number, collapseRate: number },
 *   random: { distinctK: number, diversity: number, collapseRate: number },
 * }>}
 */
export async function negativeControls(embedder) {
  const [dupVecs, randVecs] = await Promise.all([embedder.embed(DUPLICATE_POOL), embedder.embed(RANDOM_TEXT_POOL)]);

  const dupK = distinctK(dupVecs, CLUSTER_DISTANCE_THRESHOLD);
  const randK = distinctK(randVecs, CLUSTER_DISTANCE_THRESHOLD);

  return {
    duplicate: {
      distinctK: dupK,
      diversity: poolDiversity(dupVecs),
      collapseRate: collapseRate(dupK, DUPLICATE_POOL.length),
    },
    random: {
      distinctK: randK,
      diversity: poolDiversity(randVecs),
      collapseRate: collapseRate(randK, RANDOM_TEXT_POOL.length),
    },
  };
}
