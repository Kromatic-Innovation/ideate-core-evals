// voyage-calibration.test.mjs — hermetic tests for the committed Voyage
// calibration record. Never calls the live embedder (that only happens in
// ./calibrate-voyage.mjs, opt-in) — this only checks that the COMMITTED
// JSON record is internally consistent and matches the pair set it claims
// to have been computed from.
import { test } from "node:test";
import assert from "node:assert/strict";

import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD, VOYAGE_CALIBRATION_RECORD } from "./voyage-calibration.mjs";
import { pairSetHash } from "./threshold-selection.mjs";
import { CALIBRATION_PAIRS, CALIBRATION_PAIR_COUNT } from "./fixtures/calibration-pairs.mjs";

test("VOYAGE_CLUSTER_DISTANCE_THRESHOLD loads from the committed record without a network call", () => {
  assert.ok(Number.isFinite(VOYAGE_CLUSTER_DISTANCE_THRESHOLD));
  assert.ok(
    VOYAGE_CLUSTER_DISTANCE_THRESHOLD > 0 && VOYAGE_CLUSTER_DISTANCE_THRESHOLD < 1.5,
    `threshold ${VOYAGE_CLUSTER_DISTANCE_THRESHOLD} is outside a sane cosine-distance range`,
  );
});

test("the committed record's pairSetHash matches the CURRENT calibration-pairs.mjs content", () => {
  // If this ever fails, calibration-pairs.mjs was edited without re-running
  // calibrate-voyage.mjs --write -- the durable record and the pair set it
  // claims to summarize have drifted apart. Same invariant control-texts.mjs
  // documents (and explicitly does NOT enforce) for embeddings.json; this
  // record DOES enforce it, per issue #42's request to register the pair-set
  // hash alongside the threshold.
  assert.equal(VOYAGE_CALIBRATION_RECORD.pairSetHash, pairSetHash(CALIBRATION_PAIRS));
  assert.equal(VOYAGE_CALIBRATION_RECORD.pairSetSize, CALIBRATION_PAIR_COUNT);
});

test("the committed record states its embedder id, selection rule, and provenance", () => {
  assert.equal(VOYAGE_CALIBRATION_RECORD.embedderId, "voyage-4-lite");
  assert.equal(typeof VOYAGE_CALIBRATION_RECORD.selectionRule, "string");
  assert.ok(VOYAGE_CALIBRATION_RECORD.selectionRule.length > 0);
  assert.equal(VOYAGE_CALIBRATION_RECORD.pairSetProvenance.labelledBy, "model");
});

test("the committed record's achieved balanced accuracy is a valid probability", () => {
  const ba = VOYAGE_CALIBRATION_RECORD.achievedBalancedAccuracy;
  assert.ok(ba > 0 && ba <= 1, `expected achievedBalancedAccuracy in (0, 1], got ${ba}`);
});

test("the committed record demonstrates the MiniLM threshold does not transfer to realistic pairs", () => {
  // This is the headline empirical finding issue #42 exists to establish:
  // the MiniLM-derived number performs far worse than the Voyage-selected
  // one on the SAME realistic (hard-negative) Voyage-embedded pair set.
  const { balancedAccuracy: miniLmBA } = VOYAGE_CALIBRATION_RECORD.miniLmThresholdOnThisSet;
  const selectedBA = VOYAGE_CALIBRATION_RECORD.achievedBalancedAccuracy;
  assert.ok(
    miniLmBA < selectedBA,
    `expected the MiniLM threshold's balanced accuracy (${miniLmBA}) to be worse than the selected ` +
      `Voyage threshold's (${selectedBA}) on this realistic set`,
  );
});
