// negative-controls.test.mjs — the sanity checks that must pass BEFORE the
// metrics they exercise can be trusted (issue #3: "build these first").
//
// Hermetic on purpose: every embedding here comes from the committed fixture
// JSON via fixtureEmbedder (./embedder.mjs), never from a live model call —
// see regen-fixtures.mjs's header for why that separation is what lets these
// controls "gate CI later at zero cost" (AC1).
//
// ── The four controls from the issue, mapped to tests below ────────────────
//   1. Duplicate pool     -> "duplicate pool: distinct_k is exactly 1..."
//   2. Random-text pool   -> "random-text pool: distinct_k is close to..." and
//                             "random-text pool diversity floor is derived..."
//   3. Shuffled-label     -> "metrics are label-blind by construction..."
//   4. DAT replication    -> see ./dat-replication.test.mjs (its own file:
//                             it is the load-bearing validity check for the
//                             whole embedding pipeline, and earns a dedicated
//                             file per the issue's emphasis: "the important
//                             control — it validates the embedding pipeline")
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { distinctK } from "./clustering.mjs";
import { poolDiversity, collapseRate } from "./diversity.mjs";
import { CLUSTER_DISTANCE_THRESHOLD } from "./calibration.mjs";
import { RANDOM_TEXT_DIVERSITY_FLOOR } from "./dat-replication.test.mjs";
import { fixtureEmbedder } from "./embedder.mjs";
import { DUPLICATE_POOL, DUPLICATE_IDEA_TEXT, RANDOM_TEXT_POOL, SHUFFLED_LABEL_CONTROL_SCOPE_NOTE } from "./fixtures/control-texts.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/embeddings.json", import.meta.url), "utf8"));
const embedder = fixtureEmbedder(FIXTURES);

// ── Control 1: duplicate pool ───────────────────────────────────────────────
// "30 copies of one idea -> distinct_k = 1, diversity ≈ 0." Asserted TIGHTLY
// per the issue's pinned comment: identical text embeds identically (exact
// lookup, not merely "very similar"), so both numbers are exact, not
// approximate.

test("duplicate pool: distinct_k is exactly 1 (30 copies of one idea)", async () => {
  assert.equal(DUPLICATE_POOL.length, 30);
  assert.ok(DUPLICATE_POOL.every((t) => t === DUPLICATE_IDEA_TEXT), "sanity: the pool really is 30 copies of the same string");
  const vecs = await embedder.embed(DUPLICATE_POOL);
  assert.equal(distinctK(vecs, CLUSTER_DISTANCE_THRESHOLD), 1);
});

test("duplicate pool: diversity is exactly 0, not merely small", async () => {
  const vecs = await embedder.embed(DUPLICATE_POOL);
  assert.equal(poolDiversity(vecs), 0, "identical text produces identical vectors, so mean pairwise distance is exactly 0");
});

test("duplicate pool: collapse rate is exactly 1 (only 1 of 30 candidates is a distinct survivor)", async () => {
  const vecs = await embedder.embed(DUPLICATE_POOL);
  const k = distinctK(vecs, CLUSTER_DISTANCE_THRESHOLD);
  assert.equal(collapseRate(k, DUPLICATE_POOL.length), 1 - 1 / 30);
});

// ── Control 2: random-text pool ─────────────────────────────────────────────
// "30 unrelated sentences -> distinct_k ≈ 30." For diversity, per the issue's
// pinned comment, we do NOT assert "near max" — we assert the pool's
// diversity clears the empirically-derived floor from the DAT replication
// (../dat-replication.test.mjs), and we record the actual numbers in the
// assertion messages so a failure is self-documenting.

test("random-text pool: distinct_k is close to the raw pool size (30 unrelated sentences)", async () => {
  assert.equal(RANDOM_TEXT_POOL.length, 30);
  assert.equal(new Set(RANDOM_TEXT_POOL).size, 30, "sanity: the 30 sentences really are all distinct strings");
  const vecs = await embedder.embed(RANDOM_TEXT_POOL);
  const k = distinctK(vecs, CLUSTER_DISTANCE_THRESHOLD);
  // "≈ 30" per the issue, not "= 30": a handful of topically-adjacent
  // sentences (e.g. two weather items) may legitimately merge under a
  // threshold calibrated for paraphrase-vs-distinct-idea separation, and
  // that is the metric working correctly, not failing. The bound below is
  // generous (at least 90% stay separate) precisely so this control catches
  // real clustering collapse (the failure mode it exists to catch) without
  // being brittle to a couple of borderline merges.
  assert.ok(k >= 27, `expected distinct_k >= 27 of 30 (>=90% separate), got ${k} — possible clustering collapse`);
});

test("random-text pool: diversity clears the empirically-derived DAT floor (not asserted 'near max')", async () => {
  const vecs = await embedder.embed(RANDOM_TEXT_POOL);
  const diversity = poolDiversity(vecs);
  // RANDOM_TEXT_DIVERSITY_FLOOR is derived in dat-replication.test.mjs from
  // the published DAT "high" word group's mean pairwise distance on THIS
  // embedding model/fixture set — i.e. "what does genuinely-unrelated score
  // in this space," per human-normed data, not a guess. See that file for
  // the derivation and the exact recorded floor value.
  assert.ok(
    diversity >= RANDOM_TEXT_DIVERSITY_FLOOR,
    `random-text pool diversity ${diversity} did not clear the DAT-derived floor ${RANDOM_TEXT_DIVERSITY_FLOOR}`,
  );
});

test("random-text pool: collapse rate is low (most candidates survive as distinct)", async () => {
  const vecs = await embedder.embed(RANDOM_TEXT_POOL);
  const k = distinctK(vecs, CLUSTER_DISTANCE_THRESHOLD);
  const rate = collapseRate(k, RANDOM_TEXT_POOL.length);
  assert.ok(rate <= 0.1, `expected collapse rate <= 0.1 for genuinely unrelated text, got ${rate}`);
});

// ── Duplicate vs. random-text: the controls must clearly separate ─────────
// The two controls exist as a PAIR — if they didn't separate from each other,
// neither number would mean anything on its own.

test("duplicate and random-text controls produce sharply different distinct_k and diversity", async () => {
  const dupVecs = await embedder.embed(DUPLICATE_POOL);
  const randVecs = await embedder.embed(RANDOM_TEXT_POOL);
  const dupK = distinctK(dupVecs, CLUSTER_DISTANCE_THRESHOLD);
  const randK = distinctK(randVecs, CLUSTER_DISTANCE_THRESHOLD);
  assert.ok(randK > dupK * 10, `expected random-text distinct_k (${randK}) to vastly exceed duplicate-pool distinct_k (${dupK})`);
  assert.ok(poolDiversity(randVecs) > poolDiversity(dupVecs) + 0.5, "diversity must clearly separate the two controls");
});

// ── Control 3: shuffled-label control (§4.4) — scoped at the metric level ──
// See fixtures/control-texts.mjs SHUFFLED_LABEL_CONTROL_SCOPE_NOTE for the
// full reasoning: this issue has no judge, so the judge-level control (permute
// arm labels, assert no score difference) cannot be built here without
// faking a pass. What CAN be verified, and is verified below, is that the
// pool-metric functions this issue DOES ship are structurally label-blind:
// they accept only embeddings (or plain counts), never an arm/model/persona
// label, so there is nothing for a label permutation to bias in the first
// place — the metric layer cannot leak a label it never receives.

test("metrics are label-blind by construction (structural analog of the shuffled-label control)", () => {
  // distinctK(vectors, threshold), poolDiversity(vectors),
  // collapseRate(distinctK, rawCount) — inspect arity/signature intent by
  // confirming none of them accept more than the documented positional
  // args, i.e. there is no hidden "label" parameter a caller could even
  // pass. Function.length counts parameters before the first one with a
  // default value; all params here are required, so this is an exact count.
  assert.equal(distinctK.length, 2, "distinctK(vectors, threshold) — no label/id parameter");
  assert.equal(poolDiversity.length, 1, "poolDiversity(vectors) — no label/id parameter");
  assert.equal(collapseRate.length, 2, "collapseRate(distinctK, rawCount) — no label/id parameter");
});

test("permuting the ORDER a pool is presented in does not change distinct_k, diversity, or collapse rate", async () => {
  // This is the closest hermetic analog of "permute arm labels, expect no
  // score difference" available without a judge: relabeling/reordering which
  // position each item is presented in must not change a metric that is
  // properly a function of the SET of embeddings, not their order/labels.
  const vecs = await embedder.embed(RANDOM_TEXT_POOL);
  const shuffled = [...vecs].reverse();
  assert.equal(distinctK(vecs, CLUSTER_DISTANCE_THRESHOLD), distinctK(shuffled, CLUSTER_DISTANCE_THRESHOLD));
  // Floating-point summation order differs between the two passes (reversed
  // iteration accumulates the same pairwise distances in a different order),
  // so an exact equality here would be asserting IEEE-754 addition is
  // commutative in the order it happens to execute, not asserting the
  // metric is order-invariant. Compare within a tight epsilon instead — the
  // property under test is "same set of numbers averaged," not "identical
  // bit pattern."
  assert.ok(
    Math.abs(poolDiversity(vecs) - poolDiversity(shuffled)) < 1e-9,
    "poolDiversity must be order-invariant up to floating-point summation noise",
  );
});

test("the judge-level shuffled-label control is explicitly out of scope, not silently skipped", () => {
  // Fails loudly (rather than being absent) if someone deletes the scope
  // note without replacing it with a real judge-level control — the
  // documented-limitation equivalent of a TODO that can't be silently lost.
  assert.match(SHUFFLED_LABEL_CONTROL_SCOPE_NOTE, /out of scope for issue #3/);
  assert.match(SHUFFLED_LABEL_CONTROL_SCOPE_NOTE, /no judge exists yet/);
});
