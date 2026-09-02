// validation.test.mjs — hermetic tests for ./validation.mjs's shared
// datReplication/negativeControls functions, run against the committed
// fixture embedder. These assert the SAME properties dat-replication.test.mjs
// and negative-controls.test.mjs already assert directly against
// fixtureEmbedder — the point here is to prove the EXTRACTED, embedder-
// agnostic functions (the same ones the opt-in live validation CLI, in this
// same directory, calls against a live embedder — that CLI is never
// imported here or by any test) reproduce those properties, not to
// duplicate their reasoning. See validation.mjs's header for why this
// extraction exists.
//
// Also covers issue #20 AC2 ("distinct_k, pool diversity, and collapse rate
// compute end-to-end on a real pool") with a dedicated test below that
// exercises all three functions in sequence over one embedded pool, the way
// a real caller (e.g. a future metrics-run) would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fixtureEmbedder } from "./embedder.mjs";
import { datReplication, negativeControls, randomPoolVerdict, duplicatePoolVerdict, DUPLICATE_DIVERSITY_MAX } from "./validation.mjs";
import { distinctK } from "./clustering.mjs";
import { poolDiversity, collapseRate } from "./diversity.mjs";
import { CLUSTER_DISTANCE_THRESHOLD } from "./calibration.mjs";
import { RANDOM_TEXT_POOL } from "./fixtures/control-texts.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/embeddings.json", import.meta.url), "utf8"));

test("datReplication: ordering holds on the committed fixture embedder (low < average < high)", async () => {
  const embedder = fixtureEmbedder(FIXTURES);
  const result = await datReplication(embedder);
  assert.equal(result.orderingHolds, true, `expected orderingHolds true, got low=${result.low} average=${result.average} high=${result.high}`);
  assert.ok(result.low < result.average);
  assert.ok(result.average < result.high);
  assert.ok(result.margin > 0.1, `expected a comfortable margin, got ${result.margin}`);
});

test("negativeControls: duplicate pool collapses to distinctK=1 / diversity 0 on the fixture embedder", async () => {
  const embedder = fixtureEmbedder(FIXTURES);
  const { duplicate } = await negativeControls(embedder);
  assert.equal(duplicate.distinctK, 1);
  assert.equal(duplicate.diversity, 0);
  assert.equal(duplicate.collapseRate, 1 - 1 / 30);
});

test("negativeControls: random pool stays close to distinctK=30 with near-max diversity on the fixture embedder", async () => {
  const embedder = fixtureEmbedder(FIXTURES);
  const { random } = await negativeControls(embedder);
  assert.ok(random.distinctK >= 27, `expected distinctK >= 27 of 30, got ${random.distinctK}`);
  assert.ok(random.collapseRate <= 0.1, `expected low collapse rate, got ${random.collapseRate}`);
  assert.ok(random.diversity > 0.5, `expected high diversity, got ${random.diversity}`);
});

// ── AC2: distinct_k, pool diversity, and collapse rate compute end-to-end on a real pool ──

test("distinctK, poolDiversity, and collapseRate compute end-to-end over one embedded pool", async () => {
  const embedder = fixtureEmbedder(FIXTURES);
  const vecs = await embedder.embed(RANDOM_TEXT_POOL);

  const k = distinctK(vecs, CLUSTER_DISTANCE_THRESHOLD);
  const diversity = poolDiversity(vecs);
  const rate = collapseRate(k, RANDOM_TEXT_POOL.length);

  assert.ok(Number.isInteger(k) && k > 0 && k <= RANDOM_TEXT_POOL.length);
  assert.ok(Number.isFinite(diversity) && diversity >= 0);
  assert.ok(rate >= 0 && rate <= 1);
  // collapseRate must be defined purely in terms of the SAME k this call
  // computed — recomputing it independently here would defeat the point
  // (see diversity.mjs collapseRate's header on why it takes k as a plain
  // number rather than re-clustering).
  assert.equal(rate, 1 - k / RANDOM_TEXT_POOL.length);
});

// ── randomPoolVerdict (evals/24 sentry thread on live-validation.mjs:108) ──
// The random-pool check asserts two independent halves; these are pure
// unit tests over the verdict function itself, no embedder/network involved.

test("randomPoolVerdict: ordering holds and diversity clears the floor -> both halves pass", () => {
  const v = randomPoolVerdict({ distinctK: 28, diversity: 0.75, poolSize: 30, datHigh: 0.6, orderingHolds: true });
  assert.equal(v.distinctKPass, true);
  assert.equal(v.floorVerdict, "pass");
  assert.equal(v.failed, false);
});

test("randomPoolVerdict: ordering holds but diversity is below the floor -> floor half fails and sets failed", () => {
  const v = randomPoolVerdict({ distinctK: 28, diversity: 0.5, poolSize: 30, datHigh: 0.6, orderingHolds: true });
  assert.equal(v.distinctKPass, true);
  assert.equal(v.floorVerdict, "fail");
  assert.equal(v.failed, true);
});

test("randomPoolVerdict: ordering broken -> floor is inconclusive regardless of diversity, and does not set failed on its own (diversity below the broken floor)", () => {
  const v = randomPoolVerdict({ distinctK: 28, diversity: 0.4, poolSize: 30, datHigh: 0.6, orderingHolds: false });
  assert.equal(v.distinctKPass, true);
  assert.equal(v.floorVerdict, "inconclusive");
  assert.equal(v.failed, false);
});

test("randomPoolVerdict: ordering broken -> floor is inconclusive even when diversity is ABOVE the broken floor", () => {
  const v = randomPoolVerdict({ distinctK: 28, diversity: 0.9, poolSize: 30, datHigh: 0.6, orderingHolds: false });
  assert.equal(v.distinctKPass, true);
  assert.equal(v.floorVerdict, "inconclusive");
  assert.equal(v.failed, false);
});

test("randomPoolVerdict: distinct_k below the 90% bound fails regardless of the floor verdict", () => {
  const v = randomPoolVerdict({ distinctK: 25, diversity: 0.9, poolSize: 30, datHigh: 0.6, orderingHolds: true });
  assert.equal(v.distinctKPass, false); // Math.ceil(30 * 0.9) = 27, 25 < 27
  assert.equal(v.floorVerdict, "pass");
  assert.equal(v.failed, true);
});

// ── duplicatePoolVerdict (extracted from evals/metrics/phase0.mjs / the
// now-deleted live-validation.mjs, PR #69 fix round) ──────────────────────
// Both conjuncts (distinct_k === 1 AND diversity < DUPLICATE_DIVERSITY_MAX)
// are pinned INDEPENDENTLY -- a prior version of this rule was duplicated,
// unpinned, and only ever exercised with distinctK far from 1 (so the
// diversity bound was never actually reached by any test).

test("duplicatePoolVerdict: distinct_k=1 and diversity well under the bound -> passes", () => {
  const v = duplicatePoolVerdict({ distinctK: 1, diversity: 0 });
  assert.equal(v.distinctKPass, true);
  assert.equal(v.diversityPass, true);
  assert.equal(v.passed, true);
});

test("duplicatePoolVerdict: distinct_k=1 but diversity at or above DUPLICATE_DIVERSITY_MAX -> fails on the diversity conjunct alone", () => {
  const v = duplicatePoolVerdict({ distinctK: 1, diversity: DUPLICATE_DIVERSITY_MAX });
  assert.equal(v.distinctKPass, true);
  assert.equal(v.diversityPass, false, "the bound is strict (<), so diversity exactly AT the max must fail");
  assert.equal(v.passed, false);
});

test("duplicatePoolVerdict: distinct_k != 1 but diversity near zero -> fails on the distinct_k conjunct alone", () => {
  const v = duplicatePoolVerdict({ distinctK: 2, diversity: 0.001 });
  assert.equal(v.distinctKPass, false);
  assert.equal(v.diversityPass, true);
  assert.equal(v.passed, false);
});

test("duplicatePoolVerdict: both conjuncts fail -> passed is false", () => {
  const v = duplicatePoolVerdict({ distinctK: 5, diversity: 0.5 });
  assert.equal(v.distinctKPass, false);
  assert.equal(v.diversityPass, false);
  assert.equal(v.passed, false);
});
