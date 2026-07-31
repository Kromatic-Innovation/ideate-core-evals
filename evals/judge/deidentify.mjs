// deidentify.mjs — strip generator identity from a candidate pool before it
// reaches the judge (issue #4, AC3).
//
// ── Why this exists ─────────────────────────────────────────────────────────
// docs/PREREGISTRATION.md §5 ("Score-only, no reasoning-then-score drift") and
// §13 (H5: same-provider judging bias — a judge that can SEE which provider
// or persona produced a candidate could rate it differently for reasons that
// have nothing to do with idea quality). The only way to make H5 testable at
// all is to guarantee the judge never receives arm/model/persona labels in
// the first place — a judge that "promises not to look" is not a control, a
// judge that structurally CANNOT see the labels is. This module is that
// structural guarantee: it is the single choke point every candidate must
// pass through before assembly into a judge payload, and it strips every
// identity-bearing field rather than trusting each caller to remember to.
//
// ── What counts as "identity" here ───────────────────────────────────────────
// A pool candidate (as produced by evals/harness/provider.mjs's `result.
// candidates` and enriched by the runner with arm/persona bookkeeping) may
// carry, at the JSON level: `arm` (the arm id/label), `model` (the underlying
// model id, e.g. "claude-opus-5"), `persona` (e.g. "proposer_3"). All three
// are provenance the judge must never see. Only the candidate's own
// idea TEXT is judge-relevant.
//
// This module does not try to scrub identity strings out of the TEXT itself
// (e.g. an idea that happens to mention "Claude" in its prose) — that is a
// content-inspection problem out of scope for #4 (the issue's AC only
// requires stripping the labeling FIELDS a pool candidate carries, and its
// test only feeds label fields, not label text embedded in the idea body).

/**
 * Strip arm/model/persona identity from every candidate in a pool, returning
 * TEXT-ONLY candidate objects. Never mutates the input pool (the study's
 * store is append-only and callers may reuse the same pool object elsewhere
 * for accounting/analysis that DOES need the identity fields).
 *
 * @param {Array<object|string>} pool  candidates; each either a bare string or
 *   an object carrying at least `.text` plus any of `arm`/`model`/`persona`.
 * @param {object} [arm]  the arm this pool was drawn from — accepted for
 *   symmetry with other evals/judge modules (distinct.mjs, matrix.mjs) that
 *   take `(pool, arm)`, but not required to de-identify: arm identity lives
 *   on the pool/candidate side (or is passed separately by the caller), never
 *   inferred from the candidate text.
 * @returns {Array<{text: string}>} text-only candidates, same order, same length
 */
export function deidentifyPool(pool, arm) {
  if (!Array.isArray(pool)) {
    throw new Error("deidentifyPool: pool must be an array of candidates");
  }
  return pool.map((candidate, i) => {
    if (typeof candidate === "string") return { text: candidate };
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`deidentifyPool: candidate at index ${i} must be a string or an object with a .text field`);
    }
    if (typeof candidate.text !== "string") {
      throw new Error(`deidentifyPool: candidate at index ${i} is missing a string .text field`);
    }
    // Deliberately whitelist the one field that survives (`text`) rather than
    // blacklisting known identity fields — a whitelist can't be defeated by a
    // future field this module doesn't yet know to blacklist (e.g. a new
    // `providerHint` field added upstream tomorrow). Anything not explicitly
    // let through is dropped by construction.
    return { text: candidate.text };
  });
}

/**
 * Assemble the full payload the judge call sends: the de-identified
 * candidates plus the brief text the judge scores them against. Brief text
 * is itself identity-free (it's the study's own frozen corpus, not a
 * candidate), so it passes through unchanged; only the candidate side goes
 * through `deidentifyPool`.
 *
 * @param {object} o
 *   @param {Array} o.pool    raw candidate pool (see deidentifyPool)
 *   @param {object} [o.arm]  forwarded to deidentifyPool for interface symmetry
 *   @param {string} o.briefText  the brief text the pool responds to
 * @returns {{ briefText: string, candidates: Array<{text: string}> }}
 */
export function assembleJudgePayload({ pool, arm, briefText }) {
  if (typeof briefText !== "string" || briefText.length === 0) {
    throw new Error("assembleJudgePayload: briefText must be a non-empty string");
  }
  return {
    briefText,
    candidates: deidentifyPool(pool, arm),
  };
}
