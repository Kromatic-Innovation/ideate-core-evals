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
import { datReplication, negativeControls } from "./validation.mjs";
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
