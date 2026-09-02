// Tests for the cross-judge matrix (issue #4, AC6): every pool gets exactly
// one Anthropic and one OpenAI judge, each verified distinct from the arm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { providerOf, buildJudgeMatrix, judgeLegsFor } from "./matrix.mjs";
import { providerOf as providerOfFromPrice } from "../../lib/price.mjs";
import { assertEvaluatorDistinct } from "./distinct.mjs";
import { JUDGE_MODELS as REGISTERED_JUDGE_MODELS } from "./config.mjs";

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

test("issue #62 HIGH: matrix.mjs's providerOf IS lib/price.mjs's providerOf, not a second implementation that could silently diverge", () => {
  assert.equal(providerOf, providerOfFromPrice, "matrix.mjs re-exports the single canonical implementation rather than re-deriving the prefix rule");
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

// ── issue #45 item 4: EMPIRICALLY verify every arm in arms.config.json is
//    judgeable, using the REGISTERED candidate lists (config.mjs JUDGE_MODELS)
//    — not a synthetic candidate list. Before #45, no test ever ran
//    buildJudgeMatrix against the real arms.config.json arms at all, so
//    arm G's (and arm E's — see config.mjs's comment) throw was unverified. ──

test("issue #45 item 4 — buildJudgeMatrix constructs a valid schedule for EVERY arm in arms.config.json, including G", () => {
  for (const [armId, armCfg] of Object.entries(ARMS_CONFIG.arms)) {
    const arm = { id: armId, ...armCfg };
    const pool = [{ poolKey: `arm=${armId}|brief=b1`, arm }];
    let rows;
    assert.doesNotThrow(
      () => (rows = buildJudgeMatrix(pool, { judgeModels: REGISTERED_JUDGE_MODELS })),
      `buildJudgeMatrix must not throw for arm ${armId} with the registered judge candidate lists`,
    );
    assert.equal(rows.length, 2, `arm ${armId} must get exactly one anthropic + one openai judge row`);
    const providers = rows.map((r) => r.judge_provider).sort();
    assert.deepEqual(providers, ["anthropic", "openai"]);
    for (const row of rows) {
      assert.doesNotThrow(() => assertEvaluatorDistinct(row.judge_model, arm), `arm ${armId}'s ${row.judge_provider} judge must be distinct from its own generators`);
    }
  }
});

test("issue #45 item 4 — WITHOUT the reserved fallback models, arm E and arm G are unjudgeable (regression proof the fix is load-bearing)", () => {
  const naiveJudgeModels = {
    anthropic: ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"],
    openai: ["gpt-5.6-terra", "gpt-5.6-sol"],
  };
  for (const armId of ["E", "G"]) {
    const arm = { id: armId, ...ARMS_CONFIG.arms[armId] };
    assert.throws(
      () => buildJudgeMatrix([{ poolKey: `arm=${armId}|brief=b1`, arm }], { judgeModels: naiveJudgeModels }),
      /no distinct anthropic judge available/,
      `arm ${armId} exhausts every naive anthropic candidate`,
    );
  }
});

test("throws on malformed input", () => {
  assert.throws(() => buildJudgeMatrix("not-an-array", { judgeModels: JUDGE_MODELS }), /pools must be an array/);
  assert.throws(() => buildJudgeMatrix([{ poolKey: "x", arm: ARM_B }], {}), /judgeModels.*required/);
  assert.throws(() => buildJudgeMatrix([{ arm: ARM_B }], { judgeModels: JUDGE_MODELS }), /poolKey, arm/);
});

// ── judgeLegsFor: the lib/price.mjs runnerPriceGrid adapter (issue #63 fix round) ──
const PANEL_CONFIG = ARMS_CONFIG.panel; // { size: 5, ideasPerAgent: 6, ... }

test("judgeLegsFor resolves the SAME two legs buildJudgeMatrix would schedule for a pool, never a second selection rule", () => {
  const legsFor = judgeLegsFor({ judgeModels: REGISTERED_JUDGE_MODELS, panelConfig: PANEL_CONFIG });
  const cell = { key: "arm=B|brief=b1", armId: "B" };
  const arm = ARMS_CONFIG.arms.B;
  const legs = legsFor(cell, arm);

  const expectedRows = buildJudgeMatrix([{ poolKey: cell.key, arm: { id: cell.armId, ...arm } }], { judgeModels: REGISTERED_JUDGE_MODELS });
  assert.equal(legs.length, 2);
  const byProvider = Object.fromEntries(legs.map((l) => [l.provider, l.model]));
  const expectedByProvider = Object.fromEntries(expectedRows.map((r) => [r.judge_provider, r.judge_model]));
  assert.deepEqual(byProvider, expectedByProvider);
});

test("judgeLegsFor's candidateCount matches panel.size x panel.ideasPerAgent x panel.maxRounds for a panel arm -- round 2 APPENDS to round 1, it does not replace it, so maxRounds is a required factor", () => {
  const legsFor = judgeLegsFor({ judgeModels: REGISTERED_JUDGE_MODELS, panelConfig: PANEL_CONFIG });
  const legs = legsFor({ key: "arm=B|brief=b1", armId: "B" }, ARMS_CONFIG.arms.B);
  assert.equal(PANEL_CONFIG.maxRounds, 2, "this study's panel.maxRounds must be 2 for this test to actually exercise the factor (a dropped-maxRounds regression would under-project by exactly 2x)");
  const expected = PANEL_CONFIG.size * PANEL_CONFIG.ideasPerAgent * PANEL_CONFIG.maxRounds;
  for (const leg of legs) assert.equal(leg.candidateCount, expected);
});

test("judgeLegsFor's candidateCount uses totalIdeasRequested for a solo arm, NEVER the panel formula -- solo and panel diverge once maxRounds > 1", () => {
  const legsFor = judgeLegsFor({ judgeModels: REGISTERED_JUDGE_MODELS, panelConfig: PANEL_CONFIG });
  const legs = legsFor({ key: "arm=A|brief=b1", armId: "A" }, ARMS_CONFIG.arms.A);
  const panelFormula = PANEL_CONFIG.size * PANEL_CONFIG.ideasPerAgent * PANEL_CONFIG.maxRounds;
  for (const leg of legs) {
    assert.equal(leg.candidateCount, ARMS_CONFIG.arms.A.totalIdeasRequested);
    // A mutant that drops the solo-arm branch entirely (always applying the
    // panel formula) previously SURVIVED, because the old (maxRounds-less)
    // panel formula (5 x 6 = 30) coincidentally equalled arm A's total (30).
    // With maxRounds folded in, panel = 60 and solo = 30 genuinely diverge,
    // so that mutant is caught here.
    assert.notEqual(leg.candidateCount, panelFormula, "solo (30) must not equal the panel formula's result (60) -- a dropped solo-arm branch must be caught");
  }
});

test("judgeLegsFor throws for an arm that exhausts every candidate, exactly like buildJudgeMatrix (the pre-flight can't project a cost for a matrix that would fail to schedule)", () => {
  const legsFor = judgeLegsFor({ judgeModels: { anthropic: ["claude-sonnet-5"], openai: ["gpt-5.6-terra"] }, panelConfig: PANEL_CONFIG });
  assert.throws(() => legsFor({ key: "arm=H|brief=b1", armId: "H" }, ARMS_CONFIG.arms.H), /no distinct openai judge available/);
});

test("judgeLegsFor requires judgeModels and panelConfig", () => {
  assert.throws(() => judgeLegsFor({ panelConfig: PANEL_CONFIG }), /judgeModels.*required/);
  assert.throws(() => judgeLegsFor({ judgeModels: REGISTERED_JUDGE_MODELS }), /panelConfig.*required/);
});
