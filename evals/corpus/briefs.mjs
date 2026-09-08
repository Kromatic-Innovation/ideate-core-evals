// briefs.mjs — the 48 frozen briefs, stratified per §3.2 of the pre-registration.
//
// ── Corpus expansion (issue #43, 2026-09-01) ────────────────────────────────
// Expanded 12 -> 24 briefs (4/3/3/2 -> 6/6/6/6 per stratum) while the
// pre-registration window was still open (no study data collected). See
// docs/PREREGISTRATION.md §3.2 and issue #43 for the rationale; the dated
// amendment disclosing this (including the authored-briefs conflict of
// interest) lands separately in Appendix B per issue #44.
//
// ── Anchor + second expansion (issue #129 parts D/E, 2026-09-08) ───────────
// Two ADDITIVE changes, bundled into one amendment per §3.2/§11 (adding a
// brief invalidates the pre-registration, so batching avoids invalidating it
// twice):
//   D. Meincke et al.'s "Base Prompt" is registered as an externally-
//      published comparability anchor — `prod-07`, provenance "verbatim" —
//      see ANCHOR_SOURCE below. It lives IN the `product` stratum, not a
//      separate fifth stratum: folding it in is what gives `product` an
//      external anchor at all (a first draft of this amendment used a
//      standalone `anchor` stratum; corrected 2026-09-08 per coordinator
//      review, see below).
//   E. 24 more briefs (24 -> 48), keeping strict 12/12/12/12 parity across
//      business/product/scientific/aut rather than weighting the corpus
//      toward one stratum. scientific 6 -> 12 (+6, sampled from
//      LiveIdeaBench — see sample.mjs), aut 6 -> 12 (+6, more canonical
//      Alternate-Uses-Task objects), product 6 -> 12 (+6, including the
//      anchor brief above), business 6 -> 12 (+6, authored — no external
//      instrument exists for this stratum; disclosed, not hidden, in the
//      comment above biz-07..12 below).
//
//   ── Why parity, not weighting toward scientific (corrected 2026-09-08) ──
//   A first draft of this amendment weighted scientific to 23 briefs (48%
//   of the corpus) on the theory that "weight toward externally-traceable
//   sources" meant maximizing external-brief COUNT. That was wrong: §3.2
//   states the corpus is "stratified so results generalize across task
//   type, not just one domain," and §6.2's model
//   (`distinct_k ~ arm + (1 | brief) + (1 | brief:arm)`) treats briefs as
//   exchangeable random effects — so an unequal split doesn't just look
//   lopsided, it lets the brief-level variance (and the headline effect
//   estimate) be dominated by whichever stratum has the most briefs, quietly
//   turning a cross-domain generalization claim into a within-scientific
//   one. "Weight toward externally-traceable sources" is satisfied instead
//   by which strata GAIN an anchor (scientific, aut-paradigm, and now
//   product via the Meincke brief — 3 of 4, up from 1 of 4), not by breaking
//   parity. business remains the one stratum with no external anchor, and
//   that absence is disclosed rather than papered over.
//
// The original 24 briefs (biz-01..06, prod-01..06, sci-01..06, aut-01..06)
// are retained byte-identical — same id, same text, same content hash — so
// the pre-amendment corpus (hash `55e05c2811a7`) remains reconstructible by
// filtering to that id set. See corpus.test.mjs "the retained 24 briefs..."
// and index.mjs's `PRE_AMENDMENT_BRIEF_IDS` / `preAmendmentCorpusHash`.
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

// ── The canonical comparability anchor (issue #129 part D) ──────────────────
// Full source record for prod-07 below (the product-stratum verbatim brief).
// Kept as a named constant (rather than inlined in the brief) so the
// citation/caveats are one grep away and so corpus.test.mjs can assert
// against it directly instead of re-deriving strings.
//
// Citations — #129's own citation text is WRONG (drops Meincke as an author
// of the 2023 paper) and must not be copied from the issue body:
//   Girotra, K., Meincke, L., Terwiesch, C., & Ulrich, K. T. (2023). Ideas
//   Are Dimes A Dozen: Large Language Models For Idea Generation In
//   Innovation. Mack Institute working paper, July 10 2023. SSRN 4526071.
//   DOI 10.2139/ssrn.4526071. Four authors — the issue text omits Meincke.
//
//   Meincke, L., Mollick, E., & Terwiesch, C. (2024). Prompting Diverse
//   Ideas: Increasing AI Idea Variance. arXiv:2402.01727v1.
//   DOI 10.48550/arXiv.2402.01727.
export const ANCHOR_SOURCE = {
  label: "Base Prompt",
  citation:
    "Girotra, K., Meincke, L., Terwiesch, C., & Ulrich, K. T. (2023). Ideas Are Dimes A " +
    "Dozen: Large Language Models For Idea Generation In Innovation. Mack Institute working " +
    "paper, July 10 2023. SSRN 4526071. DOI 10.2139/ssrn.4526071.",
  secondaryCitation:
    "Meincke, L., Mollick, E., & Terwiesch, C. (2024). Prompting Diverse Ideas: Increasing " +
    "AI Idea Variance. arXiv:2402.01727v1. DOI 10.48550/arXiv.2402.01727.",
  // Verified against the retrieved PDF text at transcription time (2026-09-08):
  // the "Base Prompt" is reproduced inline on p.12 (the "Exhaustion" section,
  // introducing the exhaustion-comparison prompts) AND again in Appendix D
  // ("Table of Prompts", pp. 20-33; the Base Prompt row itself falls on p.24),
  // Meincke, Mollick & Terwiesch (2024) working paper. Both reproductions are
  // byte-identical.
  location:
    "Reproduced inline on p.12 (\"Exhaustion\" section) and in Appendix D (\"Table of " +
    "Prompts\", pp. 20-33, Base Prompt row on p.24) of Meincke, Mollick & Terwiesch (2024).",
  // Girotra et al. (2023) is the paper that originated this exact task
  // (target market + price ceiling framing); Meincke et al. (2024) is where
  // the verbatim prompt text above was transcribed FROM, reusing Girotra et
  // al.'s task as their own "Base Prompt" baseline strategy.
  retrievedFrom:
    "https://mackinstitute.wharton.upenn.edu/wp-content/uploads/2023/08/LLM-Ideas-Working-Paper.pdf " +
    "(Girotra et al. 2023 Mack Institute working paper; retrieved 2026-09-08).",
  versionRisk:
    "SSRN 4526071 has since been revised (retitled, with an expanded author list) and " +
    "returned HTTP 403 as of 2026-09-08, so the CURRENT SSRN version's prompt text is " +
    "unverified. The prompt text registered here is transcribed from the July 2023 Mack " +
    "Institute working paper PDF at the URL above, not from SSRN.",
  // Published cosine-similarity results (Google Universal Sentence Encoder
  // embeddings), Table 2 of Meincke et al. (2024) — reproduced for reference
  // only; see comparabilityCaveat below for why these are NOT comparable to
  // this study's own numbers.
  publishedResults: {
    metric: "cosine similarity (Google Universal Sentence Encoder embeddings)",
    basePrompt: 0.377,
    chainOfThought: 0.255,
    groupOfStudents: 0.243,
  },
  comparabilityCaveat:
    "Cosine values are NOT portable. Meincke et al. used Google's Universal Sentence " +
    "Encoder; this study uses Voyage. The paper itself warns (p.6): \"changing the " +
    "embeddings model could yield dramatically different results depending on the " +
    "training even if it was optimized for the same purpose.\" So Meincke's published " +
    "numbers above are NOT comparable to this study's values — only the ORDERING of " +
    "strategies may transfer, not the magnitudes.",
  humanPromptCaveat:
    "The human-subject prompt is not available verbatim. Girotra et al. (2023) state " +
    "only that they prompted ChatGPT-4 with \"essentially the same prompt we gave the " +
    "students\" — the authors' characterization, not a transcript. Nothing in this " +
    "corpus implies a verbatim human-comparable instrument.",
};

/**
 * @typedef {object} Brief
 * @property {string} id
 * @property {"business"|"product"|"scientific"|"aut"} stratum
 * @property {string} text
 * @property {"authored"|"sampled"|"verbatim"} provenance
 * @property {object} [selection]  required when provenance === "sampled":
 *                                 { algorithm, seed, drawIndex, source }
 * @property {object} [source]     required when provenance === "verbatim":
 *                                 full citation/location/caveat record (see ANCHOR_SOURCE)
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

  // ── Business expansion (6 more, authored, #129 amendment) ─────────────────
  // DISCLOSURE: business is the one stratum in this corpus with NO external
  // anchor. Unlike scientific (LiveIdeaBench), aut (the Guilford/Torrance
  // Alternate-Uses-Task paradigm), and product (the Meincke/Girotra Base
  // Prompt, prod-07 below), no published instrument covers generic
  // business/go-to-market ideation in a form usable here. Rather than
  // inventing a citation for one, this is stated plainly: biz-01..12 are
  // ALL authored, all secondary evidence, and this stratum's results cannot
  // be checked against any prior published number. Honest disclosure beats
  // a fabricated anchor.
  {
    id: "biz-07",
    stratum: "business",
    provenance: "authored",
    text:
      "A company wants to raise its prices but is worried about losing customers. " +
      "Generate as many genuinely different ways to do this as you can.",
  },
  {
    id: "biz-08",
    stratum: "business",
    provenance: "authored",
    text:
      "A company has one product and is deciding whether to build a second one. " +
      "Generate as many genuinely different ways to decide as you can.",
  },
  {
    id: "biz-09",
    stratum: "business",
    provenance: "authored",
    text:
      "A company's sales team and product team disagree about what customers actually " +
      "need. Generate as many genuinely different ways to resolve this as you can.",
  },
  {
    id: "biz-10",
    stratum: "business",
    provenance: "authored",
    text:
      "A company relies on a single large customer for most of its revenue. Generate " +
      "as many genuinely different ways to reduce this risk as you can.",
  },
  {
    id: "biz-11",
    stratum: "business",
    provenance: "authored",
    text:
      "A company must decide whether to build a new capability itself or buy it from " +
      "someone else. Generate as many genuinely different ways to decide as you can.",
  },
  {
    id: "biz-12",
    stratum: "business",
    provenance: "authored",
    text:
      "A company's team has doubled in size in the last year and its old ways of " +
      "working no longer fit. Generate as many genuinely different ways to adapt as " +
      "you can.",
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

  // ── Product expansion (6 more, #129 amendment part D/E) ────────────────────
  // prod-07 is the canonical comparability anchor: Meincke, Mollick &
  // Terwiesch (2024) "Base Prompt", transcribed VERBATIM — do not reword.
  // See ANCHOR_SOURCE above for the full citation, location, and
  // comparability caveats; this is the point of the brief, not boilerplate.
  // It is placed in `product` (not a standalone stratum) because that is
  // what gives the product stratum an externally-traceable anchor, per
  // coordinator correction 2026-09-08 — see the file header.
  {
    id: "prod-07",
    stratum: "product",
    provenance: "verbatim",
    text:
      "Generate new product ideas with the following requirements: The product will " +
      "target college students in the United States. It should be a physical good, " +
      "not a service or software. I'd like a product that could be sold at a retail " +
      "price of less than about USD 50. The ideas are just ideas. The product need " +
      "not yet exist, nor may it necessarily be clearly feasible. Number all ideas " +
      "and give them a name. The name and idea are separated by a colon. Please " +
      "generate 100 ideas as 100 separate paragraphs. The idea should be expressed " +
      "as a paragraph of 40-80 words.",
    source: ANCHOR_SOURCE,
  },
  {
    id: "prod-08",
    stratum: "product",
    provenance: "authored",
    text:
      "A product team is deciding what to remove, not add, before its next release. " +
      "Generate as many genuinely different ways to decide what to cut as you can.",
  },
  {
    id: "prod-09",
    stratum: "product",
    provenance: "authored",
    text:
      "A product's setup process takes users longer than the team would like. Generate " +
      "as many genuinely different ways to shorten it as you can.",
  },
  {
    id: "prod-10",
    stratum: "product",
    provenance: "authored",
    text:
      "A product needs to support a second language for the first time. Generate as " +
      "many genuinely different ways to approach this as you can.",
  },
  {
    id: "prod-11",
    stratum: "product",
    provenance: "authored",
    text:
      "A product's power users want more control while new users want less complexity. " +
      "Generate as many genuinely different ways to serve both as you can.",
  },
  {
    id: "prod-12",
    stratum: "product",
    provenance: "authored",
    text:
      "A product has one feature that breaks more often than any other. Generate as " +
      "many genuinely different ways to address this as you can.",
  },

  // ── Scientific (6, sampled from LiveIdeaBench) ────────────────────────────
  // Each brief wraps one sampled keyword in a fixed, minimal template so the
  // ONLY varying content across this stratum's briefs is the keyword itself —
  // matching LiveIdeaBench's own single-keyword prompt design (§2 of the
  // pre-registration: "1,180 single-keyword prompts").
  ...SCIENTIFIC_KEYWORDS.map((keyword, i) => ({
    // Zero-padded to 2 digits (not `sci-0${i + 1}`, which breaks past i=8 —
    // e.g. would emit "sci-010" for the 10th draw instead of "sci-10"). The
    // first 6 ids (sci-01..sci-06) render identically to the pre-expansion
    // template, so existing ids/hashes are unaffected; see index.mjs.
    id: `sci-${String(i + 1).padStart(2, "0")}`,
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

  // ── AUT expansion (6 more, authored, #129 amendment) ──────────────────────
  // Same "genuinely different uses for X" template as aut-01..06 above,
  // extended with 6 more objects from the standard Alternate Uses Task /
  // divergent-thinking stimulus set used across the Guilford (1967) and
  // Torrance Tests of Creative Thinking literature — the object choice is
  // externally traceable to that paradigm even though (like aut-01..06) the
  // exact sentence wrapping the object is authored, not quoted from a paper.
  {
    id: "aut-07",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a newspaper as you can.",
  },
  {
    id: "aut-08",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a key as you can.",
  },
  {
    id: "aut-09",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a shoe as you can.",
  },
  {
    id: "aut-10",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for an umbrella as you can.",
  },
  {
    id: "aut-11",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a tin can as you can.",
  },
  {
    id: "aut-12",
    stratum: "aut",
    provenance: "authored",
    text: "Generate as many genuinely different uses for a blanket as you can.",
  },
];
