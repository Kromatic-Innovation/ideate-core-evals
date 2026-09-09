// prompts.test.mjs — hermetic tests for issue #130: `strategy` becomes a
// RENDERED prompt lever (`"cot"` inserts a chain-of-thought paragraph into
// both buildRound1Prompt and buildRound2Prompt; every other value, including
// undefined, renders nothing extra).
//
// No network, no real ideate-core -- prompts.mjs is pure (see its own header
// comment), so this file imports it directly with no fixtures or fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildRound1Prompt,
  buildRound2Prompt,
  promptTemplateHash,
  TOKENS_PER_IDEA_BY_MODEL,
  DEFAULT_TOKENS_PER_IDEA,
  MAX_TOKENS_HEADROOM,
  LEGACY_MAX_TOKENS,
  MIN_REQUEST_MAX_TOKENS,
  MIN_REQUEST_MAX_TOKENS_BY_EFFORT,
  SALVAGE_VERSION,
  EFFORT_FREE,
  maxTokensForIdeas,
} from "./prompts.mjs";

const ROUND1_COT_MARKER = "Work through the brief before you commit to any idea";
const ROUND2_COT_MARKER = "Work through the shared pool before you commit to any idea";

const BASE_R1_ARGS = { context: { brief: "BRIEF" }, persona: "p", stance: "STANCE", ideasPerAgent: 6 };
const BASE_R2_ARGS = {
  context: { brief: "BRIEF" },
  persona: "p",
  stance: "STANCE",
  ideasPerAgent: 6,
  seeds: [{ text: "seed one" }],
};

// ── Round 1 ──────────────────────────────────────────────────────────────

test("#130 round1: strategy 'cot' renders the CoT paragraph", () => {
  const prompt = buildRound1Prompt({ ...BASE_R1_ARGS, strategy: "cot" });
  assert.ok(prompt.includes(ROUND1_COT_MARKER));
  assert.ok(prompt.includes("Do not include this reasoning in your reply."));
});

test("#130 round1: strategy 'direct' renders nothing extra", () => {
  const prompt = buildRound1Prompt({ ...BASE_R1_ARGS, strategy: "direct" });
  assert.ok(!prompt.includes(ROUND1_COT_MARKER));
});

test("#130 round1: an unknown strategy string renders nothing extra", () => {
  const prompt = buildRound1Prompt({ ...BASE_R1_ARGS, strategy: "some-unknown-value" });
  assert.ok(!prompt.includes(ROUND1_COT_MARKER));
});

test("#130 round1: strategy undefined renders nothing extra", () => {
  const prompt = buildRound1Prompt({ ...BASE_R1_ARGS });
  assert.ok(!prompt.includes(ROUND1_COT_MARKER));
});

test("#130 round1: the CoT block sits immediately before the 'Generate exactly N' sentence, after the stance line", () => {
  const prompt = buildRound1Prompt({ ...BASE_R1_ARGS, strategy: "cot" });
  const stanceIdx = prompt.indexOf("STANCE");
  const cotIdx = prompt.indexOf(ROUND1_COT_MARKER);
  const generateIdx = prompt.indexOf("Generate exactly 6 distinct candidate ideas");
  assert.ok(stanceIdx < cotIdx, "cot block must come after the stance line");
  assert.ok(cotIdx < generateIdx, "cot block must come before the 'Generate exactly N' sentence");
});

test("#130 round1: the JSON-only output contract sentence is unchanged under both strategies", () => {
  const contract = 'Reply with ONLY a JSON array of 6 objects, each shaped exactly {"text": "<the idea, 1-3 sentences>"}. ' +
    'No other fields, no surrounding prose, no markdown fence -- just the JSON array.';
  assert.ok(buildRound1Prompt({ ...BASE_R1_ARGS, strategy: "cot" }).includes(contract));
  assert.ok(buildRound1Prompt({ ...BASE_R1_ARGS, strategy: "direct" }).includes(contract));
});

// ── Round 2 ──────────────────────────────────────────────────────────────

test("#130 round2: strategy 'cot' renders the CoT paragraph", () => {
  const prompt = buildRound2Prompt({ ...BASE_R2_ARGS, strategy: "cot" });
  assert.ok(prompt.includes(ROUND2_COT_MARKER));
  assert.ok(prompt.includes("Do not include this reasoning in your reply."));
});

test("#130 round2: strategy 'direct' renders nothing extra", () => {
  const prompt = buildRound2Prompt({ ...BASE_R2_ARGS, strategy: "direct" });
  assert.ok(!prompt.includes(ROUND2_COT_MARKER));
});

test("#130 round2: an unknown strategy string renders nothing extra", () => {
  const prompt = buildRound2Prompt({ ...BASE_R2_ARGS, strategy: "some-unknown-value" });
  assert.ok(!prompt.includes(ROUND2_COT_MARKER));
});

test("#130 round2: strategy undefined renders nothing extra", () => {
  const prompt = buildRound2Prompt({ ...BASE_R2_ARGS });
  assert.ok(!prompt.includes(ROUND2_COT_MARKER));
});

test("#130 round2: the CoT block sits immediately before the 'Generate exactly N NEW' sentence", () => {
  const prompt = buildRound2Prompt({ ...BASE_R2_ARGS, strategy: "cot" });
  const cotIdx = prompt.indexOf(ROUND2_COT_MARKER);
  const generateIdx = prompt.indexOf("Generate exactly 6 NEW candidate ideas.");
  assert.ok(cotIdx >= 0 && generateIdx >= 0);
  assert.ok(cotIdx < generateIdx, "cot block must come before the 'Generate exactly N NEW' sentence");
});

test("#130 round2: the JSON-only output contract sentence is unchanged under both strategies", () => {
  const contract = 'Reply with ONLY a JSON array of 6 objects, each shaped exactly {"text": "<the idea, 1-3 sentences>"}. ' +
    'No other fields, no surrounding prose, no markdown fence -- just the JSON array.';
  assert.ok(buildRound2Prompt({ ...BASE_R2_ARGS, strategy: "cot" }).includes(contract));
  assert.ok(buildRound2Prompt({ ...BASE_R2_ARGS, strategy: "direct" }).includes(contract));
});

// ── promptTemplateHash: the mutation-proof test ─────────────────────────────
//
// Defect this guards against: a hash payload that renders only ONE strategy
// branch per builder would leave the OTHER branch's wording unhashed and
// silently mutable -- editing the cot paragraph would not move configHash,
// so previously-stored cells would keep pooling with cells generated under
// the new wording as if nothing had changed. That is exactly the class of
// defect promptTemplateHash() exists to prevent (see its header comment and
// issue #93).
//
// An ESM module's exported function can't be monkey-patched from a test, so
// this can't literally "delete the cot render and watch the hash fail to
// move." Instead it asserts two things that together make that failure mode
// impossible: (1) the real hash's payload actually contains BOTH strategy
// branches rendered, by recomputing the payload locally and reproducing the
// same hash; (2) the direct and cot renders are not equal to each other, so
// that payload cannot vanish into a duplicate degenerate case.
test("#130 mutation-proof: promptTemplateHash's payload contains BOTH the direct and cot renders of BOTH builders, and they differ", () => {
  const HASH_PROBE_ARGS = {
    context: { slug: "hash-probe", brief: "HASH PROBE BRIEF" },
    persona: "hash_probe_persona",
    stance: "HASH PROBE STANCE",
    ideasPerAgent: 7,
    seeds: [{ text: "hash probe seed" }],
    buildOnDirective: "HASH PROBE DIRECTIVE",
  };
  const payload = {
    round1: buildRound1Prompt(HASH_PROBE_ARGS),
    round2: buildRound2Prompt(HASH_PROBE_ARGS),
    round1Direct: buildRound1Prompt({ ...HASH_PROBE_ARGS, strategy: "direct" }),
    round1Cot: buildRound1Prompt({ ...HASH_PROBE_ARGS, strategy: "cot" }),
    round2Direct: buildRound2Prompt({ ...HASH_PROBE_ARGS, strategy: "direct" }),
    round2Cot: buildRound2Prompt({ ...HASH_PROBE_ARGS, strategy: "cot" }),
    round1Defaults: buildRound1Prompt(),
    round2Defaults: buildRound2Prompt(),
    tokensPerIdeaByModel: TOKENS_PER_IDEA_BY_MODEL,
    defaultTokensPerIdea: DEFAULT_TOKENS_PER_IDEA,
    maxTokensHeadroom: MAX_TOKENS_HEADROOM,
    legacyMaxTokens: LEGACY_MAX_TOKENS,
    minRequestMaxTokensByEffort: MIN_REQUEST_MAX_TOKENS_BY_EFFORT,
    minRequestMaxTokens: MIN_REQUEST_MAX_TOKENS,
    salvageVersion: SALVAGE_VERSION,
  };
  const hashOf = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 12);
  assert.equal(hashOf(payload), promptTemplateHash(), "recomputed payload must reproduce the real hash");

  // The branches actually differ, so this payload cannot silently collapse
  // into a duplicate of the pre-#130 single-branch payload.
  assert.notEqual(payload.round1Direct, payload.round1Cot);
  assert.notEqual(payload.round2Direct, payload.round2Cot);

  // Sanity check on the fixture, not additional coverage: this merely
  // re-confirms the `notEqual` assertions above by taking a visibly
  // different payload shape and checking it hashes differently too. The
  // real guard is the `hashOf(payload) === promptTemplateHash()` assertion
  // earlier in this test -- that is what fails if the real payload ever
  // stops rendering one of the four branches.
  const collapsedPayload = {
    ...payload,
    round1Direct: payload.round1Cot,
    round2Direct: payload.round2Cot,
  };
  assert.notEqual(hashOf(collapsedPayload), promptTemplateHash());
});

// Pinned literal (issue #130): expected to move on ANY registered prompt
// change (a wording edit to either builder, either strategy branch, the
// sizing constants, or SALVAGE_VERSION). This value moved from the pre-#130
// value 0fb497a4a61d specifically because #130 made `strategy` a rendered
// lever -- see the PR body for that history. It moved AGAIN, to c6c2a60a4fe8,
// when this same issue #130 re-keyed TOKENS_PER_IDEA_BY_MODEL by (model,
// effort) instead of a flat per-model number -- a different max_tokens cap is
// a different request, so the sizing-constants payload changing is exactly
// the intended effect (see the PR body for the develop value this moved from:
// b529182bea28).
test("#168: promptTemplateHash() is pinned to the post-#168 (effort-keyed floor) value", () => {
  // Moved from #160's 12b0a1a414c2 by adding MIN_REQUEST_MAX_TOKENS_BY_EFFORT
  // to the payload (which itself moved from #130's c6c2a60a4fe8 by adding the
  // flat floor). That is the intended effect: a different max_tokens is a
  // different request, so no cell collected under the old max-effort ceiling
  // may be pooled with one collected under the new one.
  //
  // What this hash move does NOT mean is that every stale cell must be
  // re-collected. #168 changes the `max` bucket only, so a request that names
  // no max-effort slot resolves to the SAME max_tokens on both sides of it --
  // see the S1C control-arm invariance test below, which is the evidence
  // behind pooling the two hashes with `--config-hash a,b`.
  assert.equal(promptTemplateHash(), "52989c87b3e9");
});

// ── issue #160: the per-REQUEST floor ──────────────────────────────────────

test("#160: the floor is the probe's observed maximum times MAX_TOKENS_HEADROOM, and it covers every reply the probe saw", () => {
  // The probe's largest single reply (round 2, sci-08, stop_reason end_turn),
  // 2026-09-09, claude-sonnet-5 effort high, ideasPerAgent 6. The floor is
  // derived from it by the SAME convention every rate in prompts.mjs uses --
  // the TOP of the observed distribution times MAX_TOKENS_HEADROOM -- so this
  // pins the derivation, not just the literal.
  const PROBE_MAX_OUTPUT_TOKENS = 2749;
  assert.equal(MIN_REQUEST_MAX_TOKENS, Math.ceil(PROBE_MAX_OUTPUT_TOKENS * MAX_TOKENS_HEADROOM));

  // The defect #160 fixes: the Stage 1b panel ceiling (6 * 175 * 2.5) sat BELOW
  // replies the probe actually observed. Two of 49 exceeded it.
  const STAGE_1B_PANEL_CEILING = 2625;
  assert.ok(
    STAGE_1B_PANEL_CEILING < PROBE_MAX_OUTPUT_TOKENS,
    "if the old ceiling were above the observed max there would have been no truncation to explain",
  );
  assert.ok(MIN_REQUEST_MAX_TOKENS > PROBE_MAX_OUTPUT_TOKENS, "the floor must clear the observed max outright");
});

test("#160: the floor binds at the panel shape and is inert at every solo shape in this study", () => {
  // Binds: the shape that truncated.
  assert.equal(maxTokensForIdeas(6, "claude-sonnet-5", "high"), MIN_REQUEST_MAX_TOKENS);
  // Inert: the per-idea unit is sound at solo sizes, and #160 must not disturb
  // them -- an inflated per-idea RATE would have, which is why the instrument
  // is a floor.
  for (const ideas of [30, 60]) {
    const v = maxTokensForIdeas(ideas, "claude-sonnet-5", "high");
    assert.equal(v, Math.ceil(ideas * 175 * MAX_TOKENS_HEADROOM), `solo ${ideas} must be rate-decided, not floor-decided`);
    assert.ok(v > MIN_REQUEST_MAX_TOKENS);
  }
  // Inert for a model whose own measured rate already clears it at 6 ideas.
  assert.ok(maxTokensForIdeas(6, "claude-opus-5") > MIN_REQUEST_MAX_TOKENS);
  assert.equal(maxTokensForIdeas(6, "claude-opus-5"), Math.ceil(6 * 558 * MAX_TOKENS_HEADROOM));
});

// ── issue #168: the effort-keyed floor, and what it leaves untouched ────────

test("#168: the max floor is the probe's observed maximum times MAX_TOKENS_HEADROOM, and it clears every reply the probe saw", () => {
  // The probe's largest single reply at effort max (round 1, sci-08, persona
  // weirdo, stop_reason end_turn -- so the top is observed, not censored),
  // 2026-09-09, claude-sonnet-5, ideasPerAgent 6. Derived by the SAME
  // convention every other number in prompts.mjs uses, so this pins the
  // derivation and not just the literal.
  const PROBE_MAX_OUTPUT_TOKENS_AT_MAX_EFFORT = 18209;
  assert.equal(
    MIN_REQUEST_MAX_TOKENS_BY_EFFORT.max,
    Math.ceil(PROBE_MAX_OUTPUT_TOKENS_AT_MAX_EFFORT * MAX_TOKENS_HEADROOM),
  );

  // The defect #168 fixes: the Stage 1c max-effort ceiling sat BELOW replies
  // the probe actually observed -- 6 of 12, a 50% per-REPLY rate.
  const STAGE_1C_MAX_EFFORT_CEILING = 11640;
  assert.equal(STAGE_1C_MAX_EFFORT_CEILING, Math.ceil(6 * 776 * MAX_TOKENS_HEADROOM), "the ceiling that truncated");
  assert.ok(
    STAGE_1C_MAX_EFFORT_CEILING < PROBE_MAX_OUTPUT_TOKENS_AT_MAX_EFFORT,
    "if the old ceiling were above the observed max there would have been no truncation to explain",
  );
  assert.ok(MIN_REQUEST_MAX_TOKENS_BY_EFFORT.max > PROBE_MAX_OUTPUT_TOKENS_AT_MAX_EFFORT);
});

test("#168: low and high are NOT raised -- the probe cleared the existing floor in both, so touching them would be unmeasured", () => {
  // Probe tops: low 814, high 2980, both under the 6873 flat floor. #160's
  // floor is correct for them and #168 changes nothing there. This is the
  // assertion that keeps a future edit from "tidying" the two buckets into the
  // keyed table on symmetry grounds, which would stale every cell in the study
  // for a change no measurement asked for.
  for (const effort of ["low", "high", undefined]) {
    assert.equal(maxTokensForIdeas(6, "claude-sonnet-5", effort), MIN_REQUEST_MAX_TOKENS, `effort=${effort}`);
  }
  assert.deepEqual(Object.keys(MIN_REQUEST_MAX_TOKENS_BY_EFFORT), ["max"]);
});

test("#168: both Stage 1c SOLO control arms resolve to an UNCHANGED max_tokens -- the evidence behind pooling their configHash", () => {
  // This test is the argument, not a formality. #168 moves promptTemplateHash,
  // which stales all 432 Stage 1c cells -- including the 288 control cells.
  // Those were kept and pooled via `--config-hash <old>,<new>` (see
  // evals/analysis/storeConfig.mjs) on the claim that their REQUESTS did not
  // change. Here is that claim, checked.
  //
  // Both control arms run entirely at effort `high`, which #168 does not touch:
  //   S1C-SOLO60    60 ideas -> rate-decided, 60 * 175 * 2.5 = 26250
  //   S1C-SOLO6X10   6 ideas -> floor-decided, MIN_REQUEST_MAX_TOKENS = 6873
  // The pre-#168 values are hard-coded rather than recomputed, so this compares
  // against what the store's cells were ACTUALLY collected under. Recomputing
  // them from the current constants would make the test vacuous -- it would
  // pass no matter what #168 did.
  const PRE_168_SOLO60 = 26250;
  const PRE_168_SOLO6X10 = 6873;
  assert.equal(maxTokensForIdeas(60, "claude-sonnet-5", "high"), PRE_168_SOLO60);
  assert.equal(maxTokensForIdeas(6, "claude-sonnet-5", "high"), PRE_168_SOLO6X10);

  // And the treatment arm's max-effort slots DID change -- otherwise the fix
  // would not have fixed anything, and there would be nothing to re-collect.
  assert.notEqual(maxTokensForIdeas(6, "claude-sonnet-5", "max"), 11640);
  assert.equal(maxTokensForIdeas(6, "claude-sonnet-5", "max"), 45523);
});

// ── issue #130: maxTokensForIdeas's (model, effort) resolution order ────────

test("#130 resolution order (1): an exact (model, effort) bucket wins", () => {
  // issue #160 raised the request floor to MIN_REQUEST_MAX_TOKENS (6873), which
  // is ABOVE what several of these buckets compute at 6 ideas -- so the idea
  // counts here are chosen to clear it, or the assertion would be about the
  // floor rather than about which bucket was read. That masking is the intended
  // effect (#160: per-idea is the wrong unit at small request sizes), not a
  // weakening of this test: every bucket is still distinguished, just at a size
  // where the per-idea unit is the binding one.
  assert.equal(maxTokensForIdeas(6, "claude-sonnet-5", "low"), MIN_REQUEST_MAX_TOKENS);
  // A larger idea count clears the floor, proving the "low" bucket really is
  // being read (not silently falling through to "high"). 30 no longer suffices
  // under #160 (30 * 81 * 2.5 = 6075 < 6873); 60 does.
  assert.equal(maxTokensForIdeas(60, "claude-sonnet-5", "low"), Math.ceil(60 * 81 * MAX_TOKENS_HEADROOM));
  assert.equal(maxTokensForIdeas(60, "claude-sonnet-5", "high"), Math.ceil(60 * 175 * MAX_TOKENS_HEADROOM));
  // #168 keyed the request floor by effort, and at `max` that floor (45523) is
  // far above what the rate computes at 6 ideas -- so the assertion has to move
  // to a size where the RATE is the binding term, or it would be about the
  // floor. Same masking #160 introduced at `low`/`high` above, one bucket over.
  assert.equal(maxTokensForIdeas(6, "claude-sonnet-5", "max"), MIN_REQUEST_MAX_TOKENS_BY_EFFORT.max);
  assert.equal(maxTokensForIdeas(30, "claude-sonnet-5", "max"), Math.ceil(30 * 776 * MAX_TOKENS_HEADROOM));
  // The three buckets remain mutually distinct where the rate binds -- the
  // masking above is a property of small requests, not of the resolution.
  assert.equal(new Set([60, 60, 60].map((n, i) => maxTokensForIdeas(n, "claude-sonnet-5", ["low", "high", "max"][i]))).size, 3);
});

test("#130 resolution order: undefined effort resolves to the SAME rate as explicit \"high\" -- the documented omit-equals-high equivalence, not an assumption", () => {
  assert.equal(maxTokensForIdeas(30, "claude-sonnet-5"), maxTokensForIdeas(30, "claude-sonnet-5", "high"));
  assert.notEqual(maxTokensForIdeas(30, "claude-sonnet-5"), maxTokensForIdeas(30, "claude-sonnet-5", "low"));
  assert.notEqual(maxTokensForIdeas(30, "claude-sonnet-5"), maxTokensForIdeas(30, "claude-sonnet-5", "max"));
});

test("#130 resolution order (2): a model's EFFORT_FREE rate wins over falling through to the model's highest bucket or the global default, for ANY effort argument", () => {
  const opusEffortFree = TOKENS_PER_IDEA_BY_MODEL["claude-opus-5"][EFFORT_FREE];
  // 40 ideas, not 6: #168's effort-keyed floor (45523 at `max`) dominates the
  // EFFORT_FREE rate at 6 ideas, which would make this test assert the floor
  // rather than the resolution order it exists to pin. 40 * 558 * 2.5 = 55800
  // clears the floor in every bucket, so the rate is the binding term for all
  // six effort arguments and the comparison is the intended one.
  const IDEAS = 40;
  assert.ok(
    Math.ceil(IDEAS * opusEffortFree * MAX_TOKENS_HEADROOM) > MIN_REQUEST_MAX_TOKENS_BY_EFFORT.max,
    "the idea count must clear the highest effort-keyed floor or this test is about the floor",
  );
  for (const effort of [undefined, "low", "high", "max", "medium", "xhigh"]) {
    assert.equal(
      maxTokensForIdeas(IDEAS, "claude-opus-5", effort),
      Math.ceil(IDEAS * opusEffortFree * MAX_TOKENS_HEADROOM),
      `effort=${effort}`,
    );
  }
  // The floor still applies to Opus at `max` -- every fallback in this file is
  // upward, and an unmeasured (model, effort) pair is exactly where the
  // generous direction is the safe one (#168: it is a FIXED per-reply cost, so
  // there is no reason to believe it vanishes on a model we have not probed).
  assert.equal(maxTokensForIdeas(6, "claude-opus-5", "max"), MIN_REQUEST_MAX_TOKENS_BY_EFFORT.max);
});

test("#130 resolution order (3): an unmeasured effort bucket on an otherwise-measured model falls back to that model's OWN highest measured rate", () => {
  // "medium" is not a bucket sonnet has. Sonnet's own highest bucket (776,
  // its "max" entry) happens to equal DEFAULT_TOKENS_PER_IDEA today, so this
  // test alone cannot distinguish step (3) from step (4) falling through --
  // there is no registered model today whose own highest measured rate is
  // BELOW 776 to make that distinction with real data. What it does pin: an
  // unmeasured effort on Sonnet does not silently resolve to something
  // smaller than Sonnet's own worst-measured case (e.g. it must not fall all
  // the way to "low"'s 81, which would under-size exactly like this issue's
  // defect).
  const medium = maxTokensForIdeas(6, "claude-sonnet-5", "medium");
  assert.equal(medium, Math.ceil(6 * 776 * MAX_TOKENS_HEADROOM));
  assert.ok(medium > maxTokensForIdeas(6, "claude-sonnet-5", "low"));
});

test("#130 resolution order (4): a wholly unmeasured model falls back to DEFAULT_TOKENS_PER_IDEA, the highest rate measured for ANY model at ANY effort (776)", () => {
  assert.equal(DEFAULT_TOKENS_PER_IDEA, 776);
  assert.equal(maxTokensForIdeas(6, "claude-haiku-4-5"), Math.ceil(6 * 776 * MAX_TOKENS_HEADROOM));
  assert.equal(maxTokensForIdeas(6), Math.ceil(6 * 776 * MAX_TOKENS_HEADROOM), "omitted model, too");
  // At `max` the #168 floor outranks the default rate at 6 ideas; 30 puts the
  // rate back in charge (30 * 776 * 2.5 = 58200) so this still pins the
  // fallback RATE for a wholly unmeasured model rather than the floor.
  assert.equal(maxTokensForIdeas(6, "gpt-5.6-terra", "max"), MIN_REQUEST_MAX_TOKENS_BY_EFFORT.max);
  assert.equal(maxTokensForIdeas(30, "gpt-5.6-terra", "max"), Math.ceil(30 * 776 * MAX_TOKENS_HEADROOM));
});
