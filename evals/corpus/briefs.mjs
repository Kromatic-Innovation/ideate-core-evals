// briefs.mjs — the 24 frozen briefs, stratified per §3.2 of the pre-registration.
//
// ── Corpus expansion (issue #43, 2026-09-01) ────────────────────────────────
// Expanded 12 -> 24 briefs (4/3/3/2 -> 6/6/6/6 per stratum) while the
// pre-registration window was still open (no study data collected). See
// docs/PREREGISTRATION.md §3.2 and issue #43 for the rationale; the dated
// amendment disclosing this (including the authored-briefs conflict of
// interest) lands separately in Appendix B per issue #44.
//
// ── Neutrality note (AC4: domain-agnostic, no unfair fit) ──────────────────────
// This corpus feeds EVERY arm's prompt builder identically (§3.3: "same prompt
// builders... across arms"). If a brief's WORDING happened to match the register
// a particular provider's training data favors — heavy startup jargon for one
// model family, academic phrasing for another — that would bias `distinct_k`
// toward whichever model "speaks the brief's dialect" rather than measuring
// ideation diversity. So every authored brief below (business, product, AUT)
// is written to the same plain, generic register:
//   - No brand names, no company names, no framework names (no "Lean Startup",
//     no "Jobs to Be Done", no named methodologies).
//   - No marketing buzzwords ("synergy", "disrupt", "growth hacking", etc.).
//   - One or two sentences: a role-neutral setup + an open-ended ask.
//   - The generic B2B SaaS business brief deliberately does not name an
//     industry, persona, or channel — "a new B2B SaaS product" is the whole
//     specification, forcing every arm to supply its own assumptions rather
///     than pattern-match a training-data-favorite vertical.
// This is a judgment call, not a proof of neutrality — §10 of the
// pre-registration already flags "prompt builders tuned (unintentionally) to
// one provider" as an untested residual threat. Keeping the wording generic is
// the mitigation available at corpus-authoring time; a prompt-variant
// robustness check (also flagged in §10) would be the next line of defense if
// this turns out not to be enough.
//
// ── Content hashing ──────────────────────────────────────────────────────────
// Each brief's `text` is sha256-hashed (hex, truncated to 12 chars — the same
// convention lib/manifest.mjs uses for configHash) via `briefContentHash` in
// ./index.mjs. Truncating to 12 hex chars (48 bits) is the same tradeoff
// manifest.mjs makes: plenty of collision resistance for a set of 12 items,
// short enough to be usable in filenames/logs. The hash is computed over the
// `text` field only (not id/stratum/provenance) so that renaming a brief's id
// doesn't spuriously change its content hash, but editing a single word of the
// text does — see corpus.test.mjs "editing a brief's text changes its content
// hash".

import { LIVEIDEABENCH_KEYWORDS, SOURCE as LIVEIDEABENCH_SOURCE } from "./liveideabench-keywords.mjs";
import {
  sampleKeywords,
  SCIENTIFIC_SAMPLE_SEED,
  SCIENTIFIC_SAMPLE_COUNT,
  SCIENTIFIC_SAMPLE_ALGORITHM,
} from "./sample.mjs";

// The registered draw, reproduced here from the frozen snapshot (not
// hand-copied) so this file and sample.mjs can never drift apart silently —
// if the snapshot or the algorithm ever changed, this line would recompute a
// different list rather than silently keeping a stale, hand-typed one.
const SCIENTIFIC_KEYWORDS = sampleKeywords(
  LIVEIDEABENCH_KEYWORDS,
  SCIENTIFIC_SAMPLE_COUNT,
  SCIENTIFIC_SAMPLE_SEED,
);

// Shared selection-metadata block attached to every sampled brief so the
// procedure is recorded per-brief, not just once at module scope — a brief
// record should be self-describing if it's ever pulled out of this array.
function scientificSelectionMeta(keyword, index) {
  return {
    algorithm: SCIENTIFIC_SAMPLE_ALGORITHM,
    seed: SCIENTIFIC_SAMPLE_SEED,
    drawIndex: index, // position in the ordered draw (0-based), for exact replay
    source: {
      ...LIVEIDEABENCH_SOURCE,
      keyword,
    },
  };
}

/**
 * @typedef {object} Brief
 * @property {string} id
 * @property {"business"|"product"|"scientific"|"aut"} stratum
 * @property {string} text
 * @property {"authored"|"sampled"} provenance
 * @property {object} [source]     required when provenance === "sampled"
 * @property {object} [selection]  required when provenance === "sampled":
 *                                 { algorithm, seed, drawIndex, source }
 */

/** @type {Brief[]} */
export const BRIEFS = [
  // ── Business / go-to-market (6, authored) ─────────────────────────────────
  // The actual use case (§3.2). Kept generic per the neutrality note above.
  {
    id: "biz-01",
    stratum: "business",
    provenance: "authored",
    text:
      "A new B2B SaaS product has zero customers today. Generate as many genuinely " +
      "different ways as you can to reach its first 100 paying customers.",
  },
  {
    id: "biz-02",
    stratum: "business",
    provenance: "authored",
    text:
      "A small team is choosing how to price a new subscription product before " +
      "launch. Generate as many genuinely different pricing approaches as you can.",
  },
  {
    id: "biz-03",
    stratum: "business",
    provenance: "authored",
    text:
      "A growing company wants to expand into a new market but has not chosen which " +
      "one. Generate as many genuinely different ways to decide where to expand next " +
      "as you can.",
  },
  {
    id: "biz-04",
    stratum: "business",
    provenance: "authored",
    text:
      "A company's customers keep cancelling their subscriptions after a few months. " +
      "Generate as many genuinely different explanations and responses to this " +
      "problem as you can.",
  },
  {
    id: "biz-05",
    stratum: "business",
    provenance: "authored",
    text:
      "A company must decide how to structure its sales effort as it grows past its " +
      "first ten customers. Generate as many genuinely different ways to structure " +
      "it as you can.",
  },
  {
    id: "biz-06",
    stratum: "business",
    provenance: "authored",
    text:
      "A company's biggest competitor just cut its price by half. Generate as many " +
      "genuinely different ways to respond as you can.",
  },

  // ── Product / feature ideation (6, authored) ──────────────────────────────
  {
    id: "prod-01",
    stratum: "product",
    provenance: "authored",
    text:
      "A software product's users frequently ask for an undefined 'export' feature. " +
      "Generate as many genuinely different ways to design that feature as you can.",
  },
  {
    id: "prod-02",
    stratum: "product",
    provenance: "authored",
    text:
      "A mobile app wants to help new users understand its core feature within their " +
      "first minute of use. Generate as many genuinely different onboarding designs " +
      "as you can.",
  },
  {
    id: "prod-03",
    stratum: "product",
    provenance: "authored",
    text:
      "A product team has one engineer-week to spend on a single small feature before " +
      "the next release. Generate as many genuinely different candidate features as " +
      "you can.",
  },
  {
    id: "prod-04",
    stratum: "product",
    provenance: "authored",
    text:
      "A product's most-used feature is also its most complained-about. Generate as " +
      "many genuinely different ways to address this as you can.",
  },
  {
    id: "prod-05",
    stratum: "product",
    provenance: "authored",
    text:
      "A team must decide what to build next with little data about what its users " +
      "actually want. Generate as many genuinely different ways to decide as you can.",
  },
  {
    id: "prod-06",
    stratum: "product",
    provenance: "authored",
    text:
      "A product works well on one device type but poorly on another. Generate as " +
      "many genuinely different ways to fix this as you can.",
  },

  // ── Scientific (6, sampled from LiveIdeaBench) ────────────────────────────
  // Each brief wraps one sampled keyword in a fixed, minimal template so the
  // ONLY varying content across this stratum's briefs is the keyword itself —
  // matching LiveIdeaBench's own single-keyword prompt design (§2 of the
  // pre-registration: "1,180 single-keyword prompts").
  ...SCIENTIFIC_KEYWORDS.map((keyword, i) => ({
    id: `sci-0${i + 1}`,
    stratum: "scientific",
    provenance: "sampled",
    text: `Generate as many genuinely different research ideas as you can related to: ${keyword}.`,
    selection: scientificSelectionMeta(keyword, i),
  })),

  // ── Classic divergent-thinking (6, authored, AUT-style) ───────────────────
  // Alternate Uses Task phrasing — the only stratum OCSAI can score (§3.2,
  // §4.2: "OCSAI originality — AUT stratum only").
  {
    id: "aut-01",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a brick as you can.",
  },
  {
    id: "aut-02",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a paperclip as you can.",
  },
  {
    id: "aut-03",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a towel as you can.",
  },
  {
    id: "aut-04",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a rubber band as you can.",
  },
  {
    id: "aut-05",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a cardboard box as you can.",
  },
  {
    id: "aut-06",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a spoon as you can.",
  },
];
