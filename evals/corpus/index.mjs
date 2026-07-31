// index.mjs — the frozen, content-hashed 12-brief stratified corpus (issue #2).
//
// ── What "frozen" means here ─────────────────────────────────────────────────
// Per docs/PREREGISTRATION.md §3.2 and §11: "Briefs are frozen and hashed into
// the run manifest. Adding a brief mid-study invalidates the pre-registration."
// `lib/manifest.mjs` already implements the mechanism (a `configHash` over
// everything that could change comparability); this module supplies the
// missing ingredient — a hash over the CORPUS itself — so that editing or
// adding a brief is caught by the SAME mechanism the study already trusts for
// engine/prompt/judge changes, rather than needing a separate, easy-to-forget
// check.
//
// ── Two hashes, two purposes ─────────────────────────────────────────────────
//   briefContentHash(brief) — identifies ONE brief's text. Stable across
//     reordering the BRIEFS array or renaming a brief's id; changes the
//     instant the brief's wording changes. Useful for referencing "this exact
//     brief text" in a result row, independent of corpus-level bookkeeping.
//   corpusHash(corpus)      — identifies the WHOLE frozen set. Deterministic
//     over the ORDERED sequence of per-brief content hashes (order is by
//     `id`, not array position, so re-ordering BRIEFS in this file — with no
//     content change — does not change corpusHash; only which briefs exist,
//     and what they say, can). Feeds `configHash` in lib/manifest.mjs — see
//     the CONFIG_FIELDS addition there.
//
// Both use sha256 truncated to 12 hex chars, matching the convention already
// established by `configHash` in lib/manifest.mjs — same collision-resistance
// tradeoff (48 bits is plenty for a set this small), same reason (short
// enough to live in filenames/logs, still effectively unique).

import { createHash } from "node:crypto";
import { BRIEFS } from "./briefs.mjs";

const STRATA = ["business", "product", "scientific", "aut"];
const EXPECTED_STRATUM_COUNTS = { business: 4, product: 3, scientific: 3, aut: 2 };

/** sha256(text), hex, truncated to 12 chars — same convention as configHash. */
export function briefContentHash(brief) {
  if (!brief || typeof brief.text !== "string" || brief.text.length === 0) {
    throw new Error("briefContentHash: brief.text must be a non-empty string");
  }
  return createHash("sha256").update(brief.text).digest("hex").slice(0, 12);
}

/**
 * Deterministic sha256 (12 hex) over the canonicalized, ORDERED set of
 * per-brief content hashes. Ordering by `id` (not array position) means
 * reordering BRIEFS in the source file is a no-op for this hash — only
 * brief CONTENT (or the set of ids present) can move it, which is the
 * property AC2 asks for ("editing or adding a brief MUST change it").
 *
 * @param {Array<{id: string, text: string}>} corpus
 */
export function corpusHash(corpus) {
  if (!Array.isArray(corpus) || corpus.length === 0) {
    throw new Error("corpusHash: corpus must be a non-empty array of briefs");
  }
  const perBrief = corpus
    .map((b) => ({ id: b.id, contentHash: briefContentHash(b) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(perBrief)).digest("hex").slice(0, 12);
}

/**
 * Validate the corpus against the frozen shape the pre-registration commits
 * to: exactly 12 briefs, the 4/3/3/2 stratum split, provenance + source
 * present where required. Throws with a specific message on the first
 * violation rather than returning a boolean — a malformed corpus should be
 * loud, since a silently-short corpus would quietly narrow the study.
 *
 * @param {Array} corpus
 */
export function validateCorpus(corpus) {
  if (!Array.isArray(corpus) || corpus.length !== 12) {
    throw new Error(`validateCorpus: expected exactly 12 briefs, got ${corpus?.length ?? "non-array"}`);
  }

  const ids = new Set();
  const counts = { business: 0, product: 0, scientific: 0, aut: 0 };

  for (const brief of corpus) {
    if (!brief.id || typeof brief.id !== "string") {
      throw new Error("validateCorpus: every brief needs a stable string id");
    }
    if (ids.has(brief.id)) {
      throw new Error(`validateCorpus: duplicate brief id '${brief.id}'`);
    }
    ids.add(brief.id);

    if (!STRATA.includes(brief.stratum)) {
      throw new Error(`validateCorpus: brief '${brief.id}' has unknown stratum '${brief.stratum}'`);
    }
    counts[brief.stratum] += 1;

    if (brief.provenance !== "authored" && brief.provenance !== "sampled") {
      throw new Error(`validateCorpus: brief '${brief.id}' has invalid provenance '${brief.provenance}'`);
    }
    if (brief.provenance === "sampled") {
      if (!brief.selection || !brief.selection.source) {
        throw new Error(`validateCorpus: sampled brief '${brief.id}' is missing selection/source provenance`);
      }
      if (!brief.selection.algorithm || brief.selection.seed === undefined) {
        throw new Error(`validateCorpus: sampled brief '${brief.id}' is missing algorithm/seed metadata`);
      }
    }

    if (typeof brief.text !== "string" || brief.text.trim().length === 0) {
      throw new Error(`validateCorpus: brief '${brief.id}' has empty text`);
    }
  }

  for (const [stratum, expected] of Object.entries(EXPECTED_STRATUM_COUNTS)) {
    if (counts[stratum] !== expected) {
      throw new Error(
        `validateCorpus: stratum '${stratum}' has ${counts[stratum]} briefs, expected ${expected}`,
      );
    }
  }

  return true;
}

// Validate at import time — a corpus that fails its own frozen shape should
// break the build immediately, not surface later as a mysterious stratum
// count mismatch in an analysis script run weeks from now.
validateCorpus(BRIEFS);

export { BRIEFS };
export const CORPUS = BRIEFS;
export const CORPUS_HASH = corpusHash(BRIEFS);
