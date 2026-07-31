// clustering.test.mjs — hermetic tests for cosine distance, agglomerative
// clustering, and distinct_k. Reads only the committed fixture JSON (via
// fixtureEmbedder); never imports @huggingface/transformers or touches the
// network — see regen-fixtures.mjs header for why that separation matters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cosineDistance, pairwiseDistanceMatrix, clusterByThreshold, distinctK } from "./clustering.mjs";
import { CLUSTER_DISTANCE_THRESHOLD, CLUSTER_THRESHOLD_DERIVATION } from "./calibration.mjs";
import { fixtureEmbedder } from "./embedder.mjs";
import { DUPLICATE_POOL, RANDOM_TEXT_POOL } from "./fixtures/control-texts.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/embeddings.json", import.meta.url), "utf8"));
const embedder = fixtureEmbedder(FIXTURES);

// ── cosineDistance ───────────────────────────────────────────────────────

test("cosineDistance of a vector with itself is 0", () => {
  const v = [0.6, 0.8, 0];
  assert.ok(Math.abs(cosineDistance(v, v)) < 1e-12);
});

test("cosineDistance of orthogonal unit vectors is 1", () => {
  assert.ok(Math.abs(cosineDistance([1, 0], [0, 1]) - 1) < 1e-12);
});

test("cosineDistance of opposite unit vectors is 2", () => {
  assert.ok(Math.abs(cosineDistance([1, 0], [-1, 0]) - 2) < 1e-12);
});

test("cosineDistance rejects mismatched lengths and zero vectors", () => {
  assert.throws(() => cosineDistance([1, 0], [1, 0, 0]), /equal-length/);
  assert.throws(() => cosineDistance([0, 0], [1, 0]), /zero-magnitude/);
});

// ── pairwiseDistanceMatrix ───────────────────────────────────────────────

test("pairwiseDistanceMatrix is symmetric with a zero diagonal", () => {
  const D = pairwiseDistanceMatrix([[1, 0], [0, 1], [1, 1]]);
  for (let i = 0; i < 3; i++) assert.equal(D[i][i], 0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.equal(D[i][j], D[j][i]);
});

// ── clusterByThreshold ───────────────────────────────────────────────────

test("threshold 0 never merges anything (every point its own cluster)", () => {
  const { k } = clusterByThreshold([[1, 0], [0.99, 0.01], [0, 1]], 0);
  assert.equal(k, 3);
});

test("a very large threshold merges everything into one cluster", () => {
  const { k } = clusterByThreshold([[1, 0], [0, 1], [-1, 0]], 10);
  assert.equal(k, 1);
});

test("clusterByThreshold rejects empty input and a negative threshold", () => {
  assert.throws(() => clusterByThreshold([], 0.5), /non-empty/);
  assert.throws(() => clusterByThreshold([[1, 0]], -0.1), /non-negative/);
});

test("a single-vector pool is trivially one cluster", () => {
  const { k, assignments } = clusterByThreshold([[1, 0, 0]], 0.5);
  assert.equal(k, 1);
  assert.deepEqual(assignments, [0]);
});

// ── Threshold derivation is data-driven, not hardcoded (AC: distinct_k must
//    be justified, not tuned to pass) ─────────────────────────────────────

test("threshold derivation is data-driven, not hardcoded", () => {
  // Records the actual empirically-derived numbers so a reviewer (or a
  // future re-run after regen-fixtures.mjs changes the fixtures) can see
  // exactly what separated the two calibration populations, rather than
  // trusting an opaque constant. See calibration.mjs header for the full
  // derivation writeup.
  const { maxParaphrase, minDistinct, threshold } = CLUSTER_THRESHOLD_DERIVATION;
  assert.ok(maxParaphrase < minDistinct, "paraphrase and distinct-idea populations must not overlap");
  assert.ok(threshold > maxParaphrase && threshold < minDistinct, "threshold sits strictly between the two populations");
  assert.equal(threshold, (maxParaphrase + minDistinct) / 2, "threshold is exactly the midpoint, not an adjusted/rounded value");
  assert.equal(CLUSTER_DISTANCE_THRESHOLD, threshold, "the exported constant matches the derivation record");
  // Loosely bound the numbers so a wildly different embedding swap
  // (e.g. a broken regen) fails this test rather than silently sailing
  // through with a degenerate threshold.
  assert.ok(threshold > 0.05 && threshold < 1.5, `threshold ${threshold} is outside a sane cosine-distance range`);
});

// ── distinct_k on the negative-control pools (see negative-controls.test.mjs
//    for the full acceptance-criteria-mapped versions of these) ────────────

test("distinct_k of a duplicate pool is exactly 1 using the derived threshold", async () => {
  const vecs = await embedder.embed(DUPLICATE_POOL);
  assert.equal(distinctK(vecs, CLUSTER_DISTANCE_THRESHOLD), 1);
});

test("distinct_k of the random-text pool is close to the raw pool size using the derived threshold", async () => {
  const vecs = await embedder.embed(RANDOM_TEXT_POOL);
  const k = distinctK(vecs, CLUSTER_DISTANCE_THRESHOLD);
  // Not asserting exact equality to 30 — some topically adjacent sentences
  // (e.g. two weather-ish or two archaeology-ish items) may legitimately
  // merge under a threshold calibrated on PARAPHRASE vs DISTINCT-IDEA pairs.
  // "close to" is the honest claim; see negative-controls.test.mjs for the
  // precise recorded bound.
  assert.ok(k >= RANDOM_TEXT_POOL.length - 3, `expected most of ${RANDOM_TEXT_POOL.length} texts to stay separate, got distinct_k=${k}`);
});
