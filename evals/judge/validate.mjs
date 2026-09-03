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
// ── issue #45 item 3: the per-idea brief is the idea's own topic ────────────
// SI_ET_AL_VALIDATION_BRIEF (config.mjs) is one generic brief applied to 98
// multi-page NLP proposals spanning 7 topics — "originality relative to the
// brief" is undefined when the brief is effectively "propose an NLP idea".
// The reviews carry a `topic` column (bias / coding / safety / multilingual /
// factuality / math / uncertainty), surfaced per idea by slice.mjs. The
// judge's payload shape (score.mjs `buildJudgeScoringPrompt` via
// assembleJudgePayload) is ONE briefText per score() call, so this
// composition groups slice.ideas by topic and issues one score() call PER
// TOPIC GROUP, each scored against that topic as its brief — never one
// call with one shared brief for the whole 98-idea slice. Scores are then
// re-assembled back into slice.ideas order before the gate runs, so the
// downstream axis/expert alignment contract (judge score i <-> expert score i)
// is unaffected by the grouping.
//
// An explicit `briefText` override (still accepted) skips topic grouping
// entirely and scores the WHOLE slice against that one shared brief in a
// single call — an escape hatch for the #16 operator, or for a caller (e.g.
// a test) that wants the old one-call-per-slice behavior. Topic grouping is
// only the DEFAULT when no override is supplied. Every included idea must
// carry a non-empty `topic` when grouping — fail loud (no silent fallback to
// the old generic brief), because a silently-substituted generic brief is
// exactly the undefined-brief defect this item fixes.
//
// ── No axis averaging, anywhere (§4.3/§5; issue #36 AC7) ─────────────────────
// The judge's axes must never be collapsed. This path never
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
//
// ── Stated assumption: cross-topic comparability (issue #45 SHOULD item) ────
// Per-topic grouping scores each idea against ITS OWN topic as the brief (7
// distinct briefs across the 98-idea slice) — a brief-RELATIVE originality
// judgment. The gate (gate.mjs's balancedAccuracyTopBottom) then ranks and
// splits the top/bottom 25% ACROSS the whole slice, mixing all 7 topics into
// one ranking. That treats "originality relative to brief A" and "originality
// relative to brief B" as points on the SAME scale, which is a real,
// unavoidable methodological assumption this composition makes but does not
// derive or test — it was never separately registered before this note. It is
// exactly as reasonable as the underlying rubric being topic-agnostic (issue
// #4's LiveIdeaBench-derived axis definitions are topic-agnostic by design),
// but it is an assumption, not a proven invariant, and REPORT.md must state it
// as a limitation alongside the axis/expert-column construct mismatch already
// registered in docs/PREREGISTRATION.md Appendix A item 7.

import { readSiEtAlSlice, sliceToJudgePool } from "./slice.mjs";
import { validateJudge, recordValidation, meterJudgeCall } from "./gate.mjs";
import { judgeScoresForAxis, computeJudgeHash } from "./score.mjs";
import { assertAxesNotCollapsed } from "./prompt.mjs";
import { providerOf } from "./matrix.mjs";
import { JUDGE_VALIDATION_AXIS, SI_ET_AL_EXPERT_SCORE_FIELD } from "./config.mjs";
import { priceRowsByProvider, RATE_TABLE as DEFAULT_RATE_TABLE } from "../../lib/price.mjs";

/** Tiny stable string->int32 hash for deriving a per-topic order seed (same
 *  scheme as score.mjs's runJudgeMatrix per-leg seed derivation) — its only
 *  job is to give different topic groups distinct, reproducible presentation
 *  orders from one base seed. Not cryptographic. */
function hashToInt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

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
 *   @param {string}  [o.briefText]    the research brief the judge scores against.
 *     DEFAULT: undefined — the composition groups slice.ideas by their own
 *     `topic` field and issues one judge.score() call per topic group, using
 *     the topic itself as that group's brief (issue #45 item 3). Pass an
 *     explicit non-empty string to instead score the WHOLE slice in one call
 *     against that one shared brief (the old #36 behavior; SI_ET_AL_VALIDATION_BRIEF
 *     in config.mjs remains available for a caller that wants it — it is no
 *     longer this function's own default).
 *   @param {object}  [o.config]       forwarded to validateJudge (accuracyFloor/quantile overrides)
 *   @param {number}  [o.seed]         judge presentation seed (default 1)
 *   @param {"batch"|"single"} [o.mode]  default "batch"
 *   @param {string}  o.timestamp      required — caller-supplied ISO 8601, forwarded to the
 *     provider and to every meterJudgeCall (replayability; mirrors score.mjs's
 *     runJudgeMatrix, which requires it for the same reason)
 *   @param {object}  [o.rateTable]    lib/price.mjs RATE_TABLE override, used only to
 *     compute `spendByProvider` from this run's own costRows (issue #63) — never
 *     affects what is stored (store rows are always token counts, priced at READ time)
 * @returns {Promise<{ metric, construction, n, accuracy, floor, verdict, rho,
 *   axis, expertColumn, judgeHash, sliceId, exclusions, costRows,
 *   spendByProvider, hasMissingRate, missingRateModels }>}
 */
export async function runJudgeValidation({
  store,
  judgeProvider,
  judgeModel,
  axis = JUDGE_VALIDATION_AXIS,
  expertScoreField = SI_ET_AL_EXPERT_SCORE_FIELD,
  sliceRoot,
  briefText,
  config,
  seed = 1,
  mode = "batch",
  timestamp,
  rateTable = DEFAULT_RATE_TABLE,
}) {
  if (!store) throw new Error("runJudgeValidation: store is required");
  if (!judgeProvider || typeof judgeProvider.score !== "function") {
    throw new Error("runJudgeValidation: judgeProvider with a .score() method is required");
  }
  if (!judgeModel) throw new Error("runJudgeValidation: judgeModel is required");
  // An explicitly-passed briefText must be non-empty — checked up front,
  // before reading the slice, so a caller's typo fails fast either way.
  if (briefText !== undefined && (typeof briefText !== "string" || briefText.length === 0)) {
    throw new Error("runJudgeValidation: briefText must be a non-empty string (the research brief the judge scores against)");
  }

  // 1. Read + join the slice, selecting the expert column being validated.
  const slice = readSiEtAlSlice({ root: sliceRoot, scoreField: expertScoreField });

  // 2. Text-only judge inputs, in slice.ideas order (the leakage boundary).
  const pool = sliceToJudgePool(slice);

  // 3. Judge scores the pool. The real judge scoring prompt requires a non-empty
  //    RESEARCH BRIEF per call (score.mjs buildJudgeScoringPrompt).
  //
  // Metering (issue #56 x #61 interaction): #56 metered this composition's
  // ONE judge call into lib/accounting.mjs like any other cell (AC10). #61
  // turned "this composition's judge call" into "1 + N calls" (the override
  // branch, or one call per topic group), so metering now happens at EVERY
  // call site, not once after a single call — and each call's store key is
  // tagged with the topic (or "__all__" for the single-call override) so
  // same-run calls never share a store key. Without the tag, every topic-group
  // call would collide on `judge-call|cell=${sliceId}|judge=${judgeModel}` and
  // lib/store.mjs's put() (byte-identical-or-throw on a key collision) would
  // either silently drop all but one group's tokens or throw mid-run.
  //
  // Metering happens BEFORE each call's completion check, exactly like #56's
  // original ordering — tokens consumed by a failed call must still reach the
  // ledger, extended here to every call site (override + each topic group).
  //
  // `timestamp` is required (not defaulted to wall-clock): score.mjs's
  // runJudgeMatrix already requires it for the same reason (meterJudgeCall
  // replayability) — a caller-substituted wall-clock timestamp would make a
  // re-run of this function non-idempotent, since store.put() throws on a
  // same-key row that isn't byte-identical to what's already there.
  if (!timestamp) {
    throw new Error(
      "runJudgeValidation: timestamp is required (caller-supplied ISO 8601, for meterJudgeCall replayability)",
    );
  }
  const sliceId = judgeValidationSliceId({ axis, expertScoreField });
  // costRows (issue #63): collected across EVERY meterJudgeCall this
  // composition makes (the override call, or one per topic group) so a
  // caller can see this run's judge spend without re-reading the store —
  // same discipline as score.mjs's runJudgeMatrix, and the same
  // build-the-row-exactly-once rule via meterJudgeCall's `row` field.
  const costRows = [];
  const meterCall = (topicTag, resp) => {
    if (resp && resp.tokens && (resp.tokens.input_tokens || resp.tokens.output_tokens)) {
      const metered = meterJudgeCall({
        store,
        cellKey: `${sliceId}|topic=${topicTag}`,
        judgeModel,
        tokens: resp.tokens,
        timestamp,
        mode, // issue #119: stamp this composition's actual batch/single lever onto the row
      });
      costRows.push(metered.row);
    }
  };

  const scores = new Array(slice.ideas.length);
  if (briefText !== undefined) {
    // Explicit override: score the WHOLE slice in one call against one
    // shared brief (the pre-#45 behavior).
    const resp = await judgeProvider.score({ briefText, candidates: pool }, { judgeModel, mode, seed, timestamp });
    meterCall("__all__", resp);
    if (!resp || resp.terminalState !== "completed") {
      const detail = resp ? (resp.detail || resp.failureKind || resp.terminalState) : "no response";
      throw new Error(
        `runJudgeValidation: judge did not complete scoring (${detail}) — refusing to record a validation on a failed judge run.`,
      );
    }
    if (!Array.isArray(resp.scores) || resp.scores.length !== pool.length) {
      throw new Error(
        `runJudgeValidation: judge returned ${resp.scores ? resp.scores.length : "no"} scores for ${pool.length} ideas — misaligned; refusing to validate.`,
      );
    }
    for (let i = 0; i < resp.scores.length; i++) scores[i] = resp.scores[i];
  } else {
    // Default (issue #45 item 3): group by each idea's own topic and issue
    // one score() call PER TOPIC, using the topic as that group's brief.
    // Fail loud on a missing topic — no silent fallback to a generic brief.
    const byTopic = new Map(); // topic -> original slice indices, in slice order
    slice.ideas.forEach((idea, i) => {
      if (typeof idea.topic !== "string" || idea.topic.trim().length === 0) {
        throw new Error(
          `runJudgeValidation: idea '${idea.ideaId}' has no non-empty 'topic' to use as its validation brief. ` +
            "Fix the slice's topic column, or pass an explicit briefText override to score the whole slice against one shared brief.",
        );
      }
      if (!byTopic.has(idea.topic)) byTopic.set(idea.topic, []);
      byTopic.get(idea.topic).push(i);
    });

    for (const [topic, indices] of byTopic) {
      const groupCandidates = indices.map((i) => pool[i]);
      // Distinct, replayable per-topic seed derived from the base seed, so
      // different topic groups don't share a presentation order (mirrors
      // score.mjs runJudgeMatrix's per-leg seed derivation).
      const groupSeed = (seed ^ hashToInt(topic)) | 0;
      const resp = await judgeProvider.score({ briefText: topic, candidates: groupCandidates }, { judgeModel, mode, seed: groupSeed, timestamp });
      meterCall(topic, resp);
      if (!resp || resp.terminalState !== "completed") {
        const detail = resp ? (resp.detail || resp.failureKind || resp.terminalState) : "no response";
        throw new Error(
          `runJudgeValidation: judge did not complete scoring topic '${topic}' (${detail}) — refusing to record a validation on a failed judge run.`,
        );
      }
      if (!Array.isArray(resp.scores) || resp.scores.length !== indices.length) {
        throw new Error(
          `runJudgeValidation: judge returned ${resp.scores ? resp.scores.length : "no"} scores for topic '${topic}' (${indices.length} ideas) — misaligned; refusing to validate.`,
        );
      }
      indices.forEach((origIndex, j) => {
        scores[origIndex] = resp.scores[j];
      });
    }
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

  // spendByProvider/hasMissingRate/missingRateModels (issue #63): the same
  // per-provider attribution runJudgeMatrix returns, over this composition's
  // OWN costRows — a judge row is single-model, so this reduces to
  // providerOf(judgeModel) regardless of which topic group produced it.
  const { byProvider: spendByProvider, hasMissingRate, missingRateModels } = priceRowsByProvider(costRows, rateTable, { batch: mode === "batch" });

  return { ...result, axis, expertColumn: expertScoreField, judgeHash, sliceId, exclusions: slice.exclusions, costRows, spendByProvider, hasMissingRate, missingRateModels };
}
