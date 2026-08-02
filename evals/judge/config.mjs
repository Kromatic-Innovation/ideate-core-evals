// config.mjs — the ρ floor is read from config, never baked in (issue #4, AC9).
//
// ── #24 rescope note ────────────────────────────────────────────────────────
// The GATE no longer reads a ρ floor: #24 replaced the (uninstantiable)
// Spearman-ρ gate with Si et al.'s split-half top/bottom-25% balanced-accuracy
// construction, floored at their reported 56.1%. That floor is a REGISTERED
// constant living with the gate (SI_ET_AL_BALANCED_ACCURACY_FLOOR /
// resolveAccuracyFloor in gate.mjs). `spearmanRho` is retained as a descriptive
// statistic, and `resolveRhoFloor` below is kept for anyone who wants to
// threshold that descriptive ρ explicitly — it is no longer on the gate path.
//
// ── Why there is no default number here ─────────────────────────────────────
// docs/PREREGISTRATION.md §5.1 pins the floor to "the human-human inter-rater
// agreement Si et al. themselves report — confirm their reported figure and
// set the floor to it, rather than to a number we like." The doc's own
// ρ ≥ 0.4 is explicitly flagged as an unconfirmed placeholder pending that
// confirmation. The issue's own re-scope comment is explicit: "The ρ floor
// constant... still human-only... #4 now *reads* the floor from config and
// **errors if it is unset**; it does not choose a number." Baking in ANY
// number here — even 0.4 — would silently promote a placeholder into a de
// facto default the moment nobody reads the doc closely; the only way to
// guarantee that can't happen is for the absence of an explicit floor to be a
// hard error, not a silently-applied fallback.
//
// A human registers the floor once Si et al.'s reported inter-rater figure is
// confirmed, by supplying `config.judge.rhoFloor` at the call site (e.g. from
// a future study-config file) — this module never writes that value itself,
// and arms.config.json is deliberately NOT touched by this issue to add one.

/**
 * Read the ρ floor from a config object. Throws if it is absent or not a
 * finite number — there is no default, per the header above.
 *
 * @param {object} config  arbitrary config object; the floor is read from
 *   `config.judge.rhoFloor` if present.
 * @returns {number} the registered ρ floor
 */
export function resolveRhoFloor(config) {
  const rhoFloor = config && config.judge ? config.judge.rhoFloor : undefined;
  if (typeof rhoFloor !== "number" || !Number.isFinite(rhoFloor)) {
    throw new Error(
      "resolveRhoFloor: no rho floor is registered (config.judge.rhoFloor is unset). " +
        "This is not a default-able value — docs/PREREGISTRATION.md §5.1 requires it be pinned to " +
        "Si et al.'s reported human-human inter-rater agreement by a human, not assumed by code. " +
        "Register it explicitly before validating a judge.",
    );
  }
  return rhoFloor;
}

// ── #36: the registered judge-axis ↔ Si et al. expert-column validation mapping ──
//
// docs/PREREGISTRATION.md §5.1 + Appendix A item 7 register WHICH judge axis is
// validated against WHICH Si et al. expert-review column. This is a
// pre-registration act — decided before any judge result is seen — so the mapping
// lives here as named constants the gate reads, never a literal buried at a call
// site (issue #36 AC: "the gate reads a registered value").

/** The judge axis validated against the Si et al. expert score (issue #36).
 *  `originality` — novelty is the study's primary idea-level metric (§4.2) and
 *  Si et al.'s own headline finding, so it is the axis whose validity most needs
 *  establishing. One of prompt.mjs JUDGE_AXES. */
export const JUDGE_VALIDATION_AXIS = "originality";

/** The Si et al. reviews column the axis validates against (issue #36).
 *  `overall_score` — the registered 56.1% floor is human-human split-half
 *  agreement on THIS column, so it is the only choice whose floor is already
 *  registered; validating against another column (e.g. `novelty_score`) would
 *  require deriving and registering a DIFFERENT floor — a second pre-registration
 *  act. This couples in a real CONSTRUCT MISMATCH — a novelty judgment scored
 *  against an overall-quality answer key — which is disclosed as a limitation in
 *  REPORT.md, not hidden (Appendix A item 7). Matches slice.mjs DEFAULT_SCORE_FIELD. */
export const SI_ET_AL_EXPERT_SCORE_FIELD = "overall_score";

/** The registered mapping as one frozen pair, for callers that want it together. */
export const JUDGE_VALIDATION_MAPPING = Object.freeze({
  axis: JUDGE_VALIDATION_AXIS,
  expertColumn: SI_ET_AL_EXPERT_SCORE_FIELD,
});

/**
 * The research brief the judge scores the Si et al. slice ideas AGAINST during
 * validation (issue #36). The judge's scoring prompt requires a non-empty
 * `RESEARCH BRIEF` (score.mjs `buildJudgeScoringPrompt`), but the expert-score
 * slice carries idea text only — no per-idea brief — so validation supplies one
 * shared brief describing the Si et al. research-ideation task.
 *
 * NOTE (reversible default, #36 / self-heal aperture #250): this wording is a
 * safe, reversible default — it lives in one named constant, changing it changes
 * nothing irreversible, and it only takes effect when the REAL validation is run
 * (issue #16, operator + live judge key). The #16 operator should confirm or
 * override it (`runJudgeValidation({ briefText })`), and consider whether the
 * study's per-topic briefs should be used instead of one shared brief. Recorded
 * so the choice is visible rather than hidden at a call site.
 */
export const SI_ET_AL_VALIDATION_BRIEF =
  "Propose a novel, expert-level research idea in natural language processing. " +
  "This is the research-ideation task underlying the Si et al. 2024 expert-review " +
  "study (arXiv:2409.04109): ideas span prompting-related NLP topics — bias, coding, " +
  "safety, multilingual, factuality, math, and uncertainty — and are judged as " +
  "standalone research proposals.";

// ── #36: registered LLM-evaluator comparators (Si et al. Table 11) ──
// Both are balanced accuracy on Si et al.'s OWN split-half top/bottom-25%
// construction, so our judge's number is directly comparable. Registered before
// any judge result is seen, so we can state in advance whether we beat them.

/** Claude-3.5 DIRECT score-only evaluator — 51.7% (arXiv:2409.04109 Table 11,
 *  verified 2026-08-02). The SHAPE-MATCHED comparator: our judge is a direct,
 *  score-only scorer, so this is the apples-to-apples figure. */
export const SI_ET_AL_LLM_COMPARATOR_DIRECT = 0.517;

/** Claude-3.5 PAIRWISE ranker — 53.3% (Table 11). Si et al.'s best LLM evaluator
 *  of ANY shape, but a pairwise ranker rather than a direct scorer, so it is NOT
 *  shape-matched to our judge. Retained as "their best evaluator", reported
 *  alongside the direct figure so the comparison is not misleading (Appendix A
 *  item 7). */
export const SI_ET_AL_LLM_COMPARATOR_PAIRWISE = 0.533;
