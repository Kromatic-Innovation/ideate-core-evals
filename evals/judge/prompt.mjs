// prompt.mjs — the frozen, content-hashed judge rubric (issue #4, AC1/AC2).
//
// ── Why the rubric wording is not ours to invent ────────────────────────────
// docs/PREREGISTRATION.md §4.3/§5 and the issue body are explicit: the judge
// rubric reuses LiveIdeaBench's PUBLISHED 4-axis rubric (originality /
// feasibility / fluency / flexibility — arXiv 2412.17596, Nature
// Communications; see evals/corpus/liveideabench-keywords.mjs for this
// study's other LiveIdeaBench borrowing) rather than a rubric we write
// ourselves. Reusing a peer-reviewed rubric beats inventing a new one: it
// means our judge's axis definitions are traceable to a citable source, and
// it is the same axis vocabulary evals/corpus and docs/PREREGISTRATION.md
// §4.3's metrics table already commit to ("Fluency / Flexibility: LiveIdeaBench
// axes").
//
// ── Novelty and feasibility are NEVER averaged (§4.3, §5, the issue's own AC) ──
// docs/PREREGISTRATION.md §4.3: "Novelty (judged, 1-5) — Split-axis per
// Rietzschel et al. 2010 — *never* averaged with feasibility into a single
// 'best' [score]." §5 repeats it: "Not collapse novelty and feasibility into
// one score." This is a load-bearing methodological decision, not a style
// preference — an idea can be highly novel and wildly infeasible (or safely
// feasible and utterly derivative), and averaging those into one scalar
// destroys exactly the signal H1-H5 need to distinguish. So this module:
//   (a) keeps JUDGE_AXES as four SEPARATE named axes, never a composite;
//   (b) exports `assertAxesNotCollapsed`, a runtime guard any caller handling
//       judge output MUST run before storing/reporting a score, so a future
//       refactor that "helpfully" averages the axes into `overallScore` fails
//       loud instead of silently reintroducing the exact anti-pattern this
//       rubric exists to prevent.
//
// ── Why the prompt is frozen AND hashed ─────────────────────────────────────
// `lib/manifest.mjs`'s CONFIG_FIELDS already reserves `judgeHash` as a
// comparability-relevant field (see manifest.mjs's header + CONFIG_FIELDS
// list) — nothing currently supplies it. This module is what supplies it:
// `judgePromptHash()` hashes the frozen prompt text the exact same way
// `evals/corpus/index.mjs`'s corpusHash hashes the frozen brief corpus (sha256,
// 12 hex chars) so that editing the rubric wording is caught by the SAME
// mechanism that already protects engineSha/promptHash/corpusHash: cells
// computed under the old rubric get a DIFFERENT cellKey, are never silently
// pooled with cells computed under the new one, and are surfaced as `stale`
// by `planRun` instead. Freezing the prompt object itself (Object.freeze,
// deep) makes "the rubric wording changed but nobody updated judgeHash"
// impossible to do BY ACCIDENT in this process — a mutation attempt throws in
// strict mode (ESM modules are always strict) rather than silently drifting
// out of sync with judgePromptHash()'s snapshot.

import { createHash } from "node:crypto";

/** The four LiveIdeaBench axes, in the paper's published order. Frozen: this
 *  array is referenced by `assertAxesNotCollapsed` and by any judge-payload
 *  assembly code, so an accidental in-place `.push`/`.sort` mutation would be
 *  a silent, hard-to-trace scoring bug. Object.freeze on an array of strings
 *  is enough (strings are already immutable); the array container itself is
 *  what we're guarding. */
export const JUDGE_AXES = Object.freeze(["originality", "feasibility", "fluency", "flexibility"]);

/**
 * Deep-freeze helper — recursively applies Object.freeze so no nested object
 * or array inside JUDGE_PROMPT can be mutated either. Plain `Object.freeze`
 * is shallow: it would still let `JUDGE_PROMPT.axes.originality = "x"`
 * through. That's exactly the kind of drift `judgePromptHash()`'s snapshot
 * would silently miss (the frozen top-level object looks intact; a nested
 * field quietly changed underneath it), so every level is frozen.
 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ── The rubric text ──────────────────────────────────────────────────────────
// Axis definitions are the standard one-line LiveIdeaBench glosses (arXiv
// 2412.17596 §3.2 "Evaluation Metrics"): originality (novelty/uncommonness of
// the idea), feasibility (practical realizability), fluency (validity/
// relevance of the response to the prompt), flexibility (breadth/diversity of
// conceptual categories touched). Each axis is scored independently on the
// paper's 1-10 scale; nothing here computes or requests a composite.
export const JUDGE_PROMPT = deepFreeze({
  version: "liveideabench-4axis-v1",
  instructions:
    "You are scoring a single candidate idea against a fixed research brief. " +
    "Score the idea on EACH of the four axes below, independently, on a 1-10 " +
    "scale. Do NOT compute or report any combined/overall/average score — " +
    "report each axis separately. In particular, originality (novelty) and " +
    "feasibility measure different, often-opposed properties of an idea and " +
    "must never be blended into a single number.",
  axes: {
    originality: {
      label: "Originality",
      definition:
        "The novelty and uncommonness of the idea relative to established or " +
        "obvious approaches to the brief — does it depart meaningfully from " +
        "conventional thinking, rather than restating a well-known solution.",
    },
    feasibility: {
      label: "Feasibility",
      definition:
        "The practical realizability of the idea — whether it could plausibly " +
        "be implemented or pursued with realistic resources, methods, and " +
        "constraints, independent of how novel it is.",
    },
    fluency: {
      label: "Fluency",
      definition:
        "The validity and relevance of the response to the prompt — whether " +
        "the idea is a coherent, on-topic, substantive answer to the brief " +
        "rather than an empty, malformed, or off-topic reply.",
    },
    flexibility: {
      label: "Flexibility",
      definition:
        "The breadth of conceptually distinct categories or approaches the " +
        "idea (in the context of the pool it was drawn from) touches on, " +
        "rather than repeating the same underlying approach in different words.",
    },
  },
  outputFormat:
    "Return a JSON object with exactly the keys originality, feasibility, " +
    "fluency, flexibility, each mapping to a number in [1, 10]. No other keys.",
});

/**
 * sha256(canonical JUDGE_PROMPT serialization), truncated to 12 hex chars —
 * same convention as `configHash` (lib/manifest.mjs) and `corpusHash`
 * (evals/corpus/index.mjs). Sorted keys so the hash is insensitive to
 * property insertion order (matching manifest.mjs's own canonicalization
 * discipline), sensitive to any actual wording change.
 *
 * This value is what a caller supplies as `judgeHash` into the config object
 * passed to `configHash()` — see prompt.test.mjs's AC2 test for the
 * end-to-end proof that a one-character rubric edit changes both
 * `configHash` and `cellKey`.
 */
export function judgePromptHash(promptObject = JUDGE_PROMPT) {
  return createHash("sha256").update(canonicalStringify(promptObject)).digest("hex").slice(0, 12);
}

function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

/**
 * Guard against the exact failure mode §4.3/§5 forbid: a caller collapsing
 * novelty (originality) and feasibility into one averaged/composite number.
 * Throws unless BOTH axes are present as distinct, separately-readable
 * numeric fields on `scores`. This is intentionally strict about *shape*
 * (are the two axes distinguishable fields at all) rather than trying to
 * detect "were these two numbers derived by averaging" after the fact —
 * the latter is not generally detectable from the output alone, so the gate
 * has to be upstream: never let a caller construct a scores object that
 * lacks the two axes as separate fields in the first place.
 *
 * @param {*} scores  the judge's per-candidate score object
 */
export function assertAxesNotCollapsed(scores) {
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    throw new Error(
      "assertAxesNotCollapsed: scores must be an object with distinct per-axis fields — " +
        `got ${JSON.stringify(scores)}. A single averaged scalar (e.g. an "overallScore" number) ` +
        "is exactly the novelty/feasibility collapse docs/PREREGISTRATION.md §4.3 and §5 forbid.",
    );
  }
  if (typeof scores.originality !== "number" || typeof scores.feasibility !== "number") {
    throw new Error(
      "assertAxesNotCollapsed: scores.originality and scores.feasibility must both be present as " +
        "distinct numeric fields — novelty (originality) and feasibility must never be averaged " +
        "into one number (docs/PREREGISTRATION.md §4.3, §5).",
    );
  }
  if (scores.originality === scores.feasibility && "overallScore" in scores) {
    // Not a reliable general detector (two axes CAN legitimately tie in
    // value), but a composite field showing up alongside the two axes is
    // itself evidence of the anti-pattern this function exists to catch —
    // fail loud rather than silently accept a scores object that carries
    // both the correct separate axes AND a forbidden collapsed one.
    throw new Error(
      "assertAxesNotCollapsed: scores carries an 'overallScore' field alongside distinct axes — " +
        "an averaged/composite score must never be attached, even in addition to the separate axes.",
    );
  }
  for (const axis of JUDGE_AXES) {
    if (typeof scores[axis] !== "number") {
      throw new Error(`assertAxesNotCollapsed: missing numeric axis '${axis}' — all four JUDGE_AXES must be present and distinct`);
    }
  }
}
