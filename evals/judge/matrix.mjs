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
// openai-* (and gpt-*) -> openai." lib/price.mjs's `providerOf` is now the ONE
// place that mapping is implemented (issue #62 HIGH -- a second copy lived
// here until then); this module re-exports it below rather than re-deriving
// the prefix rule, and any future module needing it should import from
// lib/price.mjs directly.
//
// ── issue #45 item 5: what H5's bias term actually measures ─────────────────
// H5's regression term is `judge_provider × generator_provider` — PROVIDER
// level, not model level. "Same provider" and "same model family" are not the
// same thing here: arm D is homogeneous Opus, and its Anthropic-provider judge
// leg (this matrix always schedules ONE Anthropic + one OpenAI judge, never
// the arm's own generator model — see assertEvaluatorDistinct) is satisfied by
// e.g. claude-sonnet-5 judging claude-opus-5 output. That is same-PROVIDER,
// different-MODEL judging. Wataoka et al.'s self-preference effect is a
// model-SELF-preference claim (a model favoring its own outputs specifically),
// not a provider-preference claim. So H5, as specified, tests whether a judge
// favors its own PROVIDER's arms in aggregate — a real and worth-testing
// effect — but it CANNOT isolate model self-preference from same-provider,
// different-model bias, and a positive H5 finding should not be reported as
// confirming Wataoka et al.'s effect without that caveat. This is a disclosed
// scope limitation, not a bug: fixing it would require a same-MODEL judge
// leg (a model judging its own outputs), which this matrix's distinctness
// invariant (§13, assertEvaluatorDistinct) deliberately forbids for the
// PRIMARY cross-judge schedule, since a non-distinct judge is exactly the
// confound H5 exists to detect in the first place.
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
// providerOf now lives in lib/price.mjs (issue #62 HIGH): #51 added a SECOND
// copy there on lib/-vs-evals/ layering grounds (lib/ must not import from
// evals/), which left two implementations of the SAME prefix rule with
// nothing pinning them to agreement -- a divergence (e.g. adding `gemini-`,
// or changing the OpenAI prefix set in one file but not the other) would
// silently produce wrong per-provider numbers, the exact failure this study's
// spend ceilings and judge_provider analysis both depend on getting right.
// Re-exported here so this module and every existing caller of
// `providerOf` from "./matrix.mjs" keep working unchanged, but there is now
// exactly ONE implementation -- lib/price.mjs's -- and lib/price.test.mjs's
// dedicated providerOf suite is the single place its behavior is pinned.
import { providerOf } from "../../lib/price.mjs";
export { providerOf };

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

/**
 * `judgeLegsFor` (issue #63 fix round) — a `lib/price.mjs:runnerPriceGrid`
 * `judgeLegsFor(cell, arm)` adapter. `lib/` cannot import this module (the
 * lib-vs-evals layering rule lib/price.mjs's own header states), so the
 * pre-flight pricer takes the resolved legs as an injected callback instead
 * of re-deriving judge selection itself. This factory is that callback,
 * built ONCE (closing over `judgeModels`/`panelConfig`) and handed to
 * `runnerPriceGrid` — see evals/run.mjs's wiring.
 *
 * Resolves each planned cell's TWO judge legs via buildJudgeMatrix's own
 * pickDistinctJudge selection (never a second, divergent selection rule) --
 * a cell whose arm has already exhausted every candidate for a provider
 * throws here exactly as it would in the real judging pass, so the
 * pre-flight can't project a cost for a matrix that would fail to schedule.
 *
 * `candidateCount` estimates the pool size runnerPriceGrid's token-based
 * judge pricing scales by: `panelConfig.size * panelConfig.ideasPerAgent`
 * for a panel arm, or `arm.totalIdeasRequested` for a solo arm (both are 30
 * in this study's arms.config.json today — the file's own header comment:
 * every arm is "matched on total ideas requested"). This is the RAW
 * generated idea count, not a validated post-dedup pool size — see
 * lib/price.mjs's JUDGE_POOL_SIZE_FALLBACK comment for the same caveat.
 *
 * @param {object} o
 *   @param {{anthropic:string[], openai:string[]}} o.judgeModels  same shape
 *     buildJudgeMatrix takes -- candidate judge models per provider.
 *   @param {{size:number, ideasPerAgent:number}} o.panelConfig  arms.config.json's
 *     top-level `panel` block (fixed across every panel arm in this study).
 * @returns {(cell:{key:string, armId:string}, arm:object) => Array<{model:string, provider:string, candidateCount:number}>}
 */
export function judgeLegsFor({ judgeModels, panelConfig }) {
  if (!judgeModels || typeof judgeModels !== "object") {
    throw new Error("judgeLegsFor: judgeModels ({ anthropic: [...], openai: [...] }) is required");
  }
  if (!panelConfig || typeof panelConfig.size !== "number" || typeof panelConfig.ideasPerAgent !== "number") {
    throw new Error("judgeLegsFor: panelConfig ({ size, ideasPerAgent }, arms.config.json's top-level `panel` block) is required");
  }
  return function legsFor(cell, arm) {
    const armWithId = { id: cell.armId, ...arm };
    const rows = buildJudgeMatrix([{ poolKey: cell.key, arm: armWithId }], { judgeModels });
    const candidateCount = arm.mode === "solo" && typeof arm.totalIdeasRequested === "number" ? arm.totalIdeasRequested : panelConfig.size * panelConfig.ideasPerAgent;
    return rows.map((r) => ({ model: r.judge_model, provider: r.judge_provider, candidateCount }));
  };
}
