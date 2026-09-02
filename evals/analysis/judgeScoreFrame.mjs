// judgeScoreFrame.mjs — the judge-score analysis frame for H5 (issue #80,
// docs/PREREGISTRATION.md Appendix B item 6 / §6.2). Sibling to
// frame.mjs/rarefiedFrame.mjs, not a repurposing of either: frame.mjs's own
// header states building the judge-score frame is out of its scope ("a
// different frame than the distinct_k lane"), and rarefiedFrame.mjs is the
// precedent this follows — a SEPARATE frame builder, its own named errors,
// its own convergence ladder (see fit.mjs's runJudgeScoreLadder()).
//
// ── Grain: one row per (pool x judge leg) ───────────────────────────────────
// Each row here is exactly one evals/judge/score.mjs judgeScoresKey() store
// record (recordJudgeScores) — a record already covers exactly ONE pool
// judged by exactly ONE judge model, which is exactly the (pool x judge leg)
// grain Appendix B item 6 registers ("§5.2 scores every pool with two judges
// (2 rows per pool)"). The record carries `judgeProvider` (evals/judge/
// matrix.mjs's provider inference, stamped in by recordJudgeScores) but NOT
// which provider(s) GENERATED the pool — that lives in arms.config.json,
// resolved via the arm the pool was generated under, which this module has
// no way to know from the store alone. Callers therefore supply
// `opts.pools`: one entry per poolKey naming the arm and that arm's
// generator-provider set (mirrors evals/judge/matrix.mjs's
// generatorProvidersOf derivation, not duplicated here — this module stays
// decoupled from arms.config.json exactly as frame.mjs stays decoupled from
// it, per frame.mjs's own header: "the ONLY module that knows ResultsStore's
// shape").
//
// ── response: a pool-leg-level mean, not a per-candidate row ───────────────
// Each judge-scores record holds one {originality, feasibility} pair PER
// CANDIDATE in the pool (evals/judge/prompt.mjs's JUDGE_AXES). H5's
// registered model fits at (pool x judge leg) grain, not candidate grain, so
// this frame's response is the MEAN of every candidate's every axis score in
// that leg's record — a single scalar summarizing how generously that judge
// scored that pool overall. This is a deliberate ANALYSIS-TIME aggregate, not
// a violation of evals/judge/prompt.mjs's assertAxesNotCollapsed guard: that
// guard protects the JUDGE'S OWN structured output (a model must never itself
// report one combined number instead of both axes) and is enforced upstream,
// at write time, on every stored record (recordJudgeScores re-runs it on
// every score before persisting) — it says nothing about how a downstream
// reader aggregates already-validated, already-separate axis scores into one
// summary statistic for a regression response.
//
// ── the "same-provider" bias term ───────────────────────────────────────────
// Appendix B item 6 registers `judge_provider` and `judge_provider x
// generator_provider` as the model's terms. This frame reduces the
// interaction to a SINGLE derived binary factor, JUDGE_SCORE_BIAS_COEFFICIENT
// ("judge_provider:generator_provider[T.same]"): true when the row's
// judge_provider is a member of that pool's generator-provider set, false
// otherwise. This is a faithful reduction for THIS study's schedule, not a
// lossy shortcut: every pool is judged by exactly one Anthropic and one
// OpenAI leg (matrix.mjs's buildJudgeMatrix schedules exactly 2 rows per
// pool), and every arm except G is provider-homogeneous, so the full
// judge_provider x generator_provider interaction has exactly one degree of
// freedom worth estimating — "did the judge share a provider with the
// generator" — which is exactly the threat matrix.mjs's own header names as
// what H5 exists to test. Arm G (mixed Anthropic/OpenAI generators) marks
// BOTH judge legs sameProvider=true, a disclosed scope limitation (mirrors
// matrix.mjs's own provider-vs-model self-preference caveat) rather than a
// silently wrong number for that arm.
//
// ── Never a silent full-pool/other-lane substitute ──────────────────────────
// No stored cell carries a judge-scores record until real judging (#68/#77)
// has actually run against a study cell — that is the expected, registered
// state today, not a misconfiguration. buildJudgeScoreFrame() throws the
// named, loud JudgeScoresUnavailableError in that case; callers MUST catch it
// and report H5 as NOT COMPUTED (the same `{unimplemented: true, p: 1}` shape
// contrasts.mjs already uses) — never fall through to a different estimand.

export const JUDGE_SCORE_BIAS_COEFFICIENT = "judge_provider:generator_provider[T.same]";

export class JudgeScoresUnavailableError extends Error {
  constructor(reason) {
    super(
      `buildJudgeScoreFrame: no judge-score records found for the supplied pools — H5's judge-score model NOT ` +
        `COMPUTED (${reason}). This is the expected state until real judging (#68/#77) has actually run against a ` +
        `study cell; report H5 as not computed (the same {unimplemented: true, p: 1} shape contrasts.mjs already ` +
        `uses for it), never silently substitute a different estimand.`,
    );
    this.name = "JudgeScoresUnavailableError";
    this.reason = reason;
  }
}

/** Mean over every numeric axis value across every candidate in one judge-scores
 *  record's `scores` array — see this module's header for why this is a
 *  legitimate analysis-time aggregate, not a re-collapse of the judge's own
 *  per-axis output. */
function meanAxisScore(scores, cellKey) {
  let sum = 0;
  let count = 0;
  for (const s of scores) {
    if (!s || typeof s !== "object") continue;
    for (const v of Object.values(s)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        count += 1;
      }
    }
  }
  if (count === 0) {
    throw new Error(`buildJudgeScoreFrame: judge-scores record '${cellKey}' has zero numeric axis values to average`);
  }
  return sum / count;
}

/**
 * Build the judge-score analysis frame: one row per (pool x judge leg),
 * response = that leg's mean judge score across every candidate/axis.
 *
 * @param {import("../../lib/store.mjs").ResultsStore} store
 * @param {object} opts
 *   @param {Array<{poolKey: string, armId: string, generatorProviders: string[]}>} opts.pools
 *     required — one entry per pool this run knows about. `generatorProviders`
 *     is the set of provider ids (e.g. ["anthropic"], or ["anthropic",
 *     "openai"] for a mixed arm like G) backing that pool's generation arm.
 * @returns {{
 *   rows: Array<{cellKey: string, poolKey: string, armId: string,
 *     judgeProvider: string, generatorProviders: string[], sameProvider: boolean,
 *     run: string, response: number}>,
 *   judgeProviderLevels: string[],
 *   responseField: string,
 * }}
 */
export function buildJudgeScoreFrame(store, opts = {}) {
  if (!store || typeof store.list !== "function" || typeof store.get !== "function") {
    throw new Error("buildJudgeScoreFrame: opts.store must be a ResultsStore (or duck-typed equivalent with .list()/.get())");
  }
  const pools = opts.pools;
  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error("buildJudgeScoreFrame: opts.pools is required — one entry per poolKey, { poolKey, armId, generatorProviders }");
  }
  const poolByKey = new Map();
  for (const p of pools) {
    if (!p || !p.poolKey || !Array.isArray(p.generatorProviders) || p.generatorProviders.length === 0) {
      throw new Error(`buildJudgeScoreFrame: every opts.pools entry needs { poolKey, armId, generatorProviders: string[] } (non-empty) — got ${JSON.stringify(p)}`);
    }
    poolByKey.set(p.poolKey, p);
  }

  const entries = store
    .list()
    .filter((e) => e.armId === "__judge-scores__" && e.state === "completed")
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const rows = [];
  for (const entry of entries) {
    const body = store.get(entry.key);
    const result = body.result;
    if (!result || result.kind !== "judge-scores") continue; // reserved namespace, but be defensive
    const pool = poolByKey.get(result.poolKey);
    if (!pool) continue; // a judge-score record for a pool THIS run's frame doesn't know about — not this contrast's concern
    const judgeProvider = result.judgeProvider;
    if (!judgeProvider || typeof judgeProvider !== "string") {
      throw new Error(`buildJudgeScoreFrame: judge-scores record '${entry.key}' has no judgeProvider`);
    }
    if (!Array.isArray(result.scores) || result.scores.length === 0) {
      throw new Error(`buildJudgeScoreFrame: judge-scores record '${entry.key}' has no scores`);
    }
    rows.push({
      cellKey: entry.key,
      poolKey: result.poolKey,
      armId: pool.armId,
      judgeProvider,
      generatorProviders: pool.generatorProviders,
      sameProvider: pool.generatorProviders.includes(judgeProvider),
      run: result.poolKey, // the (1|run) grouping factor — see module header
      response: meanAxisScore(result.scores, entry.key),
    });
  }

  if (rows.length === 0) {
    throw new JudgeScoresUnavailableError("no stored judge-scores record's poolKey matched any opts.pools entry");
  }

  const judgeProviderLevels = Array.from(new Set(rows.map((r) => r.judgeProvider))).sort();
  if (judgeProviderLevels.length < 2) {
    throw new JudgeScoresUnavailableError(
      `only ${judgeProviderLevels.length} distinct judge_provider level(s) present ([${judgeProviderLevels.join(", ")}]) — ` +
        "the judge_provider main effect and the same-provider bias term both need at least two",
    );
  }

  return {
    rows,
    judgeProviderLevels,
    responseField: "judge_score_mean",
  };
}
