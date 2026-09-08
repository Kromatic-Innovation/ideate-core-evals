// index.mjs — the frozen, content-hashed 48-brief stratified corpus (issues #2, #43, #129).
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
// Deliberately equal (12 each) — §3.2/§6.2 treat briefs as an exchangeable
// random effect, so an unequal split would let one stratum dominate the
// brief-level variance and quietly narrow the cross-domain generalization
// claim to whichever stratum has the most briefs. See briefs.mjs header for
// the corrected rationale (coordinator review, 2026-09-08).
const EXPECTED_STRATUM_COUNTS = { business: 12, product: 12, scientific: 12, aut: 12 };

// The 24 brief ids frozen BEFORE the #129 amendment (issue #43 corpus, hash
// `55e05c2811a7`, disclosed in docs/PREREGISTRATION.md Appendix B item 13).
// Used to reconstruct and re-hash the pre-amendment corpus from the current
// (additive) one, so the earlier registration stays independently checkable
// forever — not just "we say we didn't touch them."
export const PRE_AMENDMENT_BRIEF_IDS = [
  "biz-01", "biz-02", "biz-03", "biz-04", "biz-05", "biz-06",
  "prod-01", "prod-02", "prod-03", "prod-04", "prod-05", "prod-06",
  "sci-01", "sci-02", "sci-03", "sci-04", "sci-05", "sci-06",
  "aut-01", "aut-02", "aut-03", "aut-04", "aut-05", "aut-06",
];

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
 * to: exactly 24 briefs, the 6/6/6/6 stratum split, provenance + source
 * present where required. Throws with a specific message on the first
 * violation rather than returning a boolean — a malformed corpus should be
 * loud, since a silently-short corpus would quietly narrow the study.
 *
 * @param {Array} corpus
 */
export function validateCorpus(corpus) {
  if (!Array.isArray(corpus) || corpus.length !== 48) {
    throw new Error(`validateCorpus: expected exactly 48 briefs, got ${corpus?.length ?? "non-array"}`);
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

    if (!["authored", "sampled", "verbatim"].includes(brief.provenance)) {
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
    if (brief.provenance === "verbatim") {
      if (!brief.source || typeof brief.source.citation !== "string") {
        throw new Error(`validateCorpus: verbatim brief '${brief.id}' is missing source.citation`);
      }
      if (typeof brief.source.location !== "string") {
        throw new Error(`validateCorpus: verbatim brief '${brief.id}' is missing source.location (page/appendix)`);
      }
      if (typeof brief.source.comparabilityCaveat !== "string") {
        throw new Error(`validateCorpus: verbatim brief '${brief.id}' is missing source.comparabilityCaveat`);
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

/**
 * Reconstructs and hashes the pre-#129-amendment corpus (the 24 briefs
 * frozen at issue #43, hash `55e05c2811a7`) from within the CURRENT
 * (additive) corpus, by filtering to `PRE_AMENDMENT_BRIEF_IDS`. Because the
 * amendment is required to be additive-only — existing briefs unchanged,
 * only appended to — this must always equal the previously-registered
 * `55e05c2811a7`, and corpus.test.mjs checks that directly rather than
 * trusting the constant.
 *
 * @param {Array} corpus
 * @returns {string} 12-hex-char sha256, same convention as corpusHash
 */
export function preAmendmentCorpusHash(corpus) {
  const subset = corpus.filter((b) => PRE_AMENDMENT_BRIEF_IDS.includes(b.id));
  if (subset.length !== PRE_AMENDMENT_BRIEF_IDS.length) {
    throw new Error(
      `preAmendmentCorpusHash: expected ${PRE_AMENDMENT_BRIEF_IDS.length} pre-amendment briefs, found ${subset.length}`,
    );
  }
  return corpusHash(subset);
}
