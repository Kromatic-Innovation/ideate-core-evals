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

// ── max_tokens sizing (issue #93, cause 1) ──────────────────────────────
//
// The #8 smoke study lost 9 of arm A's 10 cells to `empty_pool` while every
// panel arm lost 0. A live 6-sample probe of arm A's exact round-1 request
// (persona "solo", ideasPerAgent 30, max_tokens 2048, claude-sonnet-5) found
// clean 30-idea replies running 1597-1857 OUTPUT tokens -- 78-91% of the flat
// 2048 cap the adapter used for every call. Arm A was not comfortably under
// the limit, it was riding it, and any reply on the long side of that
// distribution stopped on `stop_reason: "max_tokens"` with its JSON cut
// mid-string. The panel arms request 6 ideas per call and are nowhere near
// 2048, which is exactly why the loss was arm-correlated -- and arm A vs. the
// panel is the comparison H1 tests.
//
// So the cap is sized from what the arm actually ASKS FOR rather than being a
// single constant tuned for 6 ideas:
//
//   ceil(ideas * TOKENS_PER_IDEA * HEADROOM), floored at LEGACY_MAX_TOKENS
//
// TOKENS_PER_IDEA is the TOP of the observed per-idea rate (1857/30 = 61.9),
// not the mean -- sizing off the mean would leave half the distribution
// exposed to the same failure. HEADROOM is 2.5x on top of that, per the
// issue's revised AC ("roughly 2x-3x of [1600-1860], not 10%"): a 30-idea
// request gets 4650 tokens against an observed worst case of 1857.
//
// ── Why a FLOOR, not a replacement ───────────────────────────────────
// LEGACY_MAX_TOKENS (2048) is retained as a floor so that every arm whose
// requests were NOT failing keeps sending byte-identical requests. 6 ideas
// computes to 930, which is below the floor, so panel arms B-H and A' still
// request exactly 2048 -- their #8 cells stay comparable with their re-run
// cells. Arm A (30 ideas) is the only configuration this changes, which is
// the minimum intervention that fixes the observed bug. This is asserted by
// a test, not left to inspection.
//
// max_tokens is a CEILING, not a target: raising it does not make a model
// write longer replies and costs nothing extra when unused (output tokens are
// billed as generated, not as reserved), so the headroom is free except for
// the comparability question the PR body addresses via promptTemplateHash().

/** Top of the observed output-tokens-per-idea rate (1857 output tokens / 30
 *  ideas), measured live on 2026-09-02 against claude-sonnet-5. */
export const TOKENS_PER_IDEA = 62;

/** Multiplier applied over TOKENS_PER_IDEA, per issue #93's revised AC. */
export const MAX_TOKENS_HEADROOM = 2.5;

/** The flat cap this adapter used before #93; kept as a FLOOR so no arm that
 *  was already working sends a different request than it did in run #8. */
export const LEGACY_MAX_TOKENS = 2048;

/** Fallback ideas-per-agent when a caller supplies nothing usable -- matches
 *  the same fallback the prompt builders above apply to `ideasPerAgent`. */
export const DEFAULT_IDEAS_PER_AGENT = 6;

/**
 * How many output tokens to allow a reply that was asked for `ideas` ideas.
 *
 * @param {number} ideas  ideasPerAgent for this call (arm A: 30; panels: 6).
 * @returns {number} a max_tokens value, never below LEGACY_MAX_TOKENS.
 */
export function maxTokensForIdeas(ideas) {
  const n = Number.isFinite(ideas) && ideas > 0 ? ideas : DEFAULT_IDEAS_PER_AGENT;
  return Math.max(LEGACY_MAX_TOKENS, Math.ceil(n * TOKENS_PER_IDEA * MAX_TOKENS_HEADROOM));
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
    round1: buildRound1Prompt(HASH_PROBE_ARGS),
    round2: buildRound2Prompt(HASH_PROBE_ARGS),
    // Rendered again with no args at all, so a change to either builder's
    // default/fallback branch also moves the hash.
    round1Defaults: buildRound1Prompt(),
    round2Defaults: buildRound2Prompt(),
    tokensPerIdea: TOKENS_PER_IDEA,
    maxTokensHeadroom: MAX_TOKENS_HEADROOM,
    legacyMaxTokens: LEGACY_MAX_TOKENS,
    salvageVersion: SALVAGE_VERSION,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}
