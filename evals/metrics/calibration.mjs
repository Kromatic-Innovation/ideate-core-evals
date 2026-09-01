// calibration.mjs — derives CLUSTER_DISTANCE_THRESHOLD from the committed
// fixtures rather than hardcoding a literal. Read this before touching the
// number in clustering.mjs; it is NOT a knob tuned to make tests pass.
//
// ── The derivation ──────────────────────────────────────────────────────────
// clusterByThreshold (./clustering.mjs) needs one number: "how close do two
// embedded texts have to be before we call them the same idea?" That number
// has to come from data, not intuition — an untethered constant would be
// exactly the kind of "rigged to pass" artifact the issue warns against.
//
// We derive it from two small calibration populations in
// ./fixtures/control-texts.mjs, embedded with Xenova/all-MiniLM-L6-v2 (via
// ../regen-fixtures.mjs) — the HERMETIC fixture embedder every test in this
// directory uses. This is NOT the production embedder (Voyage-4-lite, see
// ./embedder.mjs voyageEmbedder) — cosine-distance distributions do not
// transfer across embedding models (issue #42). The constant this module
// exports (CLUSTER_DISTANCE_THRESHOLD) is valid ONLY for MiniLM-embedded
// vectors (i.e. the hermetic fixtureEmbedder). Production code must use
// VOYAGE_CLUSTER_DISTANCE_THRESHOLD (./voyage-calibration.mjs) instead — see
// that module and ./calibrate-voyage.mjs for the Voyage-space derivation:
//   PARAPHRASE_PAIRS      — 4 pairs, same idea reworded. These SHOULD cluster
//                            together; their pairwise cosine distance is the
//                            "definitely one idea" population.
//   DISTINCT_IDEA_PAIRS   — 4 pairs, genuinely different ideas, same register
//                            and length as the paraphrases (so the comparison
//                            isn't confounded by sentence length/topic-vs-
//                            style). These SHOULD NOT cluster; their distance
//                            is the "definitely two ideas" population.
//
// On the committed fixtures (see the numbers recorded in
// clustering.test.mjs "threshold derivation is data-driven, not hardcoded"):
//   max(paraphrase distances)    ≈ 0.242
//   min(distinct-idea distances) ≈ 0.743
// A wide, clean gap — no overlap between the two populations at all. The
// threshold is the MIDPOINT of that gap: equidistant from "closest two
// distinct ideas got" and "farthest two paraphrases got," which is the
// natural decision boundary a linear separator would pick, and leaves
// maximum margin on both sides against fixture-set noise.
//
// This midpoint is computed HERE, from the fixture data, at module load —
// not copy-pasted as a literal — so if the fixtures are regenerated (e.g. a
// future embedding model swap via regen-fixtures.mjs), the threshold moves
// with them automatically instead of silently going stale.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cosineDistance } from "./clustering.mjs";
import { PARAPHRASE_PAIRS, DISTINCT_IDEA_PAIRS } from "./fixtures/control-texts.mjs";

const EMBEDDINGS_PATH = fileURLToPath(new URL("./fixtures/embeddings.json", import.meta.url));

/**
 * Recompute the paraphrase/distinct-idea distance populations and the
 * midpoint threshold from a given fixtures payload. Exported (not just used
 * internally) so tests can assert on the intermediate populations, not just
 * trust the final number — see clustering.test.mjs.
 *
 * @param {object} fixtures  parsed embeddings.json payload
 */
export function deriveClusterThreshold(fixtures) {
  const V = fixtures.vectors;
  const paraphraseDistances = PARAPHRASE_PAIRS.map(([a, b]) => cosineDistance(V[a], V[b]));
  const distinctDistances = DISTINCT_IDEA_PAIRS.map(([a, b]) => cosineDistance(V[a], V[b]));
  const maxParaphrase = Math.max(...paraphraseDistances);
  const minDistinct = Math.min(...distinctDistances);
  if (maxParaphrase >= minDistinct) {
    // If the two populations ever overlapped, a midpoint threshold would be
    // meaningless (there'd be no clean decision boundary). Fail loudly rather
    // than silently picking a threshold that misclassifies part of either
    // population — this is the honesty requirement from the issue applied to
    // the calibration step itself.
    throw new Error(
      `deriveClusterThreshold: paraphrase and distinct-idea distance populations overlap ` +
        `(max paraphrase=${maxParaphrase}, min distinct=${minDistinct}) — no clean threshold exists ` +
        "on these fixtures; the calibration set or the embedding model needs revisiting.",
    );
  }
  return {
    threshold: (maxParaphrase + minDistinct) / 2,
    paraphraseDistances,
    distinctDistances,
    maxParaphrase,
    minDistinct,
  };
}

const _fixtures = JSON.parse(readFileSync(EMBEDDINGS_PATH, "utf8"));
const _derived = deriveClusterThreshold(_fixtures);

/**
 * The empirically-derived clustering distance threshold, computed once at
 * module load from the committed fixtures. See derivation above.
 * On the current fixtures this is ≈ 0.49 (max paraphrase ≈0.24, min distinct
 * ≈0.74 — see clustering.test.mjs for the exact recorded numbers).
 */
export const CLUSTER_DISTANCE_THRESHOLD = _derived.threshold;

// Exposed for tests/diagnostics that want the intermediate populations
// without recomputing them (e.g. to print/record the exact numbers in a PR
// description) without re-deriving from scratch.
export const CLUSTER_THRESHOLD_DERIVATION = _derived;
