// Tests for the cross-judge matrix (issue #4, AC6): every pool gets exactly
// one Anthropic and one OpenAI judge, each verified distinct from the arm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { providerOf, buildJudgeMatrix } from "./matrix.mjs";
import { assertEvaluatorDistinct } from "./distinct.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARMS_CONFIG = JSON.parse(readFileSync(join(__dirname, "..", "..", "arms.config.json"), "utf8"));

const ARM_B = { id: "B", ...ARMS_CONFIG.arms.B }; // all-haiku
const ARM_D = { id: "D", ...ARMS_CONFIG.arms.D }; // all-opus
const ARM_H = { id: "H", ...ARMS_CONFIG.arms.H }; // all-gpt-5.6-terra

const JUDGE_MODELS = {
  anthropic: ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"],
  openai: ["gpt-5.6-sol", "gpt-5.6-terra"],
};

test("providerOf infers anthropic / openai from model id prefix", () => {
  assert.equal(providerOf("claude-sonnet-5"), "anthropic");
  assert.equal(providerOf("claude-haiku-4-5"), "anthropic");
  assert.equal(providerOf("gpt-5.6-terra"), "openai");
  assert.equal(providerOf("gpt-4.1"), "openai");
  assert.throws(() => providerOf("mystery-model"), /cannot infer a provider/);
  assert.throws(() => providerOf(""), /non-empty string/);
});

test("AC6 — the matrix schedules exactly 2 judge calls per pool with distinct providers", () => {
  const pools = [
    { poolKey: "arm=B|brief=b1", arm: ARM_B },
    { poolKey: "arm=D|brief=b1", arm: ARM_D },
  ];
  const rows = buildJudgeMatrix(pools, { judgeModels: JUDGE_MODELS });
  assert.equal(rows.length, pools.length * 2, "exactly 2 rows per pool");

  for (const pool of pools) {
    const rowsForPool = rows.filter((r) => r.poolKey === pool.poolKey);
    assert.equal(rowsForPool.length, 2);
    const providers = rowsForPool.map((r) => r.judge_provider).sort();
    assert.deepEqual(providers, ["anthropic", "openai"], "each pool gets one anthropic + one openai judge");
  }
});

test("AC6 — every scheduled judge passes distinctness against its pool's arm", () => {
  const pools = [
    { poolKey: "arm=B|brief=b1", arm: ARM_B },
    { poolKey: "arm=D|brief=b1", arm: ARM_D },
  ];
  const rows = buildJudgeMatrix(pools, { judgeModels: JUDGE_MODELS });
  for (const row of rows) {
    const arm = pools.find((p) => p.poolKey === row.poolKey).arm;
    assert.doesNotThrow(() => assertEvaluatorDistinct(row.judge_model, arm), `row for ${row.poolKey}/${row.judge_provider} must be distinct`);
  }
});

test("arm B (all-haiku) gets an anthropic judge that is sonnet or opus, never haiku", () => {
  const rows = buildJudgeMatrix([{ poolKey: "arm=B|brief=b1", arm: ARM_B }], { judgeModels: JUDGE_MODELS });
  const anthropicRow = rows.find((r) => r.judge_provider === "anthropic");
  assert.ok(["claude-sonnet-5", "claude-opus-5"].includes(anthropicRow.judge_model));
});

test("rows carry generator_providers reflecting the arm's own slot providers", () => {
  const rows = buildJudgeMatrix([{ poolKey: "arm=B|brief=b1", arm: ARM_B }], { judgeModels: JUDGE_MODELS });
  for (const row of rows) {
    assert.deepEqual(row.generator_providers, ["anthropic"]);
  }
  // Arm G (real arms.config.json shape) uses all three Anthropic tiers
  // (haiku/sonnet/opus) plus OpenAI -- confirm generator_providers reports
  // BOTH providers for a genuinely mixed arm, using a synthetic arm object
  // with a 4th Anthropic tier available as a judge candidate (arms.config.json
  // itself has no such tier, so a real G pool can never get an anthropic
  // judge from a 3-tier candidate list -- see the "no distinct judge" test
  // below, which covers that real-world exhaustion case for arm H).
  const mixedArm = {
    id: "G",
    slots: [
      { persona: "proposer_1", model: "claude-haiku-4-5" },
      { persona: "proposer_2", model: "claude-sonnet-5" },
      { persona: "proposer_3", model: "claude-opus-5" },
      { persona: "proposer_4", model: "gpt-5.6-terra" },
      { persona: "proposer_5", model: "gpt-5.6-sol" },
    ],
  };
  const wideJudgeModels = { anthropic: ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5", "claude-sonnet-4"], openai: ["openai-small-tier"] };
  const gRows = buildJudgeMatrix([{ poolKey: "arm=G|brief=b1", arm: mixedArm }], { judgeModels: wideJudgeModels });
  for (const row of gRows) {
    assert.deepEqual(new Set(row.generator_providers), new Set(["anthropic", "openai"]));
  }
});

test("throws when no distinct judge exists for a provider", () => {
  // ARM_H uses gpt-5.6-terra for every slot; if the ONLY openai candidate is
  // gpt-5.6-terra, no distinct openai judge exists for this arm.
  assert.throws(
    () => buildJudgeMatrix([{ poolKey: "arm=H|brief=b1", arm: ARM_H }], { judgeModels: { anthropic: ["claude-sonnet-5"], openai: ["gpt-5.6-terra"] } }),
    /no distinct openai judge available/,
  );
});

test("throws on malformed input", () => {
  assert.throws(() => buildJudgeMatrix("not-an-array", { judgeModels: JUDGE_MODELS }), /pools must be an array/);
  assert.throws(() => buildJudgeMatrix([{ poolKey: "x", arm: ARM_B }], {}), /judgeModels.*required/);
  assert.throws(() => buildJudgeMatrix([{ arm: ARM_B }], { judgeModels: JUDGE_MODELS }), /poolKey, arm/);
});
