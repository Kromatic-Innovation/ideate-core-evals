// Tests for the frozen, LiveIdeaBench-sourced judge rubric (issue #4, AC1/AC2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JUDGE_PROMPT, JUDGE_AXES, judgePromptHash, assertAxesNotCollapsed } from "./prompt.mjs";
import { configHash, cellKey } from "../../lib/manifest.mjs";

// ── AC1: rubric shape ────────────────────────────────────────────────────────

test("JUDGE_AXES are exactly the two genuinely per-idea LiveIdeaBench axes, in order (issue #45: fluency/flexibility are pool-level, removed)", () => {
  assert.deepEqual(JUDGE_AXES, ["originality", "feasibility"]);
});

test("JUDGE_PROMPT carries a definition for every axis", () => {
  for (const axis of JUDGE_AXES) {
    assert.ok(JUDGE_PROMPT.axes[axis], `missing axis definition for '${axis}'`);
    assert.equal(typeof JUDGE_PROMPT.axes[axis].definition, "string");
    assert.ok(JUDGE_PROMPT.axes[axis].definition.length > 0);
  }
});

// ── (a) the prompt is frozen ────────────────────────────────────────────────

test("JUDGE_PROMPT is deep-frozen: mutation throws in strict mode", () => {
  assert.throws(() => {
    JUDGE_PROMPT.instructions = "tampered";
  }, TypeError);
  assert.throws(() => {
    JUDGE_PROMPT.axes.originality.definition = "tampered";
  }, TypeError);
  assert.throws(() => {
    JUDGE_AXES.push("overall");
  }, TypeError);
});

// ── (b) assertAxesNotCollapsed ───────────────────────────────────────────────

test("assertAxesNotCollapsed throws on a single averaged scalar", () => {
  assert.throws(() => assertAxesNotCollapsed(7.5), /distinct per-axis fields/);
  assert.throws(() => assertAxesNotCollapsed({ overallScore: 7.5 }), /originality.*feasibility.*distinct/s);
  assert.throws(() => assertAxesNotCollapsed(null), /distinct per-axis fields/);
  assert.throws(() => assertAxesNotCollapsed([7, 8, 9, 10]), /distinct per-axis fields/);
});

test("assertAxesNotCollapsed passes when both axes are distinct numeric fields", () => {
  assert.doesNotThrow(() =>
    assertAxesNotCollapsed({ originality: 8, feasibility: 4 }),
  );
});

test("assertAxesNotCollapsed throws if a composite field rides alongside the real axes", () => {
  assert.throws(
    () => assertAxesNotCollapsed({ originality: 5, feasibility: 5, overallScore: 5 }),
    /overallScore.*alongside/,
  );
});

test("assertAxesNotCollapsed throws if any axis is missing", () => {
  assert.throws(() => assertAxesNotCollapsed({ originality: 8 }), /originality.*feasibility.*distinct/s);
});

// ── (c) novelty (originality) and feasibility are distinct axes, never averaged ──

test("originality and feasibility are independent fields, not derived from one another", () => {
  const scores = { originality: 9, feasibility: 2 };
  assertAxesNotCollapsed(scores); // does not throw
  assert.notEqual(scores.originality, (scores.originality + scores.feasibility) / 2);
  // The scores object must not itself carry any averaged key.
  assert.ok(!("overallScore" in scores));
  assert.ok(!("novelty_feasibility_avg" in scores));
});

// ── AC2: judgePromptHash feeds configHash / cellKey, and reacts to a rubric edit ──

test("judgePromptHash is a deterministic sha256-12 of the frozen prompt", () => {
  const h1 = judgePromptHash();
  const h2 = judgePromptHash();
  assert.equal(h1, h2, "hashing the same frozen prompt twice must be deterministic");
  assert.match(h1, /^[0-9a-f]{12}$/);
});

test("AC2 — changing one character of JUDGE_PROMPT changes judgePromptHash, configHash, and cellKey", () => {
  const baseHash = judgePromptHash();

  // Simulate a one-character rubric edit by hashing a mutated COPY (JUDGE_PROMPT
  // itself is frozen and must stay that way — see the freeze test above).
  const mutated = JSON.parse(JSON.stringify(JUDGE_PROMPT));
  mutated.axes.originality.definition = mutated.axes.originality.definition.slice(0, -1) + "!";
  const mutatedHash = judgePromptHash(mutated);
  assert.notEqual(mutatedHash, baseHash, "a one-character rubric edit must change judgePromptHash");

  // Sanity: judgePromptHash itself matches the same sha256-12 convention used
  // by lib/manifest.mjs configHash / evals/corpus corpusHash.
  assert.equal(
    judgePromptHash(mutated),
    createHash("sha256").update(JSON.stringify(sortKeysDeep(mutated))).digest("hex").slice(0, 12),
  );

  // The load-bearing seam: judgeHash flows into configHash (lib/manifest.mjs
  // already reserves this field — see CONFIG_FIELDS) and therefore into cellKey.
  const cfgBefore = configHash({ harnessVersion: "0.0.1", engineSha: "abc", promptHash: "p1", judgeHash: baseHash });
  const cfgAfter = configHash({ harnessVersion: "0.0.1", engineSha: "abc", promptHash: "p1", judgeHash: mutatedHash });
  assert.notEqual(cfgBefore, cfgAfter, "a changed judgeHash must change configHash");

  const keyBefore = cellKey({ armId: "B", briefId: "b1", replicate: 0, cfg: cfgBefore });
  const keyAfter = cellKey({ armId: "B", briefId: "b1", replicate: 0, cfg: cfgAfter });
  assert.notEqual(keyBefore, keyAfter, "a changed judgeHash must change cellKey");
});

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}
