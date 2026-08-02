// prompts.mjs — the two prompt-builders ideate-core requires from its caller
// (issue #19, spec item 4).
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
  const { context, stance, persona, ideasPerAgent } = args;
  const brief = (context && context.brief) || "";
  const n = Number.isFinite(ideasPerAgent) && ideasPerAgent > 0 ? ideasPerAgent : 6;
  const stanceLine = stance ? `Adopt this stance while you brainstorm:\n${stance}\n\n` : "";

  return (
    `You are one independent idea-generation agent (persona: ${persona || "generalist"}) contributing to ` +
    `a brainstorm. You do NOT see any other agent's output -- generate your own ideas independently.\n\n` +
    `BRIEF:\n${brief}\n\n` +
    stanceLine +
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
 * @param {object} args  ideate-core's round2 prompt args:
 *   { context, agent, persona, stance, temperature, seeds, pool, sharing,
 *     buildOnDirective, incubation, round }
 * @returns {string}
 */
export function buildRound2Prompt(args = {}) {
  const { context, stance, persona, seeds, buildOnDirective, ideasPerAgent } = args;
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

  return (
    `You are one agent (persona: ${persona || "generalist"}) in a build-on brainstorming round.\n\n` +
    `BRIEF:\n${brief}\n\n` +
    stanceLine +
    `SHARED POOL SO FAR:\n${seedList}\n\n` +
    `${directive}\n\n` +
    `Generate exactly ${n} NEW candidate ideas.\n\n` +
    `Reply with ONLY a JSON array of ${n} objects, each shaped exactly {"text": "<the idea, 1-3 sentences>"}. ` +
    `No other fields, no surrounding prose, no markdown fence -- just the JSON array.`
  );
}
