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

test("Sentry HIGH finding (PR #76 fix round): judge spend also trips the GLOBAL --max-spend ceiling, not only a per-provider one -- runningTotal now tracks ACTUAL spend, not a stale projected increment", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const anthropicJudge = new MockJudgeProvider();

  const soloArms = { arms: { A: ARMS_CONFIG.arms.A } };
  const soloSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }, { id: "b2" }], replicates: 1, config: CFG };

  // Same calibration technique as the per-provider ceiling test above:
  // learn the REAL per-cell generation cost empirically (MockProvider's
  // fixed 500/300 tokens don't match either pricer's token-VOLUME estimate,
  // so a hand-computed or projected number would drift from what
  // recordActualSpend will actually compute -- see that test's own comment).
  const calibStore = new ResultsStore(tempDir(t));
  const calibSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const { summary: calibSummary } = await runSpec(calibSpec, { store: calibStore, armsConfig: soloArms, provider: new MockProvider(), log: silentLog });
  const perCellGenUsd = calibSummary.spendByProvider.anthropic;
  assert.ok(perCellGenUsd > 0);
  const exactPriceGrid = (plannedCells) => ({
    usd: plannedCells.length * perCellGenUsd,
    breakdown: plannedCells.map((c) => ({ cellKey: c.key, usd: perCellGenUsd, byProvider: { anthropic: perCellGenUsd } })),
  });
  // GLOBAL ceiling (maxSpendUsd, not maxSpendByProviderUsd) covering BOTH
  // cells' generation with zero room for anything else. If judge spend were
  // excluded from the GLOBAL running total (the bug: `runningTotal` was
  // bumped only by PROJECTED cellCost at admission time, never by actual
  // spend afterward), both cells would complete.
  const ceiling = perCellGenUsd * 2;

  const { summary } = await runSpec(soloSpec, {
    store,
    armsConfig: soloArms,
    provider,
    priceGrid: exactPriceGrid,
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: anthropicJudge }, // openai deferred, $0 -- isolates the trip to anthropic judge spend
    corpus: CORPUS,
    maxSpendUsd: ceiling, // GLOBAL ceiling this time, not per-provider
    log: silentLog,
  });

  assert.ok(anthropicJudge.calls.length >= 1, "sanity: the judge ran for the first cell before the second was admission-controlled");
  assert.equal(summary.completed, 1, "only the FIRST cell's generation was admitted under the GLOBAL ceiling");
  assert.equal(summary.skipped, 1, "the SECOND cell was skipped -- cell 1's judge spend pushed the GLOBAL running total over the ceiling");
});

// ── AC4: resumed runs project and meter judge cost for generated-but-unjudged pools ────

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

// ── PR #76 fix round: a judge leg that fails WITH TOKENS CONSUMED must not brick the store on resume ──
//
// evals/judge/score.mjs's AnthropicJudgeProvider threads ONE mutable
// `tokens` accumulator through its whole call and classifies the outcome
// only afterward, so a rate_limited/timeout/transport_error/parse_failure
// leaves REAL, non-zero usage on the failed response -- MockJudgeProvider's
// `failFor` reproduces the identical shape (tokens are always computed from
// the payload BEFORE the forced-failure check runs). Before this fix,
// meterJudgeCall's key carried no attempt discriminator, so a resumed retry
// of that SAME leg collided with the orphaned judge-call row from the
// failed attempt and lib/store.mjs's append-only put() threw -- permanently,
// since the store has no delete API.

test("BLOCKING (PR #76 fix round): a judge leg that fails with tokens consumed resumes and retries cleanly -- no store-bricking key collision on retry", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  const provider = new MockProvider();
  // Forces the anthropic leg to fail as rate_limited -- MockJudgeProvider
  // still computes real tokens from the payload before checking `failFor`
  // (see score.mjs), so this leg fails WITH consumed tokens, exactly the
  // shape that bricked the store pre-fix.
  const failingJudge = new MockJudgeProvider({ failFor: new Map([["claude-opus-5", { failureKind: "rate_limited" }]]) });

  const soloArms = { arms: { A: ARMS_CONFIG.arms.A } };
  const soloSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };

  const { summary: summary1 } = await runSpec(soloSpec, {
    store: store1,
    armsConfig: soloArms,
    provider,
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: failingJudge },
    corpus: CORPUS,
    log: silentLog,
  });
  assert.equal(summary1.judge.failed, 1, "sanity: the anthropic leg failed (forced rate_limited)");

  const cellA = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  assert.equal(store1.has(judgeScoresKey({ poolKey: cellA, judgeModel: "claude-opus-5" })), false, "sanity: no scores were written -- the leg failed before scoring");
  assert.ok(store1.has("judge-call|cell=" + cellA + "|judge=claude-opus-5|attempt=0"), "tokens consumed by the failed attempt were still metered (attempt 0)");

  // Resume: a FRESH session, a HEALTHY judge this time. Pre-fix, this threw
  // on the store collision -- the store was permanently bricked by session
  // 1's single 429.
  const store2 = new ResultsStore(dir);
  const healthyJudge = new MockJudgeProvider();
  const { summary: summary2 } = await runSpec(soloSpec, {
    store: store2,
    armsConfig: soloArms,
    provider: new MockProvider(),
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: healthyJudge },
    corpus: CORPUS,
    log: silentLog,
  });

  assert.equal(healthyJudge.calls.length, 1, "the leg was retried exactly once, cleanly -- no throw");
  assert.equal(summary2.judge.completed, 1, "the anthropic leg is now complete");
  assert.ok(store2.has(judgeScoresKey({ poolKey: cellA, judgeModel: "claude-opus-5" })), "scores now exist");
  assert.ok(store2.has("judge-call|cell=" + cellA + "|judge=claude-opus-5|attempt=1"), "the retry's spend landed under its OWN attempt-scoped row, not a collision with attempt 0");

  // Both attempts' spend is durably preserved -- the honest model: a retry
  // genuinely spent more money and deserves its own row, never collapsed
  // away or lost.
  const attempt0Row = store2.get("judge-call|cell=" + cellA + "|judge=claude-opus-5|attempt=0").costRows[0];
  const attempt1Row = store2.get("judge-call|cell=" + cellA + "|judge=claude-opus-5|attempt=1").costRows[0];
  assert.ok(attempt0Row.input_tokens > 0, "attempt 0's spend (the failed call) is still on record");
  assert.ok(attempt1Row.input_tokens > 0, "attempt 1's spend (the retry) is a SEPARATE record");
});

test("N1 mirror (PR #76 fix round): a leg interrupted BETWEEN the money-first cost-row write and the scores write never loses its cost row, and the retry gets its own attempt-scoped row", async (t) => {
  const dir = tempDir(t);
  const realStore1 = new ResultsStore(dir);
  // Simulates a crash between meterJudgeCall's write (money-first) and
  // recordJudgeScores' write -- everything else passes through to the real
  // store untouched.
  const crashingStore = {
    keys: (...a) => realStore1.keys(...a),
    has: (...a) => realStore1.has(...a),
    list: (...a) => realStore1.list(...a),
    get: (...a) => realStore1.get(...a),
    put: (record) => {
      if (record.key.startsWith("judge-scores|")) {
        throw new Error("SIMULATED CRASH between the money-first judge-call write and the judge-scores write");
      }
      return realStore1.put(record);
    },
  };
  const provider = new MockProvider();
  const anthropicJudge = new MockJudgeProvider();
  const soloArms = { arms: { A: ARMS_CONFIG.arms.A } };
  const soloSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };

  await assert.rejects(
    () =>
      runSpec(soloSpec, {
        store: crashingStore,
        armsConfig: soloArms,
        provider,
        judgeModels: JUDGE_MODELS,
        judgeProviders: { anthropic: anthropicJudge },
        corpus: CORPUS,
        log: silentLog,
      }),
    /SIMULATED CRASH/,
  );

  const cellA = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const attempt0Key = "judge-call|cell=" + cellA + "|judge=claude-opus-5|attempt=0";
  // Read back via the REAL store directly (bypassing the crashing wrapper) --
  // money-first ordering means the cost row survived the simulated crash.
  assert.ok(realStore1.has(attempt0Key), "the FIRST attempt's judge-call cost row survived the crash (money-first ordering)");
  assert.equal(realStore1.has(judgeScoresKey({ poolKey: cellA, judgeModel: "claude-opus-5" })), false, "scores were never written -- the crash happened before that write");

  // Resume against the SAME (real, non-crashing) store: the leg is retried
  // cleanly -- no collision with the surviving attempt-0 row, and the
  // FIRST attempt's spend is never silently dropped.
  const store2 = new ResultsStore(dir);
  const anthropicJudge2 = new MockJudgeProvider();
  const { summary } = await runSpec(soloSpec, {
    store: store2,
    armsConfig: soloArms,
    provider: new MockProvider(),
    judgeModels: JUDGE_MODELS,
    judgeProviders: { anthropic: anthropicJudge2 },
    corpus: CORPUS,
    log: silentLog,
  });

  assert.equal(anthropicJudge2.calls.length, 1, "the leg was retried exactly once");
  assert.equal(summary.judge.completed, 1, "the anthropic leg is now complete");
  assert.ok(store2.has(judgeScoresKey({ poolKey: cellA, judgeModel: "claude-opus-5" })), "scores now exist, written by the retry");
  const attempt1Key = "judge-call|cell=" + cellA + "|judge=claude-opus-5|attempt=1";
  assert.ok(store2.has(attempt1Key), "the retry got its OWN attempt-scoped row, not a collision with the surviving attempt-0 row");
  assert.ok(store2.has(attempt0Key), "the pre-crash attempt-0 row is STILL present -- its spend was never lost");
});

// ── N2: issue #74's fix must cover the FAILED branch too, not only completed ──

test("N2: issue #74's ordering fix also covers the FAILED generation branch -- a failed cell's result and cost row survive a subsequent missing-rate throw", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const unratedArmsConfig = { arms: { NR: { mode: "panel", slots: [{ persona: "proposer_1", model: "claude-fake-model-74-failed" }] } } };
  const unratedSpec = { arms: [{ id: "NR" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const targetKey = cellKey({ armId: "NR", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  // Forces the FAILED branch specifically -- MockProvider's defaultCompletion
  // still reports real tokens_by_model for the rate-less model regardless of
  // terminalState (a failed call can still have consumed real tokens -- see
  // costRowsFor's own caller comment in runner.mjs), so this fails on the
  // SAME missing-rate guard the completed-branch test above exercises, but
  // via the `else` branch of the per-cell loop.
  const overrides = new Map([[targetKey, { terminalState: "failed", failureKind: "empty_pool", detail: "forced failure with tokens consumed" }]]);
  const provider = new MockProvider({ overrides });
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

  assert.ok(store.has(targetKey), "N2: the FAILED cell's result was NOT discarded by the missing-rate throw");
  const stored = store.get(targetKey);
  assert.equal(stored.accounting.state, "failed");
  assert.ok(Array.isArray(stored.costRows) && stored.costRows.length > 0, "the cost row itself also survived, not just the result");
});

// ── N6: the unknown-arm guard (armsConfig.arms[cell.armId] missing on resume) fails loud ──

test("N6: a reused cell whose arm was removed from armsConfig between sessions fails loud when judging tries to look it up, rather than crashing on a bare undefined", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  const armsWithZ = { arms: { ...ARMS_CONFIG.arms, Z: { mode: "solo", slots: [{ persona: "solo", model: "claude-haiku-4-5" }] } } };
  const specWithZ = { arms: [{ id: "Z" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  await runSpec(specWithZ, { store: store1, armsConfig: armsWithZ, provider: new MockProvider(), log: silentLog });

  // Session 2: arm Z has been removed from arms.config.json (armsConfig no
  // longer defines it), but the store still has a completed cell for it.
  const store2 = new ResultsStore(dir);
  await assert.rejects(
    () =>
      runSpec(specWithZ, {
        store: store2,
        armsConfig: ARMS_CONFIG, // no arm Z
        provider: new MockProvider(),
        judgeModels: JUDGE_MODELS,
        judgeProviders: { anthropic: new MockJudgeProvider(), openai: new MockJudgeProvider() },
        corpus: CORPUS,
        log: silentLog,
      }),
    /unknown arm 'Z'/,
  );
});
