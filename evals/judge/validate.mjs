// validate.mjs — runJudgeValidation: the composition that threads the repaired
// Si et al. slice through the judge to the validation gate (issue #36).
//
// This is the last code between the repaired slice (#35) and the real validation
// run (#16). It wires, in order:
//
//   readSiEtAlSlice  ->  sliceToJudgePool  ->  judge.score  ->  judgeScoresForAxis
//     ->  validateJudge  ->  recordValidation
//
// WHICH judge axis validates against WHICH expert column is a pre-registration
// decision, registered as named constants in config.mjs (JUDGE_VALIDATION_AXIS /
// SI_ET_AL_EXPERT_SCORE_FIELD) and in docs/PREREGISTRATION.md Appendix A item 7 —
// `originality` ↔ `overall_score`. This composition reads those registered values
// as its defaults rather than baking a choice in at the call site.
//
// ── No axis averaging, anywhere (§4.3/§5; issue #36 AC7) ─────────────────────
// The judge emits four axes that must never be collapsed. This path never
// averages: it runs assertAxesNotCollapsed on every returned score and then
// selects ONE axis with judgeScoresForAxis. The only mean taken is over an
// idea's multiple EXPERT REVIEWS of the SAME column (the expert consensus per
// idea) — never across axes.
//
// ── Alignment ───────────────────────────────────────────────────────────────
// sliceToJudgePool preserves slice.ideas order, and a judge provider returns
// scores aligned to its input candidate order (the same contract runJudgeMatrix
// relies on), so judge score i lines up with expert score i for the same idea.
// A length mismatch throws rather than silently validating misaligned vectors.

import { readSiEtAlSlice, sliceToJudgePool } from "./slice.mjs";
import { validateJudge, recordValidation, meterJudgeCall } from "./gate.mjs";
import { judgeScoresForAxis, computeJudgeHash } from "./score.mjs";
import { assertAxesNotCollapsed } from "./prompt.mjs";
import { providerOf } from "./matrix.mjs";
import { JUDGE_VALIDATION_AXIS, SI_ET_AL_EXPERT_SCORE_FIELD, SI_ET_AL_VALIDATION_BRIEF } from "./config.mjs";

/** Mean of an idea's expert review scores (its expert consensus for the column).
 *  This is a per-idea aggregate over REVIEWS of one column — not an axis average. */
function meanOf(xs) {
  if (!Array.isArray(xs) || xs.length === 0) {
    throw new Error("runJudgeValidation: an idea carries no expert scores to aggregate");
  }
  let sum = 0;
  for (const x of xs) {
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new Error("runJudgeValidation: an idea carries a non-numeric expert score");
    }
    sum += x;
  }
  return sum / xs.length;
}

/** The reserved sliceId for a judge-validation record, self-describing in the
 *  (axis, expert column) it validated so records for different axes/columns
 *  never collide in the store. */
export function judgeValidationSliceId({ axis, expertScoreField }) {
  return `si-et-al|axis=${axis}|expert=${expertScoreField}`;
}

/**
 * Run the judge over the Si et al. expert-score slice and record the validation
 * verdict. Composition only — every step is an existing, separately-tested unit.
 *
 * @param {object} o
 *   @param {object}  o.store          lib/store.mjs ResultsStore (the gate lives here)
 *   @param {{score: Function}} o.judgeProvider  a JudgeProvider (score(payload, opts))
 *   @param {string}  o.judgeModel     the judge model id being validated
 *   @param {string}  [o.axis]         judge axis (default JUDGE_VALIDATION_AXIS = "originality")
 *   @param {string}  [o.expertScoreField]  expert column (default SI_ET_AL_EXPERT_SCORE_FIELD = "overall_score")
 *   @param {string}  [o.sliceRoot]    slice root (default data/si-et-al via readSiEtAlSlice)
 *   @param {string}  [o.briefText]    the research brief the judge scores against
 *     (default SI_ET_AL_VALIDATION_BRIEF — the judge scoring prompt requires a
 *     non-empty brief; the slice carries no per-idea brief, so one shared brief
 *     is supplied). A reversible default (#36 / #250) — the #16 operator may override.
 *   @param {object}  [o.config]       forwarded to validateJudge (accuracyFloor/quantile overrides)
 *   @param {number}  [o.seed]         judge presentation seed (default 1)
 *   @param {"batch"|"single"} [o.mode]  default "batch"
 *   @param {string}  [o.timestamp]    forwarded to the provider when it meters
 * @returns {Promise<{ metric, construction, n, accuracy, floor, verdict, rho,
 *   axis, expertColumn, judgeHash, sliceId, exclusions }>}
 */
export async function runJudgeValidation({
  store,
  judgeProvider,
  judgeModel,
  axis = JUDGE_VALIDATION_AXIS,
  expertScoreField = SI_ET_AL_EXPERT_SCORE_FIELD,
  sliceRoot,
  briefText = SI_ET_AL_VALIDATION_BRIEF,
  config,
  seed = 1,
  mode = "batch",
  timestamp,
}) {
  if (!store) throw new Error("runJudgeValidation: store is required");
  if (!judgeProvider || typeof judgeProvider.score !== "function") {
    throw new Error("runJudgeValidation: judgeProvider with a .score() method is required");
  }
  if (!judgeModel) throw new Error("runJudgeValidation: judgeModel is required");

  // 1. Read + join the slice, selecting the expert column being validated.
  const slice = readSiEtAlSlice({ root: sliceRoot, scoreField: expertScoreField });

  // 2. Text-only judge inputs, in slice.ideas order (the leakage boundary).
  const pool = sliceToJudgePool(slice);

  // 3. Judge scores the pool. The real judge scoring prompt requires a non-empty
  //    RESEARCH BRIEF (score.mjs buildJudgeScoringPrompt), and the slice carries
  //    no per-idea brief, so the shared validation brief is threaded here — the
  //    payload shape (`{ briefText, candidates }`) matches assembleJudgePayload's.
  if (typeof briefText !== "string" || briefText.length === 0) {
    throw new Error("runJudgeValidation: briefText must be a non-empty string (the research brief the judge scores against)");
  }
  const resp = await judgeProvider.score({ briefText, candidates: pool }, { judgeModel, mode, seed, timestamp });

  // Meter the judge call's token cost BEFORE the completion check (issue #53:
  // this is a REAL provider call — the #16 live validation run — and its usage
  // must reach lib/accounting.mjs regardless of whether validation itself
  // proceeds, exactly like runJudgeMatrix's meterJudgeCall in score.mjs does
  // for the comparative-study judge calls. Previously this call's tokens were
  // dropped on the floor entirely: recordValidation always writes costRows: []
  // (by design — see gate.mjs's header comment — because a validation record's
  // OWN accounting is separate from the calls that produced it), and nothing
  // else in this function ever called meterJudgeCall.
  const meterTimestamp = timestamp || new Date().toISOString();
  const sliceId = judgeValidationSliceId({ axis, expertScoreField });
  if (resp && resp.tokens && (resp.tokens.input_tokens || resp.tokens.output_tokens)) {
    meterJudgeCall({ store, cellKey: sliceId, judgeModel, tokens: resp.tokens, timestamp: meterTimestamp });
  }

  if (!resp || resp.terminalState !== "completed") {
    const detail = resp ? (resp.detail || resp.failureKind || resp.terminalState) : "no response";
    throw new Error(
      `runJudgeValidation: judge did not complete scoring (${detail}) — refusing to record a validation on a failed judge run.`,
    );
  }
  const scores = resp.scores;
  if (!Array.isArray(scores) || scores.length !== slice.ideas.length) {
    throw new Error(
      `runJudgeValidation: judge returned ${scores ? scores.length : "no"} scores for ${slice.ideas.length} ideas — misaligned; refusing to validate.`,
    );
  }
  // Never let a collapsed/averaged score through (§4.3/§5; AC7).
  for (const s of scores) assertAxesNotCollapsed(s);

  // 4. Select the single validated axis (never averages) + per-idea expert mean.
  const judgeScores = judgeScoresForAxis(scores, axis);
  const expertScores = slice.ideas.map((idea) => meanOf(idea.expertScores));

  // 5. Gate.
  const result = validateJudge({ judgeScores, expertScores, config });

  // 6. Record — self-describing: the axis + expert column actually used.
  const judgeHash = computeJudgeHash({ judgeModels: { [providerOf(judgeModel)]: [judgeModel] } });
  recordValidation(store, {
    judgeHash,
    sliceId,
    ...result,
    judgeModel,
    axis,
    expertColumn: expertScoreField,
  });

  return { ...result, axis, expertColumn: expertScoreField, judgeHash, sliceId, exclusions: slice.exclusions };
}
