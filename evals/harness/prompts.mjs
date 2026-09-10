// prompts.mjs — the two prompt-builders ideate-core requires from its caller
// (issue #19, spec item 4), plus the two halves of the REPLY contract those
// prompts create: how many output tokens a reply of N ideas needs
// (`maxTokensForIdeas`, issue #93 cause 1) and how to recover candidates from
// a reply that does not parse as-is (`salvageCandidateArray`, issue #93
// cause 2). Both live here rather than in provider.mjs because both are
// consequences of the output contract THIS file's prompt text dictates, and
// both are provider-agnostic — the Anthropic and OpenAI adapters share them.
//
// ── Why this module exists, and why it is pure ──────────────────────────────
// `ideateCore(input, deps)` REQUIRES `deps.buildRound1Prompt` (a function) and
// optionally `deps.buildRound2Prompt` -- the core never ships prompt copy of
// its own (see node_modules/ideate-core/lib/ideate-core.mjs's header comment:
// "Everything DOMAIN-specific ... is supplied by the caller"). This module is
// that domain-specific copy for the eval harness.
//
// This file is PURE (no imports of ideate-core, no network, no I/O) so it can
// be loaded by a `*.test.mjs` with an empty node_modules -- see the hermetic
// CI invariant documented at the top of evals/harness/provider.mjs. The
// prompt-builders are called BY the provider's `ideateImpl` (either the real
// `ideateCore` or a test's fake), never imported by ideate-core itself.
//
// ── Output contract: {"text": "..."} candidates, NOT {title, body} ─────────
// ideate-core's extractCandidates() + buildCandidate() (see
// node_modules/ideate-core/lib/ideate-core.mjs) require a non-empty STRING
// `text` field on every raw candidate object; anything else (e.g. a
// `{title, body}` shape with no `text`) is silently dropped by buildCandidate
// -- `const text = typeof raw.text === "string" ? raw.text.trim() : "";
// if (!text) return null;`. So the prompt MUST instruct the model to reply
// with a JSON array of `{"text": "..."}` objects, or every candidate that
// model produces vanishes into the empty pool (the IC-08 silent mode
// lib/accounting.mjs's FAILURE_KINDS.empty_pool exists to catch).
//
// ── Kept generic/neutral ─────────────────────────────────────────────────────
// The corpus (evals/corpus/) is deliberately register-neutral (business /
// product / scientific / "aut" strata) -- see docs/PREREGISTRATION.md. These
// prompts do not lean into any one stratum's voice; they hand the model the
// brief text plus whatever persona/stance ideate-core resolved for this
// agent, and otherwise stay out of the way.

import { createHash } from "node:crypto";

/**
 * Round-1 (independent, "blind") prompt. Called once per agent -- no other
 * agent's output is visible here, which is the point (independence).
 *
 * @param {object} args  the shape ideate-core's round1PromptArgs() builds:
 *   { context, agent, persona, stance, temperature, temperatureValue,
 *     strategy, ideasPerAgent, model }
 *   `context` is whatever the provider passed as `input.context` -- this
 *   harness passes `{ slug: cell.briefId, brief: briefText }` (see
 *   evals/harness/provider.mjs's AnthropicBatchProvider.generate()).
 * @returns {string} the full prompt text to send as the user message.
 */
export function buildRound1Prompt(args = {}) {
  const { context, stance, persona, ideasPerAgent, strategy } = args;
  const brief = (context && context.brief) || "";
  const n = Number.isFinite(ideasPerAgent) && ideasPerAgent > 0 ? ideasPerAgent : 6;
  const stanceLine = stance ? `Adopt this stance while you brainstorm:\n${stance}\n\n` : "";
  const cotLine =
    strategy === "cot"
      ? `Work through the brief before you commit to any idea: first name the distinct dimensions along which ` +
        `responses to this brief could differ; then consider what a response at each end of each dimension would ` +
        `look like; only then decide which ideas to submit. Do not include this reasoning in your reply.\n\n`
      : "";

  return (
    `You are one independent idea-generation agent (persona: ${persona || "generalist"}) contributing to ` +
    `a brainstorm. You do NOT see any other agent's output -- generate your own ideas independently.\n\n` +
    `BRIEF:\n${brief}\n\n` +
    stanceLine +
    cotLine +
    `Generate exactly ${n} distinct candidate ideas responding to the brief above. Favor genuine variety over ` +
    `restating the same idea in different words.\n\n` +
    `Reply with ONLY a JSON array of ${n} objects, each shaped exactly {"text": "<the idea, 1-3 sentences>"}. ` +
    `No other fields, no surrounding prose, no markdown fence -- just the JSON array.`
  );
}

/**
 * Round-2+ ("build-on") prompt. Called once per agent per build-on round,
 * only when the round has a non-empty seed pool to build on (ideate-core
 * skips agents with no seeds). `seeds`/`pool` are ideate-core's own
 * (deduped, for "pool" sharing) candidate objects from prior rounds -- each
 * already carries a `.text` field, which is all this prompt needs.
 *
 * @param {object} args  ideate-core's round2 prompt args -- ideate-core's
 *   round2 request builder spreads `round1PromptArgs(context, agent)` first
 *   (see node_modules/ideate-core/lib/ideate-core.mjs), so `strategy` (and
 *   every other round-1 field) is present here too, not just the fields
 *   added for round 2:
 *   { context, agent, persona, stance, temperature, temperatureValue,
 *     strategy, ideasPerAgent, model, seeds, pool, sharing,
 *     buildOnDirective, incubation, round }
 * @returns {string}
 */
export function buildRound2Prompt(args = {}) {
  const { context, stance, persona, seeds, buildOnDirective, ideasPerAgent, strategy } = args;
  const brief = (context && context.brief) || "";
  const n = Number.isFinite(ideasPerAgent) && ideasPerAgent > 0 ? ideasPerAgent : 6;
  const stanceLine = stance ? `Your stance:\n${stance}\n\n` : "";
  const seedList = Array.isArray(seeds) && seeds.length
    ? seeds.map((s, i) => `${i + 1}. ${s && s.text}`).join("\n")
    : "(no prior ideas were shared)";
  const directive =
    buildOnDirective ||
    "Build on the shared pool below: COMBINE, EXTEND, or SUBVERT these into genuinely NEW directions. " +
      "Do NOT restate or lightly reword an existing idea.";
  const cotLine =
    strategy === "cot"
      ? `Work through the shared pool before you commit to any idea: first name what the existing ideas have in ` +
        `common; then consider which dimensions they leave unexplored; only then decide which new ideas to submit. ` +
        `Do not include this reasoning in your reply.\n\n`
      : "";

  return (
    `You are one agent (persona: ${persona || "generalist"}) in a build-on brainstorming round.\n\n` +
    `BRIEF:\n${brief}\n\n` +
    stanceLine +
    `SHARED POOL SO FAR:\n${seedList}\n\n` +
    `${directive}\n\n` +
    cotLine +
    `Generate exactly ${n} NEW candidate ideas.\n\n` +
    `Reply with ONLY a JSON array of ${n} objects, each shaped exactly {"text": "<the idea, 1-3 sentences>"}. ` +
    `No other fields, no surrounding prose, no markdown fence -- just the JSON array.`
  );
}

// ── max_tokens sizing (issue #93, cause 1; made per-model by issue #122) ────
//
// The #8 smoke study lost 9 of arm A's 10 cells to `empty_pool` while every
// panel arm lost 0. A live 6-sample probe of arm A's exact round-1 request
// (persona "solo", ideasPerAgent 30, max_tokens 2048, claude-sonnet-5) found
// clean 30-idea replies running 1597-1857 OUTPUT tokens -- 78-91% of the flat
// 2048 cap the adapter used for every call. Arm A was not comfortably under
// the limit, it was riding it, and any reply on the long side of that
// distribution stopped on `stop_reason: "max_tokens"` with its JSON cut
// mid-string.
//
// So the cap is sized from what the CALL actually asks for:
//
//   ceil(ideas * TOKENS_PER_IDEA[model] * HEADROOM), floored at LEGACY_MAX_TOKENS
//
// each model's TOKENS_PER_IDEA is the TOP of ITS OWN observed per-idea rate,
// not the mean -- sizing off the mean would leave half the distribution
// exposed to the same failure. HEADROOM is 2.5x on top of that, per issue
// #93's revised AC ("roughly 2x-3x of [1600-1860], not 10%").
//
// ── issue #122: a single Sonnet-measured constant, applied flat to every
//    model, is the SAME bug arm A had -- a cap sized from the wrong call's
//    shape ────────────────────────────────────────────────────────────────
// #93's constant (62) was measured ONLY against claude-sonnet-5, on a
// SOLO 30-idea ROUND-1 call. Every panel arm (B-H, A') uses a DIFFERENT
// model per slot (arms.config.json) and, from round 2 onward, a DIFFERENT
// prompt (build-on, not independent) -- and both axes were unmeasured for
// Opus. Applying Sonnet's 62 flat meant `maxTokensForIdeas(6) = 2048`
// (LEGACY_MAX_TOKENS, the floor) regardless of model, which happened to be
// enough for Sonnet/Haiku (empirically: arms B and C completed their #8 and
// pilot cells with no truncation) but not for Opus.
//
// A live probe of the real panel request shape (persona "proposer_1",
// ideasPerAgent 6, claude-opus-5, 2026-09-03) found round 1 (independent)
// output running 689-787 tokens (114.8-131.2/idea) across 6 samples, and
// round 2 (build-on) running MUCH higher and more variable: two synthetic-seed
// probes (a 6-seed and a realistic ~30-seed pool -- pool size did not change
// the ceiling materially) topped out at 291-298/idea across 11 samples.
//
// That probe under-measured the real shape. A DIRECT run of arm D's actual
// generate() call (real ideate-core engine, real 5-agent panel, real round-1
// pool feeding round 2, single/non-batch mode) on 2026-09-03 produced a
// round-2 outlier of 3346 output tokens / 6 ideas = 557.7/idea -- roughly 2x
// the synthetic-seed probes' worst case, and NOT explained by seed-pool size
// (the synthetic probe already used ~30 seeds). The likely cause: a
// synthetic seed list is uniform filler, while a REAL round-1 pool has
// genuine variety across 5 different personas' independent ideas, which
// gives Opus more to combine/extend/subvert against and elicits longer
// justification per idea. All 10 of that direct run's replies still finished
// on `stop_reason: "end_turn"` (none actually truncated) -- but the 3346
// figure landed at 76% of the THEN-current cap (4380, from a rate of 292),
// which is exactly the "riding the limit" shape #93 named as dangerous
// (78-91% of its own then-current cap). So the rate here is set from the
// REAL run, not the synthetic probe: Opus's TOKENS_PER_IDEA is 558 (ceil of
// 557.7, same convention as Sonnet's 62 from 61.9) -- roughly 9x Sonnet's
// rate. `cellMaxTokens` (provider.mjs's `maxTokensForCell`) is computed once
// per cell and applied to EVERY request in it (both rounds), so a rate that
// must cover round 2's real-pool shape is exactly what a per-cell ceiling
// needs -- a synthetic-seed probe alone was not a sufficient measurement.
//
// Sonnet keeps its existing #93 measurement rather than being re-measured at
// the panel shape: it is not observed to fail (arms B/C's pilot cells
// completed with no truncation under the 2048 floor), and re-measuring it
// would be exactly the "manufacture an API call this issue doesn't need"
// this issue's own plan warns against. Haiku is NOT separately measured for
// the same reason -- it has never failed either, and there is no
// Haiku-specific evidence to explain -- but it also has no measured rate of
// its own to fall back to, so an unmeasured model (Haiku today; a GPT tier or
// any future model always) uses DEFAULT_TOKENS_PER_IDEA: the highest rate
// measured for ANY model so far (currently Opus's 558). That is a real,
// dated, documented number -- not a guess or an extrapolation -- applied as
// the generous fallback issue #122 AC2 requires: max_tokens is a CEILING
// (see below), so over-sizing an unmeasured model's cap costs nothing, while
// under-sizing it reproduces this exact bug on the next model.
//
// ── Why LEGACY_MAX_TOKENS stays a FLOOR (issue #122 AC4) ────────────────────
// Before #122, LEGACY_MAX_TOKENS (2048) was ALSO the binding value for every
// panel arm (6 * 62 * 2.5 = 930 < 2048), which is why a Sonnet-derived rate
// was irrelevant to arm D's outcome -- the floor, not the rate, decided the
// request. That made it look like the ceiling, not a floor. It is not
// retired or made per-model here, because its actual JOB is unchanged and
// still worth doing: preserve byte-identical requests for any model/ideas
// combination that was already comfortably under it. At ideasPerAgent 6 that
// is claude-sonnet-5 alone (930 < 2048, unchanged from run #8) -- Haiku has
// no measured rate of its own, so it inherits DEFAULT_TOKENS_PER_IDEA (the
// same generous fallback an unmeasured GPT tier gets) and is ALSO raised
// above the floor, even though nothing observed it failing. That is a
// deliberate, priced consequence, not an oversight: `promptTemplateHash()`
// already moves for every model in this change (AC6), so there is no
// "byte-identical with run #8" left to protect for Haiku either, and the
// alternative -- inventing a Haiku-specific rate from Sonnet's, or leaving
// Haiku pinned to 2048 as a special case -- would be exactly the guess this
// issue exists to rule out. What changes under #122 is that the per-model
// rate can now legitimately exceed the floor (Opus: 8370 > 2048; every
// unmeasured model, via DEFAULT_TOKENS_PER_IDEA: also 8370 > 2048) when the
// evidence -- or the absence of it -- says it should. `Math.max(floor,
// computed)` already had that property; it needed a
// real per-model `computed`, not a redesign.
//
// max_tokens is a CEILING, not a target: raising it does not make a model
// write longer replies and costs nothing extra when unused (output tokens are
// billed as generated, not as reserved), so the headroom is free except for
// the comparability question the PR body addresses via promptTemplateHash().

/**
 * Per-(model, effort) TOKENS_PER_IDEA: the TOP of each (model, effort)
 * bucket's observed output-tokens-per-idea rate at the shape that
 * model/effort is actually called with in this harness (panel calls:
 * ideasPerAgent 6, round 1 AND round 2; arm A's solo call: ideasPerAgent 30,
 * round 1 only). Keyed by the exact model id string arms.config.json uses
 * (matches lib/price.mjs's RATE_TABLE convention); each model's value is
 * itself keyed by effort bucket, OR by the sentinel key `EFFORT_FREE` for a
 * rate measured with no `effort` reachable at all.
 *
 *   claude-sonnet-5: { low: 81, high: 175, max: 776 } -- issue #130. The
 *     original single-rate entry here (62, from 1857 output tokens / 30
 *     ideas, measured 2026-09-02 -- issue #93) was measured with NO `effort`
 *     set, at a time `effort` was not yet reachable from this harness. That
 *     is not "no effort" -- Anthropic's docs (platform.claude.com/docs/en/
 *     build-with-claude/effort, verified first-party 2026-09-08) state
 *     omitting `effort` is EXACTLY the `"high"` behavior for claude-sonnet-5
 *     (its API default), so the old 62 was actually an unlabeled `high`
 *     measurement -- and an undercount of it: 20 live claude-sonnet-5 calls
 *     against the real buildRound1Prompt Stage-1a shape on 2026-09-08 (all
 *     `max_tokens: 32000`, all `end_turn`, so nothing truncated) found:
 *       - low,  cot,    N=30: 44.7-80.8 tokens/idea  (2 samples)
 *       - high, cot,    N=30: 73.5-119.9 tokens/idea (2 samples)
 *       - high, direct, N=30: 82.6-99.7 tokens/idea  (2 samples)
 *       - high, cot,    N=10: 94.9-131.8 tokens/idea (2 samples)
 *       - high, cot,    N=60: 53.0-174.2 tokens/idea (6 samples)
 *       - max,  cot,    N=30: 197.5-775.6 tokens/idea (6 samples)
 *     Each bucket below is the TOP of ITS bucket's observed range across all
 *     N and strategy combinations measured for that effort: low -> 81 (ceil
 *     80.8), high -> 175 (ceil 174.2, from the N=60 condition -- the highest
 *     high-effort figure observed, not the N=30 one), max -> 776 (ceil
 *     775.6). The N=30/max condition alone exceeded its THEN-current cap
 *     (4650, sized from the stale 62) by 5.0x -- exactly the "riding the
 *     limit" shape #93 named as dangerous, concentrated in the
 *     highest-effort condition, which would read as a dose-response effect
 *     of effort on distinct_k when it is an artifact of the cap.
 *   claude-opus-5: { [EFFORT_FREE]: 558 } -- 3346 output tokens / 6 ideas,
 *     measured live 2026-09-03 by driving arm D's REAL generate() call end
 *     to end (real ideate-core engine, real 5-agent panel, real round-1 pool
 *     feeding round 2) (issue #122), with no `effort` set (unreachable from
 *     this harness at the time). A synthetic-seed probe of the same shape
 *     (11 samples, both a 6- and a ~30-seed pool) topped out at 291-298/idea
 *     and UNDER-measured the real rate by ~2x -- see the "issue #122" header
 *     comment above for why (a real round-1 pool has genuine cross-persona
 *     variety a synthetic pool does not, which elicits more elaboration in
 *     round 2's combine/extend/subvert reply). Kept under the `EFFORT_FREE`
 *     sentinel rather than re-bucketed under "high" (Sonnet's convention):
 *     unlike Sonnet's old 62, this measurement has never been re-taken with
 *     `effort` reachable, so re-labeling it "high" would overclaim precision
 *     this issue did not re-verify for Opus. `maxTokensForIdeas` resolves
 *     EFFORT_FREE for a model regardless of what `effort` argument it is
 *     called with (see resolution order below), which is exactly what keeps
 *     Opus's behavior byte-identical to before this change.
 *
 * Haiku (claude-haiku-4-5) is deliberately NOT in this table -- see the
 * "issue #122" header comment above for why it falls back to
 * DEFAULT_TOKENS_PER_IDEA instead of being measured.
 */
export const EFFORT_FREE = "__effort_free__";

export const TOKENS_PER_IDEA_BY_MODEL = {
  "claude-sonnet-5": { low: 81, high: 175, max: 776 },
  "claude-opus-5": { [EFFORT_FREE]: 558 },
};

/** Generous fallback for a model with no entry in TOKENS_PER_IDEA_BY_MODEL
 *  (today: claude-haiku-4-5, gpt-5.6-terra, gpt-5.6-sol, and any future
 *  model) -- the highest rate measured for ANY model at ANY effort so far
 *  (issue #130: 776, Sonnet's `max` bucket -- up from #122's 558, since
 *  `max` effort was not measured until #130). See the "issue #122" header
 *  comment above for why this is the documented, generous fallback AC2
 *  requires rather than a guess: `max_tokens` is a CEILING billed as
 *  generated, so over-sizing an unmeasured (model, effort) pair costs
 *  nothing, while under-sizing it reproduces this exact defect on the next
 *  model or effort level. */
export const DEFAULT_TOKENS_PER_IDEA = Math.max(
  ...Object.values(TOKENS_PER_IDEA_BY_MODEL).flatMap((byEffort) => Object.values(byEffort)),
);

/** Multiplier applied over TOKENS_PER_IDEA, per issue #93's revised AC. */
export const MAX_TOKENS_HEADROOM = 2.5;

/** The flat cap this adapter used before #93; kept as a FLOOR (issue #122
 *  AC4: still a floor, not per-model and not retired -- see the header
 *  comment above) so no model/ideas combination that was already working
 *  sends a different request than it did before. */
export const LEGACY_MAX_TOKENS = 2048;

// -- issue #160: a per-IDEA rate cannot size a SMALL request ----------------
// Stage 1b (docs/status-2026-09-09.md) ran its panel arms at ideasPerAgent 6
// on claude-sonnet-5/high, which `maxTokensForIdeas` sized at
// 6 * 175 * 2.5 = 2625. 19 of 45 S1B-PANEL cells came back with pools short of
// the 60 the arm specifies, against 3 of 48 for the matched solo arm at the
// same nominal pool size. A live probe of that exact request shape (49 replies,
// claude-sonnet-5 effort high, ideasPerAgent 6, rounds 1 and 2, briefs
// sci-08/sci-09/biz-01/prod-07/aut-01, 2026-09-09) found 2 of 49 replies over
// the 2625 cap -- ~4% per REPLY, which compounds to ~34% per CELL across the
// 10 calls a 5-slot two-round panel makes, and that is the ~42% short-pool rate
// the run observed.
//
// The defect is in the UNIT, not the number. `ideas * rate` treats output as
// proportional to the ideas asked for, but a reply has a FIXED cost -- framing,
// reasoning, the JSON scaffold -- that does not shrink with the request. The
// probe measures that directly, and the argument needs no comparison to any
// other probe: at a FIXED 6 ideas, round-1 output ran 604-2631 tokens, a 4.4x
// spread at constant idea count. Idea count cannot explain a spread it is held
// constant across. So per-idea is the wrong unit at small request sizes, and
// the instrument is a per-REQUEST floor rather than an inflated per-idea rate
// (which would over-size the 30- and 60-idea solo calls, where the unit is
// sound, by the same multiple).
//
// The floor is set by the SAME convention every rate in this file uses -- the
// TOP of the observed distribution times MAX_TOKENS_HEADROOM, not the mean:
// 2749 (the probe's largest single reply, round 2 on sci-08, stop_reason
// end_turn) * 2.5 = 6873. No new multiplier is introduced.
//
// Two things this deliberately does NOT do:
//   - It does not re-measure claude-sonnet-5's per-idea rate. At 6 ideas the
//     floor (6873) already dominates what the probe's top per-idea reply would
//     justify (6 * 439 * 2.5 = 6585), so a rate change would be inert here
//     while silently moving the 30/60-idea solo calls the rate is sound for.
//   - It does not claim to fix FORMAT failures. The same probe recorded 2 of 49
//     replies that stopped on `end_turn` and still yielded nothing usable (one
//     unparseable at 2032 tokens, one returning a single idea) -- ~4% per reply,
//     unaffected by any ceiling. Registered as a measured residual so the next
//     run's losses are read against a stated baseline (see PREREGISTRATION.md
//     Appendix J item 3), not mistaken for truncation returning.
//
// It is a FLOOR, applied flat to every model, for the same reason
// DEFAULT_TOKENS_PER_IDEA is generous: `max_tokens` is a CEILING billed as
// generated, so this is upward for every model and free where it does not bind.
// It binds only where the per-idea unit is unsound -- small `ideas`. It is inert
// for claude-opus-5 at 6 ideas (8370 > 6873) and for every solo call in this
// study (Sonnet at 30 ideas: 13125; at 60: 26250).
/** Per-REQUEST output-token floor, from the top of the observed panel-shape
 *  distribution times MAX_TOKENS_HEADROOM (issue #160). See above. */
export const MIN_REQUEST_MAX_TOKENS = 6873;

// -- issue #168: the per-request floor is itself a function of EFFORT --------
// #160 above is right that a reply carries a FIXED cost -- framing, reasoning,
// the JSON scaffold -- that does not shrink with the ideas asked for, and that
// a per-idea RATE therefore cannot size a small request. What it did not say is
// that the fixed cost is itself a function of `effort`, because its probe ran
// entirely at effort `high`. MIN_REQUEST_MAX_TOKENS is a `high` measurement
// wearing a flat name.
//
// Stage 1c found the gap the expensive way. S1C-RICH carries two `effort: max`
// slots; `maxTokensForIdeas` IS effort-aware (TOKENS_PER_IDEA_BY_MODEL's `max`
// bucket, 776), so those replies were sized at 6 * 776 * 2.5 = 11640 -- above
// the 6873 floor, and still far too low. 139 of 144 S1C-RICH cells failed
// `parse_failure` / `cause=partial_truncated`, every one of them with all five
// agents replying and a HEALTHY pool (median 48 candidates) that
// classifyUndersizedPool then discarded, because a pool assembled from fewer
// agents than the arm specifies must not be silently under-reported (#102).
//
// A 30-reply probe of the exact S1C-RICH shape (3 briefs x 5 slots x 2 rounds,
// claude-sonnet-5, ideasPerAgent 6, max_tokens 60000 so nothing truncated,
// every reply stop_reason `end_turn` so the top is observed and not censored,
// 2026-09-09) measured the fixed cost per effort bucket:
//
//   low   n=6   454-814      median 667     0/6  over the 6873 floor
//   high  n=12  771-2980     median 1782    0/12 over the 6873 floor
//   max   n=12  6586-18209   median 12917   6/12 over the 11640 cap
//
// Two things fall out of that table. `high` and `low` are FINE -- #160's floor
// clears both outright, so this issue changes nothing for them, and the two
// solo control arms (which run entirely at `high`) send byte-identical requests
// before and after. And `max` is not marginally short but ~2x short at the top,
// at a 50% per-REPLY rate -- which across the 4 max-effort replies a two-round
// 2-max-slot panel makes predicts 0.5^4 = 6.25% cell survival against the 3.5%
// actually observed. The arithmetic closes.
//
// Set by the SAME convention every other number in this file uses: the TOP of
// the observed distribution times MAX_TOKENS_HEADROOM. 18209 * 2.5 = 45523.
// No new multiplier, and no new mechanism -- this is #160's floor, keyed.
//
// Why a floor keyed by effort rather than a bigger `max` RATE: the cost is
// fixed per reply, not per idea. Lifting the rate to cover it would inflate a
// 60-idea max-effort solo call by the same multiple, where the per-idea unit is
// sound -- the exact error #160 identified, reintroduced one level up.
//
// `max_tokens` is a CEILING billed as generated, so the unused headroom is
// free; 45523 is well inside the model's accepted range (the probe itself sent
// 60000 without complaint).
export const MIN_REQUEST_MAX_TOKENS_BY_EFFORT = Object.freeze({ max: 45523 });

/** The per-request floor for `effort`, never below the flat
 *  MIN_REQUEST_MAX_TOKENS. `undefined` resolves to `high` for the same
 *  documented reason tokensPerIdeaFor does it (omitting `effort` is exactly
 *  the `high` behaviour), so the two halves of the sizing calculation cannot
 *  disagree about what an absent `effort` means. */
function minRequestMaxTokensFor(effort) {
  const key = effort === undefined ? "high" : effort;
  const keyed = Object.prototype.hasOwnProperty.call(MIN_REQUEST_MAX_TOKENS_BY_EFFORT, key)
    ? MIN_REQUEST_MAX_TOKENS_BY_EFFORT[key]
    : 0;
  return Math.max(MIN_REQUEST_MAX_TOKENS, keyed);
}

/** Fallback ideas-per-agent when a caller supplies nothing usable -- matches
 *  the same fallback the prompt builders above apply to `ideasPerAgent`. */
export const DEFAULT_IDEAS_PER_AGENT = 6;

/**
 * Resolve a per-idea output-token rate for `(model, effort)`, per issue
 * #130's resolution order (every fallback is upward -- see the header
 * comment above for why over-sizing is free and under-sizing reproduces the
 * defect):
 *
 *   1. an EXACT (model, effort) bucket -- with `effort === undefined`
 *      resolved to the `"high"` bucket FIRST, because Anthropic's docs
 *      (platform.claude.com/docs/en/build-with-claude/effort, verified
 *      first-party 2026-09-08) state omitting `effort` entirely produces
 *      "exactly the same behavior" as `effort: "high"` -- this is that
 *      documented equivalence, not an assumption;
 *   2. else the model's EFFORT_FREE rate, if it measured one (Opus's 558 --
 *      this is what keeps Opus's behavior unchanged regardless of what
 *      `effort` argument it is called with, since Opus has no per-effort
 *      buckets to try in step 1);
 *   3. else the HIGHEST rate measured for that model across any of its
 *      effort buckets (covers an unmeasured effort level on an otherwise-
 *      measured model, e.g. `medium` on Sonnet);
 *   4. else DEFAULT_TOKENS_PER_IDEA -- the highest rate measured for ANY
 *      model at ANY effort (covers an entirely unmeasured model, e.g.
 *      Haiku or a future GPT tier).
 *
 * @param {string} [model]
 * @param {string} [effort]
 * @returns {number}
 */
function tokensPerIdeaFor(model, effort) {
  const byEffort = model && TOKENS_PER_IDEA_BY_MODEL[model];
  if (byEffort) {
    const effortKey = effort === undefined ? "high" : effort;
    if (Object.prototype.hasOwnProperty.call(byEffort, effortKey)) return byEffort[effortKey];
    if (Object.prototype.hasOwnProperty.call(byEffort, EFFORT_FREE)) return byEffort[EFFORT_FREE];
    const rates = Object.values(byEffort);
    if (rates.length) return Math.max(...rates);
  }
  return DEFAULT_TOKENS_PER_IDEA;
}

/**
 * How many output tokens to allow a reply that was asked for `ideas` ideas
 * from `model` at effort level `effort`.
 *
 * @param {number} ideas  ideasPerAgent for this call (arm A: 30; panels: 6).
 * @param {string} [model]  the model id (arms.config.json's slot.model
 *   string). Unmeasured or omitted -> DEFAULT_TOKENS_PER_IDEA (issue #122).
 * @param {string} [effort]  the resolved slot's `effort` (arms.config.json's
 *   slot.effort string, e.g. "low"/"high"/"max"), or `undefined` when the
 *   slot sets none -- see `tokensPerIdeaFor` above for how `undefined` is
 *   resolved (issue #130).
 * @returns {number} a max_tokens value, never below LEGACY_MAX_TOKENS nor
 *   below MIN_REQUEST_MAX_TOKENS (issue #160).
 */
export function maxTokensForIdeas(ideas, model, effort) {
  const n = Number.isFinite(ideas) && ideas > 0 ? ideas : DEFAULT_IDEAS_PER_AGENT;
  const rate = tokensPerIdeaFor(model, effort);
  return Math.max(LEGACY_MAX_TOKENS, minRequestMaxTokensFor(effort), Math.ceil(n * rate * MAX_TOKENS_HEADROOM));
}

// ── Salvage (issue #93, cause 2) ────────────────────────────────────
//
// Raising max_tokens does NOT fix the whole bug. The same probe caught a reply
// that stopped on `end_turn` at 1833 tokens -- the model FINISHED -- and still
// failed JSON.parse with "Expected ',' or '}' after property value". A single
// malformed object inside an otherwise-perfect 30-object array discarded the
// entire paid pool, because ideate-core's extractCandidates parses the reply
// as one JSON document: one bad object, zero candidates, `empty_pool`.
//
// `salvageCandidateArray` makes that failure proportional instead of total.
// It walks the reply character-by-character (string-aware, so a `{` or `}`
// inside an idea's text is not mistaken for structure), isolates each
// top-level `{...}` object in the array, and JSON.parses them INDIVIDUALLY.
// A malformed object is dropped; its 29 well-formed siblings survive. The
// same walk handles the truncation shape for free: a reply cut mid-object
// simply never closes its final brace, so that object is dropped and every
// complete object before it is kept. (Truncation is still a real defect --
// the pool is short -- but a short pool beats no pool, and the diagnostics in
// provider.mjs record that it happened.)
//
// The fast path is a plain JSON.parse of the whole array. A well-formed reply
// -- the overwhelming majority -- takes that path and is handed to
// ideate-core completely untouched, so this cannot perturb the happy path.
//
// Bumping SALVAGE_VERSION is part of the contract: what this function
// recovers determines which pools exist at all, so a change to its behaviour
// changes what the study measures just as surely as a change to the prompt
// wording does. It is therefore an input to promptTemplateHash() below. Do
// not remove it as over-conservative -- that is the point of it.
export const SALVAGE_VERSION = "salvage-v1";

/**
 * Recover the candidate objects from a model reply that may be truncated,
 * fenced, wrapped in prose, or syntactically invalid.
 *
 * @param {string} rawText  the model's reply text.
 * @returns {{objects: object[], parsedDirectly: boolean, salvaged: boolean,
 *            dropped: number, error: string|null}}
 *   objects        the recovered candidate objects, in reply order.
 *   parsedDirectly true when the reply parsed as valid JSON with no repair.
 *   salvaged       true when repair was needed AND recovered at least one object.
 *   dropped        how many objects were unrecoverable (an unterminated
 *                  trailing object counts as one).
 *   error          the JSON.parse message from the whole-document attempt,
 *                  when there was one -- retained for the ledger detail.
 */
export function salvageCandidateArray(rawText) {
  const text = typeof rawText === "string" ? rawText : "";
  // Two views of the same reply. `body` is trimmed at BOTH ends (to the last
  // closing bracket), which is what makes a well-formed reply wrapped in
  // trailing prose parse directly. `scanBody` is trimmed only at the FRONT:
  // trimming the tail of a TRUNCATED reply is actively harmful, because
  // `lastIndexOf("]")` can land on a bracket inside an idea's own prose
  // ("use X [beta] now") and would then discard every complete object that
  // came after it. The char-walk needs no closing bracket, so it gets the
  // untrimmed tail.
  const { body, scanBody } = sliceToJsonBody(text);

  let error = null;
  try {
    const direct = JSON.parse(body);
    if (Array.isArray(direct)) {
      return { objects: direct.filter(isPlainObject), parsedDirectly: true, salvaged: false, dropped: 0, error: null };
    }
    if (isPlainObject(direct)) {
      // A single bare object rather than an array -- unusual but recoverable.
      return { objects: [direct], parsedDirectly: true, salvaged: false, dropped: 0, error: null };
    }
    error = "reply parsed but was neither an array nor an object";
  } catch (err) {
    error = (err && err.message) || "JSON.parse failed";
  }

  const { objects, dropped } = scanTopLevelObjects(scanBody);
  return { objects, parsedDirectly: false, salvaged: objects.length > 0, dropped, error };
}

/** Strip a markdown fence and any surrounding prose. Returns `body` (front-
 *  and tail-trimmed, for the whole-document JSON.parse attempt) and `scanBody`
 *  (front-trimmed only, for the char-walk) -- see salvageCandidateArray for
 *  why the tail trim must not reach the char-walk. */
function sliceToJsonBody(text) {
  let s = text.trim();
  // ```json ... ``` (or ``` ... ```), possibly unterminated on a truncated reply.
  const fence = s.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)(?:\n?```)?$/);
  if (fence) s = fence[1].trim();
  const startBracket = s.indexOf("[");
  const startBrace = s.indexOf("{");
  const start =
    startBracket === -1 ? startBrace : startBrace === -1 ? startBracket : Math.min(startBracket, startBrace);
  if (start === -1) return { body: s, scanBody: s };
  const scanBody = s.slice(start);
  const closer = s[start] === "[" ? "]" : "}";
  const end = s.lastIndexOf(closer);
  return { body: end > start ? s.slice(start, end + 1) : scanBody, scanBody };
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Character-walk that isolates each balanced top-level `{...}` region and
 * parses it on its own. String-aware (with escape handling), so braces and
 * brackets inside an idea's prose are never read as structure -- which is the
 * whole reason this is not a regex.
 */
function scanTopLevelObjects(s) {
  const objects = [];
  let dropped = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        const chunk = s.slice(start, i + 1);
        try {
          const parsed = JSON.parse(chunk);
          if (isPlainObject(parsed)) objects.push(parsed);
          else dropped++;
        } catch {
          dropped++; // this one object is malformed; its siblings are unaffected
        }
        start = -1;
      }
    }
  }
  // Ran off the end mid-object (or mid-string inside one) -- the truncation
  // shape. That trailing fragment is unrecoverable; everything before it is not.
  if (depth > 0 || inString || start >= 0) dropped++;

  return { objects, dropped };
}

// ── promptTemplateHash: the comparability pin (issue #93) ─────────────────
//
// `lib/manifest.mjs`'s CONFIG_FIELDS has always reserved `promptHash` as a
// comparability-relevant input to configHash, but `evals/run.mjs` supplies the
// literal string "unpinned" for it -- so a prompt change has never
// participated in cellKey discrimination, and cells generated under different
// prompts would be silently pooled. Issue #93 changes both the effective
// max_tokens for arm A and what a malformed reply yields, and BOTH change what
// is measured. Neither would have been visible to the staleness machinery that
// exists to catch exactly this.
//
// This function supplies a real hash, using the same convention as
// `evals/judge/prompt.mjs`'s `judgePromptHash()` (sha256, first 12 hex chars)
// so the two read alike in a manifest.
//
// It hashes:
//   * both prompt builders RENDERED against a fixed canonical argument set --
//     so any wording change anywhere in either template moves the hash,
//     including inside a conditional branch, which hashing the source text
//     would catch only accidentally;
//   * the max_tokens sizing constants -- a different cap is a different
//     request even at identical wording;
//   * SALVAGE_VERSION -- see the salvage header for why extraction behaviour
//     is a measurement input.
//
// evals/run.mjs must be changed to CALL this (that file is owned by another
// lane in the #93 fan-out; see the PR body for the exact change).

/** Fixed, arbitrary arguments used only to render the templates for hashing.
 *  Values are deliberately synthetic and are never sent to a model. */
const HASH_PROBE_ARGS = Object.freeze({
  context: { slug: "hash-probe", brief: "HASH PROBE BRIEF" },
  persona: "hash_probe_persona",
  stance: "HASH PROBE STANCE",
  ideasPerAgent: 7,
  seeds: [{ text: "hash probe seed" }],
  buildOnDirective: "HASH PROBE DIRECTIVE",
});

/**
 * Content hash of everything about the generation prompts that determines what
 * this study measures. sha256, first 12 hex chars (matches judgePromptHash).
 * @returns {string}
 */
export function promptTemplateHash() {
  const payload = JSON.stringify({
    // issue #130: strategy is now a rendered lever, not just a recorded one --
    // rendered TWICE per builder (once per branch) so a wording change to
    // EITHER branch (direct or cot) moves the hash. A single render (as
    // before #130) would leave the cot wording unhashed and silently
    // mutable -- exactly the defect promptTemplateHash exists to prevent.
    round1: buildRound1Prompt(HASH_PROBE_ARGS),
    round2: buildRound2Prompt(HASH_PROBE_ARGS),
    round1Direct: buildRound1Prompt({ ...HASH_PROBE_ARGS, strategy: "direct" }),
    round1Cot: buildRound1Prompt({ ...HASH_PROBE_ARGS, strategy: "cot" }),
    round2Direct: buildRound2Prompt({ ...HASH_PROBE_ARGS, strategy: "direct" }),
    round2Cot: buildRound2Prompt({ ...HASH_PROBE_ARGS, strategy: "cot" }),
    // Rendered again with no args at all, so a change to either builder's
    // default/fallback branch also moves the hash.
    round1Defaults: buildRound1Prompt(),
    round2Defaults: buildRound2Prompt(),
    // issue #122: per-model now, not a single constant -- a change to ANY
    // model's rate (a re-measurement, a new model added) is a change to what
    // was requested and must move the hash exactly as a wording edit does.
    tokensPerIdeaByModel: TOKENS_PER_IDEA_BY_MODEL,
    defaultTokensPerIdea: DEFAULT_TOKENS_PER_IDEA,
    maxTokensHeadroom: MAX_TOKENS_HEADROOM,
    legacyMaxTokens: LEGACY_MAX_TOKENS,
    minRequestMaxTokensByEffort: MIN_REQUEST_MAX_TOKENS_BY_EFFORT,
    // issue #160: a second floor, and a change to it is a change to what was
    // requested -- it must move the hash exactly as a rate change does.
    minRequestMaxTokens: MIN_REQUEST_MAX_TOKENS,
    salvageVersion: SALVAGE_VERSION,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}
