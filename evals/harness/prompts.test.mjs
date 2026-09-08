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
  SALVAGE_VERSION,
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
// lever -- see the PR body for that history.
test("#130: promptTemplateHash() is pinned to the post-#130 value", () => {
  assert.equal(promptTemplateHash(), "b529182bea28");
});
