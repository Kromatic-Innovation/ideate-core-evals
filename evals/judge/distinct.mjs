// distinct.mjs — local `assertEvaluatorDistinct` (issue #4, AC5).
//
// ── Why this is a LOCAL re-implementation, not an import ────────────────────
// The semantic source of this assertion is ideate-core's own
// `assertEvaluatorDistinct` (sibling repo `ideate-core`, `lib/feedback.mjs:277`)
// — the engine already refuses to let a generator judge its own output for
// exactly the reason this study cares about (H5, docs/PREREGISTRATION.md §13:
// same-provider judging bias). But `ideate-core-evals`'s package.json has no
// dependency on `ideate-core` (zero runtime dependencies, hermetic-only), and
// issue #4 explicitly forbids adding a cross-repo dependency to satisfy this
// AC. So this module reimplements the same CHECK — a judge model must never
// be a generator model in the arm it is scoring — using only this repo's own
// arms.config.json shape (`arm.slots[].model`). If the upstream assertion's
// semantics ever drift from this one, that is a signal to re-sync by hand,
// not a coupling this repo silently inherits.
//
// ── Why this matters beyond "the engine already checks it" ──────────────────
// The ENGINE's assertEvaluatorDistinct protects a single ideate-core run from
// self-judging. This STUDY additionally needs the same guarantee at judge-
// selection time across the whole cross-judge matrix (evals/judge/matrix.mjs)
// — e.g. arm D is all-Opus, so an Opus judge must never be scheduled against
// D's pools even though Opus is a perfectly good judge for arm B (all-Haiku).
// The check has to be re-run per (pool, arm, candidate judge model) triple,
// which is why it is exposed as an independent, reusable assertion rather
// than folded silently into one call site.

/**
 * Throws if `judgeModel` is also a generator model used anywhere in `arm`'s
 * slots — i.e. the judge would be scoring its own (or a same-model sibling
 * persona's) output. Passes silently (returns undefined) when the judge
 * model is distinct from every generator in the arm.
 *
 * @param {string} judgeModel  the candidate judge's model id
 * @param {object} arm         an arm from arms.config.json's `.arms` map —
 *   must carry `.slots: [{model, ...}]`
 */
export function assertEvaluatorDistinct(judgeModel, arm) {
  if (!judgeModel || typeof judgeModel !== "string") {
    throw new Error("assertEvaluatorDistinct: judgeModel must be a non-empty string");
  }
  if (!arm || !Array.isArray(arm.slots)) {
    throw new Error("assertEvaluatorDistinct: arm must be an arms.config.json arm object with a .slots array");
  }
  const generatorModels = new Set(arm.slots.map((slot) => slot.model));
  if (generatorModels.has(judgeModel)) {
    throw new Error(
      `assertEvaluatorDistinct: judge model '${judgeModel}' is also a generator model in this arm ` +
        `(${[...generatorModels].join(", ")}) — a judge must never score output produced by itself ` +
        "(same-provider/same-model judging bias, docs/PREREGISTRATION.md §13, H5; " +
        "semantic source: ideate-core lib/feedback.mjs:277).",
    );
  }
}
