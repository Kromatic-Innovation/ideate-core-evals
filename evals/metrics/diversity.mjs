// diversity.mjs — pool diversity (mean pairwise cosine distance) and collapse
// rate, computed over embeddings (never text — see ./embedder.mjs for why the
// embedding step is kept separate from every metric function).

import { pairwiseDistanceMatrix } from "./clustering.mjs";

/**
 * Pool diversity — the mean pairwise cosine DISTANCE across an embedded pool.
 * This mirrors ideate-core's own `poolDiversity` metric (same definition:
 * mean pairwise distance, not similarity) — we reuse the definition rather
 * than inventing a new one, so a number computed here is directly comparable
 * to what the engine itself reports for the same pool.
 *
 * Range: [0, ~1] in practice for L2-normalized sentence embeddings of natural
 * language (see clustering.mjs cosineDistance for why it can't exceed 2 in
 * general, and DAT_replication for why "unrelated English sentences" cluster
 * well below any theoretical max — this is exactly the "don't assert near
 * max" finding this issue documents).
 *
 * @param {number[][]} vectors  embedded pool, at least 2 members
 * @returns {number} mean pairwise cosine distance
 */
export function poolDiversity(vectors) {
  if (!Array.isArray(vectors) || vectors.length < 2) {
    throw new Error("poolDiversity: needs at least 2 embedded items to compute a pairwise distance");
  }
  const D = pairwiseDistanceMatrix(vectors);
  const n = vectors.length;
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += D[i][j];
      count++;
    }
  }
  return sum / count;
}

/**
 * Collapse rate — `1 − (semantic-dedup survivors ÷ raw candidates)`.
 * "Semantic-dedup survivors" is the pool's distinct_k under the same
 * threshold-clustering as ./clustering.mjs distinctK: one survivor per
 * occupied equivalence class. A collapse rate of 0 means every candidate
 * was semantically distinct; a collapse rate approaching 1 means the pool
 * mode-collapsed onto very few real ideas — direct mode-collapse measure per
 * docs/PREREGISTRATION.md §4.1.
 *
 * Deliberately takes `distinctK` and `rawCount` as plain numbers rather than
 * re-embedding/re-clustering internally — the caller (e.g. the run harness)
 * typically already computed distinct_k for the same pool via
 * ./clustering.mjs, and recomputing it here would violate the same
 * "don't recompute independently" principle the issue applies to operational
 * metrics (see ./operational.mjs): collapse rate and distinct_k must always
 * agree on what "survivor" means, which is guaranteed only if they share one
 * clustering call, not two.
 *
 * @param {number} distinctKCount   number of semantic equivalence classes occupied
 * @param {number} rawCandidateCount  size of the raw (pre-dedup) pool
 * @returns {number} collapse rate in [0, 1]
 */
export function collapseRate(distinctKCount, rawCandidateCount) {
  if (!Number.isFinite(distinctKCount) || distinctKCount < 0) {
    throw new Error("collapseRate: distinctKCount must be a non-negative finite number");
  }
  if (!Number.isInteger(rawCandidateCount) || rawCandidateCount <= 0) {
    throw new Error("collapseRate: rawCandidateCount must be a positive integer");
  }
  if (distinctKCount > rawCandidateCount) {
    throw new Error("collapseRate: distinctKCount cannot exceed rawCandidateCount — survivors are a subset of raw candidates");
  }
  return 1 - distinctKCount / rawCandidateCount;
}
