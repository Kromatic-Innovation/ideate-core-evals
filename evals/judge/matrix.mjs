// matrix.mjs — the cross-judge matrix: every pool scheduled to exactly one
// Anthropic and one OpenAI judge, each verified distinct from the arm's own
// generators (issue #4, AC6).
//
// ── Why cross-judge at all ───────────────────────────────────────────────────
// docs/PREREGISTRATION.md §13 names H5 — same-provider judging bias — as a
// live methodological threat: if only Anthropic judges score Anthropic-heavy
// arms (or vice versa), any observed advantage for a provider's own arms is
// confounded with "the judge shares a provider with the generator" rather
// than being a real quality signal. The fix isn't just distinctness at the
// per-call level (evals/judge/distinct.mjs handles that) but a scheduling
// POLICY: every pool sees BOTH a same-family-safe Anthropic judge and an
// OpenAI judge, so #9's analysis can fit `judge_provider` and
// `judge_provider × generator_provider` as explicit terms and quantify H5
// directly instead of being unable to test for it at all.
//
// ── providerOf: the model-id -> provider inference the whole study relies on ──
// arms.config.json's own header comment states the convention this codifies:
// "Provider is inferred from the model id prefix: claude-* -> anthropic,
// openai-* (and gpt-*) -> openai." This is the ONE place that mapping is
// implemented; matrix.mjs and any future module needing it should import
// `providerOf` rather than re-deriving the prefix rule.
//
// ── Judge selection policy ───────────────────────────────────────────────────
// `judgeModels` maps provider -> an ORDERED list of candidate judge model ids
// (most-preferred first, e.g. sonnet before haiku before opus, or whatever
// preference order the caller supplies). For each pool/provider, the first
// candidate that passes assertEvaluatorDistinct against that pool's arm is
// scheduled; if NONE of a provider's candidates are distinct (e.g. an arm
// that already uses every model in a provider's candidate list), scheduling
// throws rather than silently judging with a same-provider model or silently
// dropping that provider's leg of the matrix.

import { assertEvaluatorDistinct } from "./distinct.mjs";

/** Infer a model id's provider from its prefix — the one place this mapping
 *  lives (see header). Throws on anything else rather than guessing, because
 *  a silently-mis-attributed provider would corrupt the very
 *  judge_provider × generator_provider analysis this matrix exists to feed. */
export function providerOf(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error(`providerOf: modelId must be a non-empty string, got ${JSON.stringify(modelId)}`);
  }
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("openai-") || modelId.startsWith("gpt-")) return "openai";
  throw new Error(`providerOf: cannot infer a provider for model id '${modelId}' (expected a 'claude-*' or 'openai-*'/'gpt-*' prefix)`);
}

/** The set of providers represented among an arm's generator slots. */
function generatorProvidersOf(arm) {
  return Array.from(new Set((arm.slots || []).map((slot) => providerOf(slot.model))));
}

/**
 * Pick the first candidate judge model (in the caller's preference order)
 * for `provider` that is distinct from every generator in `arm`. Throws if
 * none of the candidates qualify.
 */
function pickDistinctJudge(provider, candidates, arm, poolKey) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`buildJudgeMatrix: no candidate judge models configured for provider '${provider}' (pool '${poolKey}')`);
  }
  for (const candidate of candidates) {
    try {
      assertEvaluatorDistinct(candidate, arm);
      return candidate;
    } catch {
      // Not distinct against this arm — try the next candidate. Failure to
      // find ANY distinct candidate across the whole list is a real error,
      // surfaced after the loop (below), not silently swallowed.
      continue;
    }
  }
  throw new Error(
    `buildJudgeMatrix: no distinct ${provider} judge available for pool '${poolKey}' — every candidate ` +
      `(${candidates.join(", ")}) is also a generator model in this arm. Add a candidate judge model ` +
      `for '${provider}' that this arm does not already use.`,
  );
}

/**
 * Build the cross-judge matrix: for every pool, one Anthropic + one OpenAI
 * judge row, each already verified distinct from the pool's arm.
 *
 * @param {Array<object>} pools  each `{ poolKey, arm }` at minimum — `arm` is
 *   the resolved arms.config.json arm object (with `.slots`) the pool was
 *   generated under. Extra fields on a pool entry are ignored by this
 *   function and are NOT preserved on the emitted rows — callers needing more
 *   context should join on `poolKey` downstream.
 * @param {object} o
 *   @param {object} o.judgeModels  { anthropic: [modelId, ...], openai: [modelId, ...] }
 *     candidate judge models per provider, most-preferred first.
 * @returns {Array<{poolKey, arm: string, judge_provider, judge_model, generator_providers: string[]}>}
 *   Exactly 2 rows per pool (one per provider), the shape #9's analysis fits
 *   `judge_provider` and `judge_provider × generator_provider` against.
 */
export function buildJudgeMatrix(pools, { judgeModels } = {}) {
  if (!Array.isArray(pools)) throw new Error("buildJudgeMatrix: pools must be an array");
  if (!judgeModels || typeof judgeModels !== "object") {
    throw new Error("buildJudgeMatrix: judgeModels ({ anthropic: [...], openai: [...] }) is required");
  }
  const providers = ["anthropic", "openai"];
  const rows = [];
  for (const pool of pools) {
    if (!pool || !pool.poolKey || !pool.arm) {
      throw new Error("buildJudgeMatrix: every pool entry must carry { poolKey, arm }");
    }
    const generatorProviders = generatorProvidersOf(pool.arm);
    for (const provider of providers) {
      const judgeModel = pickDistinctJudge(provider, judgeModels[provider], pool.arm, pool.poolKey);
      rows.push({
        poolKey: pool.poolKey,
        arm: pool.arm.id || pool.armId || null,
        judge_provider: provider,
        judge_model: judgeModel,
        generator_providers: generatorProviders,
      });
    }
  }
  return rows;
}
