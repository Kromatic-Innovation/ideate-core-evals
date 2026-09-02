// Tests for issue #68 ("harness: judging is never invoked -- runJudgeMatrix
// has no non-test caller") and issue #74 ("a cell's cost row can be
// discarded after the API call already succeeded"), folded into the same
// PR per the coordinator's instruction (#74's genuine production trigger is
// a judge-model rate gap, only reachable once judging is wired in here).
//
// Hermetic -- every test gets its own temp ResultsStore dir, a fresh
// MockProvider (generation) and fresh MockJudgeProvider(s) (judging);
// nothing here touches a network or the real results/ directory.
//
// Acceptance criteria this file maps to (issue #68):
//   AC1 runSpec invokes judging for each completed pool, no manual step
//     -> "runSpec invokes judging for each completed pool"
//   AC2 judge cost rows reach recordActualSpend and can trip a per-provider
//     ceiling -> "judge cost rows reach recordActualSpend"
//   AC3 (part of AC2) a ceiling trips on judge spend SPECIFICALLY
//     -> the same test as AC2, isolated via a deferred openai leg
//   AC4 resumed runs project/meter judge cost for generated-but-unjudged
//     pools -> the "resume:" tests
//   AC5 reconcile() treats an unjudged pool as non-terminal
//     -> "an incomplete judging pass ... leaves runSpec() failing"
// Issue #74 (ordering): "issue #74:" tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ResultsStore } from "../../lib/store.mjs";
import { configHash, cellKey } from "../../lib/manifest.mjs";
import { runSpec, planAndPrice } from "./runner.mjs";
import { MockProvider } from "./provider.mjs";
import { MockJudgeProvider, judgeScoresKey } from "../judge/score.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-judging-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const silentLog = () => {};

const CFG = { harnessVersion: "0.0.1", engineSha: "test-sha", promptHash: "test-prompt", corpusHash: "test-corpus" };
const CFG_HASH = configHash(CFG);

// Generator models here (claude-sonnet-5, claude-haiku-4-5) are deliberately
// disjoint from JUDGE_MODELS below, so every judge leg is trivially distinct
// from its pool's own generators (assertEvaluatorDistinct never throws in
// these fixtures -- that guarantee is covered elsewhere, e.g.
// evals/judge/score.test.mjs and evals/judge/distinct.test.mjs).
const ARMS_CONFIG = {
  arms: {
    A: { mode: "solo", slots: [{ persona: "solo", model: "claude-sonnet-5" }] },
    B: {
      mode: "panel",
      slots: [
        { persona: "proposer_1", model: "claude-haiku-4-5" },
        { persona: "proposer_2", model: "claude-haiku-4-5" },
      ],
    },
  },
};
const SPEC = {
  arms: [{ id: "A" }, { id: "B" }],
  briefs: [{ id: "b1" }, { id: "b2" }],
  replicates: 1,
  config: CFG,
};
const CORPUS = [
  { id: "b1", text: "Brief one: propose a novel idea." },
  { id: "b2", text: "Brief two: propose a different novel idea." },
];
// Real, RATE_TABLE-backed model ids (lib/price.mjs) so recordActualSpend can
// price them -- both are used as GENERATOR models elsewhere in the study,
// but never by ARMS_CONFIG above, so distinctness is trivial here.
const JUDGE_MODELS = { anthropic: ["claude-opus-5"], openai: ["gpt-5.6-terra"] };

// ── AC1: runSpec invokes judging for each completed pool ────────────────────

test("runSpec invokes judging for each completed pool -- a single call goes generation -> judge with no manual step", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const anthropicJudge = new MockJudgeProvider();
  const openaiJudge = new MockJudgeProvider();

  const { summary } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: anthropicJudge, openai: openaiJudge },
    corpus: CORPUS,
    log: silentLog,
  });

  assert.equal(summary.completed, 4, "sanity: all 4 generation cells completed");
  assert.ok(summary.judge, "judging was enabled -- summary.judge is populated, not null");
  assert.equal(summary.judge.planned, 8, "4 pools x 2 judge legs (anthropic + openai) each");
  assert.equal(summary.judge.completed, 8, "every leg reached a terminal 'completed' state");
  assert.equal(anthropicJudge.calls.length, 4, "the anthropic judge was actually CALLED once per pool, not merely scheduled");
  assert.equal(openaiJudge.calls.length, 4, "the openai judge was actually called once per pool");
});

test("runSpec does NOT invoke judging when judgeModels is omitted -- generation-only callers/tests are unaffected", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  const { summary } = await runSpec(SPEC, { store, armsConfig: ARMS_CONFIG, provider, log: silentLog });

  assert.equal(summary.completed, 4);
  assert.equal(summary.judge, null, "judging disabled -- null, not an empty/zeroed object");
});

// ── AC5: reconcile() treats an unjudged pool as non-terminal, never a silent pass ──

test("an incomplete judging pass (a judge provider that throws outside the classified-failure contract) leaves runSpec() failing -- an unjudged pool is never a silent pass", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const anthropicJudge = new MockJudgeProvider();
  const throwingOpenaiJudge = {
    async score() {
      throw new Error("simulated judge transport crash outside the classified-failure contract");
    },
  };

  await assert.rejects(
    () =>
      runSpec(SPEC, {
        store,
        armsConfig: ARMS_CONFIG,
        provider,
        judgeModels: JUDGE_MODELS,
        judgeProviders: { anthropic: anthropicJudge, openai: throwingOpenaiJudge },
        corpus: CORPUS,
        armIds: ["A"],
        briefIds: ["b1"],
        log: silentLog,
      }),
    /simulated judge transport crash/,
    "a leg that can't reach a terminal state must abort the run, not silently complete it",
  );
});

// ── AC2/AC3: judge cost rows reach recordActualSpend and can trip a per-provider ceiling ──

test("judge cost rows reach recordActualSpend -- real judge spend (not generation spend) trips a per-provider ceiling for a LATER cell", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const anthropicJudge = new MockJudgeProvider();

  const soloArms = { arms: { A: ARMS_CONFIG.arms.A } };
  const soloSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }, { id: "b2" }], replicates: 1, config: CFG };

  // MockProvider's defaultCompletion deterministically returns 500 input /
  // 300 output tokens for every model slot (see provider.mjs) -- both
  // runnerPriceGrid and interimPriceGrid PROJECT a per-cell cost from an
  // assumed real-API token *volume* (thousands of tokens), which the mock
  // never actually produces, so "projected" and "actual" generation cost
  // disagree by construction with either of those and can't pin an exact
  // ceiling. Rather than hand-computing the expected price (which drifted
  // from the real run once already in review -- lib/price.mjs's RATE_TABLE
  // carries a time-limited `introRate` window, so a HARDCODED timestamp
  // silently prices differently than whatever `new Date().toISOString()`
  // the real per-cell loop stamps "now"), CALIBRATE empirically: run one
  // real cell with NO ceiling and read its ACTUAL spend back, so this
  // test's expectation always matches the SAME rate window the real run
  // below will price under, however RATE_TABLE evolves.
  const calibStore = new ResultsStore(tempDir(t));
  const calibSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const { summary: calibSummary } = await runSpec(calibSpec, { store: calibStore, armsConfig: soloArms, provider: new MockProvider(), log: silentLog });
  const perCellGenUsd = calibSummary.spendByProvider.anthropic;
  assert.ok(perCellGenUsd > 0, "sanity: the calibration run priced a positive generation cost");
  const exactPriceGrid = (plannedCells) => ({
    usd: plannedCells.length * perCellGenUsd,
    breakdown: plannedCells.map((c) => ({ cellKey: c.key, usd: perCellGenUsd, byProvider: { anthropic: perCellGenUsd } })),
  });
  // Ceiling covers BOTH cells' GENERATION with zero room for anything else.
  // If judge spend were excluded from the running total (the pre-#68 bug --
  // "no code path exists by which real judge spend can trip a ceiling"),
  // both cells would complete and the assertions below would fail.
  const ceiling = perCellGenUsd * 2;

  const { summary } = await runSpec(soloSpec, {
    store,
    armsConfig: soloArms,
    provider,
    priceGrid: exactPriceGrid,
    judgeModels: JUDGE_MODELS,
    // openai leg deliberately left unwired (deferred, $0) -- isolates the
    // ceiling trip to the ANTHROPIC judge leg's real spend specifically.
    judgeProviders: { anthropic: anthropicJudge },
    corpus: CORPUS,
    maxSpendByProviderUsd: { anthropic: ceiling },
    log: silentLog,
  });

  assert.ok(anthropicJudge.calls.length >= 1, "sanity: the judge was actually called for the first cell before the second was admission-controlled");
  assert.equal(summary.completed, 1, "only the FIRST cell's generation was admitted");
  assert.equal(summary.skipped, 1, "the SECOND cell's generation was skipped -- cell 1's JUDGE spend (not generation alone) pushed the running total over the ceiling");
});

test("a ceiling with headroom for judge spend as well as generation admits every cell -- proves the previous test's skip is caused by the ceiling, not an unrelated bug", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const anthropicJudge = new MockJudgeProvider();
  const soloArms = { arms: { A: ARMS_CONFIG.arms.A } };
  const soloSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }, { id: "b2" }], replicates: 1, config: CFG };

  const { summary } = await runSpec(soloSpec, {
    store,
    armsConfig: soloArms,
    provider,
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: anthropicJudge },
    corpus: CORPUS,
    maxSpendByProviderUsd: { anthropic: 1000 },
    log: silentLog,
  });

  assert.equal(summary.completed, 2, "ample headroom -- both cells' generation completed");
  assert.equal(summary.skipped, 0);
});

// ── AC4: resumed runs project and meter judge cost for generated-but-unjudged pools ──

test("resume: a session that generated but never judged has its unjudged pools judged on the NEXT invocation", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  await runSpec(SPEC, { store: store1, armsConfig: ARMS_CONFIG, provider: new MockProvider(), log: silentLog }); // generation only, no judging opted in

  const store2 = new ResultsStore(dir);
  const { plan } = planAndPrice(SPEC, { store: store2, armsConfig: ARMS_CONFIG });
  assert.equal(plan.todo.length, 0, "sanity: every generation cell is already stored -- nothing left to GENERATE");

  const anthropicJudge = new MockJudgeProvider();
  const openaiJudge = new MockJudgeProvider();
  const { summary } = await runSpec(SPEC, {
    store: store2,
    armsConfig: ARMS_CONFIG,
    provider: new MockProvider(),
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: anthropicJudge, openai: openaiJudge },
    corpus: CORPUS,
    log: silentLog,
  });

  assert.equal(summary.completed, 4, "the 4 already-generated cells are reused (free), not re-run");
  assert.equal(anthropicJudge.calls.length, 4, "all 4 reused-but-unjudged pools were judged THIS invocation -- the plan.todo blind spot does not apply to judging");
  assert.equal(openaiJudge.calls.length, 4);
  assert.equal(summary.judge.planned, 8);
  assert.equal(summary.judge.completed, 8);
});

test("resume: a pool already judged in a prior session is never re-judged -- idempotent, and store.put()'s byte-identical-or-throw guard is never exercised", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  const judge1a = new MockJudgeProvider();
  const judge1o = new MockJudgeProvider();
  await runSpec(SPEC, {
    store: store1,
    armsConfig: ARMS_CONFIG,
    provider: new MockProvider(),
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: judge1a, openai: judge1o },
    corpus: CORPUS,
    log: silentLog,
  });

  const store2 = new ResultsStore(dir);
  const judge2a = new MockJudgeProvider();
  const judge2o = new MockJudgeProvider();
  const { summary } = await runSpec(SPEC, {
    store: store2,
    armsConfig: ARMS_CONFIG,
    provider: new MockProvider(),
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: judge2a, openai: judge2o },
    corpus: CORPUS,
    log: silentLog,
  });

  assert.deepEqual(judge2a.calls, [], "no re-judging -- every leg was already scored in session 1");
  assert.deepEqual(judge2o.calls, []);
  assert.equal(summary.judge.planned, 8);
  assert.equal(summary.judge.completed, 8, "all legs still accounted for as complete, via the already-judged/'reused' path");

  // Every judge-scores record really does exist under the SAME key from
  // session 1 -- not silently skipped without a record either.
  const cellA = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  assert.ok(store2.has(judgeScoresKey({ poolKey: cellA, judgeModel: "claude-opus-5" })));
  assert.ok(store2.has(judgeScoresKey({ poolKey: cellA, judgeModel: "gpt-5.6-terra" })));
});

test("resume: a reused cell whose PRIOR generation FAILED is never judged (no candidates to judge), and the run still reconciles", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  const targetKey = cellKey({ armId: "B", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const overrides = new Map([[targetKey, { terminalState: "failed", failureKind: "empty_pool", detail: "candidates: []" }]]);
  await runSpec(SPEC, { store: store1, armsConfig: ARMS_CONFIG, provider: new MockProvider({ overrides }), log: silentLog });

  const store2 = new ResultsStore(dir);
  const anthropicJudge = new MockJudgeProvider();
  const openaiJudge = new MockJudgeProvider();
  const { summary } = await runSpec(SPEC, {
    store: store2,
    armsConfig: ARMS_CONFIG,
    provider: new MockProvider(),
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: anthropicJudge, openai: openaiJudge },
    corpus: CORPUS,
    log: silentLog,
  });

  assert.equal(summary.failed, 1, "the previously-failed cell is still failed, not silently upgraded");
  assert.equal(summary.completed, 3);
  assert.equal(summary.judge.planned, 6, "3 completed pools x 2 legs -- the failed cell contributes ZERO judge legs (no candidates to judge)");
  assert.equal(summary.judge.completed, 6);
  assert.equal(anthropicJudge.calls.length, 3, "the failed cell was never sent to the judge");
});

// ── issue #74 (folded in): a cell's cost row must survive a later missing-rate throw ──

test("issue #74: a completed cell's result and cost row survive in the store even though recordActualSpend then throws on a missing rate -- store.put() now runs BEFORE the fail-loud guard, not after", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const unratedArmsConfig = { arms: { NR: { mode: "panel", slots: [{ persona: "proposer_1", model: "claude-fake-model-74" }] } } };
  const unratedSpec = { arms: [{ id: "NR" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const targetKey = cellKey({ armId: "NR", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const provider = new MockProvider();
  // Stands in for the pre-flight pricer (which would otherwise reject an
  // unknown model before the provider is ever called) -- same shape as
  // runner.test.mjs's "issue #62 MEDIUM" fixture, isolating the failure
  // under test to the ACTUAL-spend path, after the provider responded (i.e.
  // after real money would have been spent against a live API).
  const fakePriceGrid = (plannedCells) => ({
    usd: plannedCells.length,
    breakdown: plannedCells.map((c) => ({ cellKey: c.key, usd: 1, byProvider: { anthropic: 1 } })),
  });

  await assert.rejects(
    () =>
      runSpec(unratedSpec, {
        store,
        armsConfig: unratedArmsConfig,
        provider,
        priceGrid: fakePriceGrid,
        maxSpendByProviderUsd: { anthropic: 1000 },
        log: silentLog,
      }),
    /no RATE_TABLE entry/,
  );

  assert.ok(store.has(targetKey), "issue #74: the cell's result was NOT discarded by the missing-rate throw -- money already spent is durably recorded");
  const stored = store.get(targetKey);
  assert.equal(stored.accounting.state, "completed");
  assert.ok(Array.isArray(stored.costRows) && stored.costRows.length > 0, "the cost row itself also survived, not just the result");
});

test("issue #74: the genuine production trigger -- a judge-model RATE_TABLE gap (reachable only once #68 wires judging in) also survives the fail-loud throw", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const soloArms = { arms: { A: ARMS_CONFIG.arms.A } };
  const soloSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const targetKey = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const provider = new MockProvider();
  const anthropicJudge = new MockJudgeProvider();
  const openaiJudge = new MockJudgeProvider();
  // A judge model with a RATE_TABLE gap -- matrix.mjs's distinctness check
  // doesn't care about pricing, so this schedules fine; recordActualSpend
  // is what throws, per issue #74's corrected reproduction (only reachable
  // via a judge-model gap now that #68 wires judging in).
  const rateGapJudgeModels = { anthropic: ["claude-unrated-judge-74"], openai: ["gpt-5.6-terra"] };

  await assert.rejects(
    () =>
      runSpec(soloSpec, {
        store,
        armsConfig: soloArms,
        provider,
        judgeModels: rateGapJudgeModels,
        judgeProviders: { anthropic: anthropicJudge, openai: openaiJudge },
        corpus: CORPUS,
        maxSpendByProviderUsd: { anthropic: 1000 },
        log: silentLog,
      }),
    /no RATE_TABLE entry/,
  );

  // The GENERATION cell's own result must still be intact -- generation
  // itself never touched a rate-less model here; only the downstream judge
  // call did, and that must not retroactively undo generation's own,
  // already-persisted record.
  assert.ok(store.has(targetKey), "the generation cell's result was not discarded by the judge-side missing-rate throw");
  assert.equal(store.get(targetKey).accounting.state, "completed");
});
