// Tests for the local assertEvaluatorDistinct (issue #4, AC5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertEvaluatorDistinct } from "./distinct.mjs";

const ARM_D_ALL_OPUS = {
  slots: [
    { persona: "proposer_1", model: "claude-opus-5" },
    { persona: "proposer_2", model: "claude-opus-5" },
    { persona: "proposer_3", model: "claude-opus-5" },
    { persona: "proposer_4", model: "claude-opus-5" },
    { persona: "proposer_5", model: "claude-opus-5" },
  ],
};

const ARM_G_CROSS_PROVIDER = {
  slots: [
    { persona: "proposer_1", model: "claude-haiku-4-5" },
    { persona: "proposer_2", model: "claude-sonnet-5" },
    { persona: "proposer_3", model: "claude-opus-5" },
    { persona: "proposer_4", model: "openai-mid-tier" },
    { persona: "proposer_5", model: "openai-large-tier" },
  ],
};

test("throws when the judge model is a generator model in the arm", () => {
  assert.throws(() => assertEvaluatorDistinct("claude-opus-5", ARM_D_ALL_OPUS), /judge must never score output produced by itself/);
  assert.throws(() => assertEvaluatorDistinct("openai-mid-tier", ARM_G_CROSS_PROVIDER), /judge must never score output produced by itself/);
});

test("does not throw when the judge model is distinct from every generator in the arm", () => {
  assert.doesNotThrow(() => assertEvaluatorDistinct("claude-sonnet-5", ARM_D_ALL_OPUS));
  assert.doesNotThrow(() => assertEvaluatorDistinct("claude-haiku-4-5", ARM_D_ALL_OPUS));
  assert.doesNotThrow(() => assertEvaluatorDistinct("openai-large-tier", ARM_D_ALL_OPUS));
});

test("throws for malformed input", () => {
  assert.throws(() => assertEvaluatorDistinct("", ARM_D_ALL_OPUS), /judgeModel must be a non-empty string/);
  assert.throws(() => assertEvaluatorDistinct("claude-opus-5", {}), /arm must be an arms\.config\.json arm object/);
  assert.throws(() => assertEvaluatorDistinct("claude-opus-5", null), /arm must be an arms\.config\.json arm object/);
});
