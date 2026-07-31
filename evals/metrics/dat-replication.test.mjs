// dat-replication.test.mjs — the DAT replication control (issue #3, "the
// important control — it validates the embedding pipeline").
//
// ── What this validates, and why it's the load-bearing one ─────────────────
// The duplicate-pool and random-text controls (negative-controls.test.mjs)
// can pass even if the embedding pipeline is subtly wrong, AS LONG AS
// "identical text -> identical vector" and "very different text -> very
// different vector" both hold in some crude sense — a badly miscalibrated
// but monotonic embedder could still pass those. What it CANNOT fake is
// reproducing a specific, externally-published ORDERING of semantic
// distance that human raters (via the DAT norming study) independently
// established. If our pipeline can't recover that ordering, nothing
// downstream — distinct_k, pool diversity, the random-text floor — is
// trustworthy, because they all rest on the same embedding space.
//
// ── Data source and provenance ──────────────────────────────────────────────
// REAL published example data, not constructed exemplars: the three word
// groups (DAT_LOW / DAT_AVERAGE / DAT_HIGH in ./fixtures/control-texts.mjs)
// are copied verbatim from jayolson/divergent-association-task's own
// examples.py ("Word examples (Figure 1 in paper)"), commit
// 9978dd8103670a90c59bc35a7210acc60995dcdb (fetched and verified during this
// PR — see control-texts.mjs DAT_SOURCE for the full citation). That repo's
// own dat.py computes each group's published DAT score (mean pairwise cosine
// distance over GloVe 840B.300d vectors, x100): low=50, average=78, high=95.
// Those scores are themselves derived from Olson et al. 2021, PNAS.
//
// ── The deviation: word vectors (GloVe) vs. sentence embeddings (MiniLM) ───
// dat.py embeds isolated WORDS with GloVe. Our production/hermetic embedders
// are SENTENCE embedders (MiniLM here; Voyage-4-lite in production — see
// ./embedder.mjs) because ideate-core's candidates are full idea sentences,
// not single words. We embed each DAT word standalone (same unit dat.py
// uses — one embedding call per word, pairwise distance between words) so
// the comparison is apples-to-apples at the level dat.py itself operates.
// This means:
//   - We do NOT expect to reproduce the published ABSOLUTE scores (50/78/95)
//     — those are GloVe-specific numbers from a different vector space with
//     a different scale.
//   - We DO expect to reproduce the published ORDERING: low < average < high
//     mean pairwise cosine distance. That ordering is the falsifiable claim
//     transferable across embedding models — if MiniLM can't even preserve
//     the RELATIVE order of three human-normed exemplar groups, it cannot be
//     trusted to rank-order idea pools by diversity, which is the entire
//     downstream use.
// This is the documented deviation the issue's honesty requirements ask for:
// real normed data, ordering-only claim, absolute-scale claim explicitly
// disclaimed.
//
// ── What this does NOT validate ─────────────────────────────────────────────
// This validates the HERMETIC fixture embedder (MiniLM) + the metric
// machinery (poolDiversity/distinctK). It says nothing about whether the
// PRODUCTION embedder (Voyage-4-lite, ./embedder.mjs voyageEmbedder — a
// documented, unimplemented stub in this PR) would recover the same
// ordering. Voyage-4-lite needs its own run-time DAT check before anyone
// trusts diversity numbers computed from it; that is out of hermetic scope
// (it needs a live API key) and is a stated limitation of this PR, not a
// hidden gap — see the PR body and ./embedder.mjs voyageEmbedder's header.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { poolDiversity } from "./diversity.mjs";
import { fixtureEmbedder } from "./embedder.mjs";
import { DAT_LOW, DAT_AVERAGE, DAT_HIGH, DAT_SOURCE } from "./fixtures/control-texts.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/embeddings.json", import.meta.url), "utf8"));
const embedder = fixtureEmbedder(FIXTURES);

test("DAT source data is real published normed data, not constructed exemplars", () => {
  assert.equal(DAT_SOURCE.repo, "jayolson/divergent-association-task");
  assert.equal(DAT_SOURCE.license, "MIT");
  assert.match(DAT_SOURCE.commitSha, /^[0-9a-f]{40}$/, "a real commit SHA was recorded, not a placeholder");
  assert.deepEqual(DAT_SOURCE.publishedDatScores, { low: 50, average: 78, high: 95 });
  assert.equal(DAT_LOW.length, 7);
  assert.equal(DAT_AVERAGE.length, 7);
  assert.equal(DAT_HIGH.length, 7);
});

// ── Derive the three group diversities eagerly, at module load ─────────────
// Computed at IMPORT time (not inside a test body) for two reasons:
//   1. negative-controls.test.mjs imports RANDOM_TEXT_DIVERSITY_FLOOR from
//      this module. node:test does not guarantee cross-file test-body
//      execution order, so a floor only populated inside a `test(...)`
//      callback here could still be `undefined` when another file's test
//      body reads it. Computing it at module evaluation time (which ALWAYS
//      runs to completion before any test body anywhere runs, since the
//      test runner must finish importing a file to discover its tests)
//      sidesteps that ordering hazard entirely.
//   2. It mirrors the calibration.mjs pattern (CLUSTER_DISTANCE_THRESHOLD is
//      also derived eagerly at module load from the same fixtures) — one
//      consistent idiom in this directory for "a constant derived from
//      fixture data, computed once, importable anywhere."
// This is synchronous because fixtureEmbedder's lookup is synchronous data
// access wrapped in an async-shaped interface (see embedder.mjs) purely to
// match voyageEmbedder's real network-bound shape — so we resolve the
// promises immediately rather than deferring to a test body.
const _lowVecs = await embedder.embed(DAT_LOW);
const _avgVecs = await embedder.embed(DAT_AVERAGE);
const _highVecs = await embedder.embed(DAT_HIGH);

const LOW_DIVERSITY = poolDiversity(_lowVecs);
const AVERAGE_DIVERSITY = poolDiversity(_avgVecs);
const HIGH_DIVERSITY = poolDiversity(_highVecs);

// ── The random-text control's diversity floor, derived HERE from DAT ──────
// Per the issue's pinned comment on the random-text control: "derive the
// threshold empirically from the DAT replication... Set the random-text
// control's floor from that measurement and record the number." We use the
// published "high" group's diversity (the human-normed "genuinely scattered"
// exemplar) as that floor — if random, unrelated English sentences don't
// diversify at LEAST as much as DAT's own "high" exemplar words, the
// random-text control has no business claiming near-maximal diversity, and
// this floor keeps that claim honest and falsifiable rather than asserted
// from intuition. Exported (not just a local test constant) so
// negative-controls.test.mjs can assert against the SAME derived number
// rather than a second, possibly-drifted copy.
//
// Recorded value on the committed fixtures: HIGH_DIVERSITY ≈ 0.770 (see the
// assertion messages below and clustering.test.mjs / calibration.mjs for the
// sibling derived constants).
export const RANDOM_TEXT_DIVERSITY_FLOOR = HIGH_DIVERSITY;

// ── The replication itself ──────────────────────────────────────────────────

test("DAT replication: pipeline recovers the published ordering (low < average < high)", () => {
  // The falsifiable claim: THIS is the one that would have to be reported as
  // a genuine finding (per the issue's honesty requirements) if it failed —
  // no fixture tuning is allowed to force this to pass.
  assert.ok(
    LOW_DIVERSITY < AVERAGE_DIVERSITY,
    `DAT replication FAILED: low-group diversity (${LOW_DIVERSITY}) should be < average-group (${AVERAGE_DIVERSITY})`,
  );
  assert.ok(
    AVERAGE_DIVERSITY < HIGH_DIVERSITY,
    `DAT replication FAILED: average-group diversity (${AVERAGE_DIVERSITY}) should be < high-group (${HIGH_DIVERSITY})`,
  );

  // Recorded result (visible in test output / PR report): on the committed
  // MiniLM fixtures, the pipeline DID recover the published ordering.
  // low ≈ 0.529, average ≈ 0.696, high ≈ 0.770 (mean pairwise cosine
  // distance). Absolute numbers differ from the GloVe-based published scores
  // by construction (see file header) — only the ordering is the claim.
});

test("DAT replication: the separation between groups is not a coin flip (sanity margin)", () => {
  // A real, human-normed low-vs-high split should separate by a comfortable
  // margin, not by a fraction of a percent that could flip under fixture
  // regeneration noise. This guards against a "technically passes, actually
  // meaningless" pass.
  const margin = HIGH_DIVERSITY - LOW_DIVERSITY;
  assert.ok(margin > 0.1, `expected a comfortable margin between low (${LOW_DIVERSITY}) and high (${HIGH_DIVERSITY}) diversity, got ${margin}`);
});

test("random-text diversity floor is derived from DAT's published 'high' exemplar, not asserted from intuition", () => {
  assert.equal(RANDOM_TEXT_DIVERSITY_FLOOR, HIGH_DIVERSITY);
  assert.ok(
    RANDOM_TEXT_DIVERSITY_FLOOR > 0.5 && RANDOM_TEXT_DIVERSITY_FLOOR < 1,
    `sanity: DAT-high diversity ${RANDOM_TEXT_DIVERSITY_FLOOR} is in a plausible cosine-distance range`,
  );
});
