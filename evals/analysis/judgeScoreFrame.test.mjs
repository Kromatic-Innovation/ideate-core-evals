import { test } from "node:test";
import assert from "node:assert/strict";

import { makeTempStore } from "../../lib/store.mjs";
import { recordJudgeScores } from "../judge/score.mjs";
import { buildJudgeScoreFrame, JudgeScoresUnavailableError, JUDGE_SCORE_BIAS_COEFFICIENT } from "./judgeScoreFrame.mjs";

function seedPool(store, { poolKey, judgeModel, judgeProvider, scores }) {
  recordJudgeScores(store, { poolKey, judgeModel, judgeProvider, scores });
}

function threeCandidateScores(originalityBase) {
  return [
    { originality: originalityBase, feasibility: originalityBase + 1 },
    { originality: originalityBase + 2, feasibility: originalityBase - 1 },
    { originality: originalityBase - 1, feasibility: originalityBase },
  ];
}

test("buildJudgeScoreFrame: no judge-score records for any supplied pool -- throws JudgeScoresUnavailableError, never a fabricated frame", () => {
  const store = makeTempStore();
  const pools = [{ poolKey: "arm=A|brief=b1|rep=0|cfg=c1", armId: "A", generatorProviders: ["anthropic"] }];
  assert.throws(() => buildJudgeScoreFrame(store, { pools }), JudgeScoresUnavailableError);
});

test("buildJudgeScoreFrame: opts.pools is required and non-empty", () => {
  const store = makeTempStore();
  assert.throws(() => buildJudgeScoreFrame(store, {}), /opts\.pools is required/);
  assert.throws(() => buildJudgeScoreFrame(store, { pools: [] }), /opts\.pools is required/);
});

test("buildJudgeScoreFrame: one row per (pool x judge leg) -- 2 pools x 2 judge legs = 4 rows", () => {
  const store = makeTempStore();
  const poolA = "arm=A|brief=b1|rep=0|cfg=c1";
  const poolB = "arm=H|brief=b1|rep=0|cfg=c1";
  seedPool(store, { poolKey: poolA, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey: poolA, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: threeCandidateScores(4) });
  seedPool(store, { poolKey: poolB, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: threeCandidateScores(6) });
  seedPool(store, { poolKey: poolB, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: threeCandidateScores(7) });

  const pools = [
    { poolKey: poolA, armId: "A", generatorProviders: ["anthropic"] },
    { poolKey: poolB, armId: "H", generatorProviders: ["openai"] },
  ];
  const frame = buildJudgeScoreFrame(store, { pools });

  assert.equal(frame.rows.length, 4);
  assert.deepEqual(frame.judgeProviderLevels, ["anthropic", "openai"]);
  assert.equal(frame.responseField, "judge_score_mean");
});

test("buildJudgeScoreFrame: response is the mean of every axis/candidate score in that leg's record", () => {
  const store = makeTempStore();
  const poolKey = "arm=A|brief=b1|rep=0|cfg=c1";
  // mean of [5,6, 7,4, 4,5] = 31/6
  seedPool(store, {
    poolKey,
    judgeModel: "claude-sonnet-5",
    judgeProvider: "anthropic",
    scores: [
      { originality: 5, feasibility: 6 },
      { originality: 7, feasibility: 4 },
      { originality: 4, feasibility: 5 },
    ],
  });
  // A second judge_provider level is required (buildJudgeScoreFrame refuses
  // fewer than two — the bias term needs both), but this test is only about
  // the anthropic leg's own response value.
  seedPool(store, { poolKey, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: threeCandidateScores(3) });
  const pools = [{ poolKey, armId: "A", generatorProviders: ["anthropic"] }];
  const frame = buildJudgeScoreFrame(store, { pools });
  assert.equal(frame.rows.length, 2);
  const anthropicRow = frame.rows.find((r) => r.judgeProvider === "anthropic");
  assert.ok(Math.abs(anthropicRow.response - 31 / 6) < 1e-9);
});

test("buildJudgeScoreFrame: sameProvider is true iff judgeProvider is a member of that pool's generatorProviders", () => {
  const store = makeTempStore();
  const homogeneousPool = "arm=A|brief=b1|rep=0|cfg=c1";
  const mixedPool = "arm=G|brief=b1|rep=0|cfg=c1";
  seedPool(store, { poolKey: homogeneousPool, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey: homogeneousPool, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey: mixedPool, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey: mixedPool, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: threeCandidateScores(5) });

  const pools = [
    { poolKey: homogeneousPool, armId: "A", generatorProviders: ["anthropic"] },
    { poolKey: mixedPool, armId: "G", generatorProviders: ["anthropic", "openai"] },
  ];
  const frame = buildJudgeScoreFrame(store, { pools });

  const homoAnthropic = frame.rows.find((r) => r.poolKey === homogeneousPool && r.judgeProvider === "anthropic");
  const homoOpenai = frame.rows.find((r) => r.poolKey === homogeneousPool && r.judgeProvider === "openai");
  assert.equal(homoAnthropic.sameProvider, true);
  assert.equal(homoOpenai.sameProvider, false);

  // Arm G's mixed generatorProviders means BOTH legs read as sameProvider --
  // a disclosed scope limitation (see this module's header), not a bug.
  const mixedAnthropic = frame.rows.find((r) => r.poolKey === mixedPool && r.judgeProvider === "anthropic");
  const mixedOpenai = frame.rows.find((r) => r.poolKey === mixedPool && r.judgeProvider === "openai");
  assert.equal(mixedAnthropic.sameProvider, true);
  assert.equal(mixedOpenai.sameProvider, true);
});

test("buildJudgeScoreFrame: run grouping factor is the poolKey -- both judge legs of one pool share the same run", () => {
  const store = makeTempStore();
  const poolKey = "arm=A|brief=b1|rep=0|cfg=c1";
  seedPool(store, { poolKey, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: threeCandidateScores(5) });
  const pools = [{ poolKey, armId: "A", generatorProviders: ["anthropic"] }];
  const frame = buildJudgeScoreFrame(store, { pools });
  assert.equal(frame.rows.length, 2);
  assert.equal(frame.rows[0].run, poolKey);
  assert.equal(frame.rows[1].run, poolKey);
  assert.equal(frame.rows[0].run, frame.rows[1].run);
});

test("buildJudgeScoreFrame: a judge-score record for a pool NOT in opts.pools is ignored, not a hard error", () => {
  const store = makeTempStore();
  const known = "arm=A|brief=b1|rep=0|cfg=c1";
  const unknown = "arm=B|brief=b1|rep=0|cfg=c1";
  seedPool(store, { poolKey: known, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey: known, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey: unknown, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey: unknown, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: threeCandidateScores(5) });

  const pools = [{ poolKey: known, armId: "A", generatorProviders: ["anthropic"] }];
  const frame = buildJudgeScoreFrame(store, { pools });
  assert.equal(frame.rows.length, 2);
  assert.ok(frame.rows.every((r) => r.poolKey === known));
});

test("buildJudgeScoreFrame: only one distinct judge_provider level present -- throws JudgeScoresUnavailableError (bias term needs at least two)", () => {
  const store = makeTempStore();
  const poolA = "arm=A|brief=b1|rep=0|cfg=c1";
  const poolB = "arm=H|brief=b1|rep=0|cfg=c1";
  seedPool(store, { poolKey: poolA, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: threeCandidateScores(5) });
  seedPool(store, { poolKey: poolB, judgeModel: "claude-haiku-4-5", judgeProvider: "anthropic", scores: threeCandidateScores(5) });
  const pools = [
    { poolKey: poolA, armId: "A", generatorProviders: ["anthropic"] },
    { poolKey: poolB, armId: "H", generatorProviders: ["openai"] },
  ];
  assert.throws(() => buildJudgeScoreFrame(store, { pools }), JudgeScoresUnavailableError);
});

test("JUDGE_SCORE_BIAS_COEFFICIENT is the exact string contrasts.mjs/fit.mjs target", () => {
  assert.equal(JUDGE_SCORE_BIAS_COEFFICIENT, "judge_provider:generator_provider[T.same]");
});
