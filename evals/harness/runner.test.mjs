// Tests for the runner (issue #5): batch-first execution, --max-spend,
// --dry-run, and resume. Hermetic -- every test gets its own temp
// ResultsStore dir and a fresh MockProvider; nothing here touches a network
// or the real results/ directory.
//
// Acceptance criteria mapped to their test names (see the final section):
//   AC1 --dry-run prints a plan and spends nothing        -> "dry-run ..."
//   AC2 --max-spend below projection aborts before any call -> "max-spend below projection ..."
//   AC3 killing + restarting re-runs only incomplete cells -> "resume: a killed run ..."
//   AC4 a forced provider failure surfaces as classified failed -> "a forced provider failure ..."
//   AC5 integration test with mock provider covers the full path -> integration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ResultsStore } from "../../lib/store.mjs";
import { configHash, cellKey, planRun } from "../../lib/manifest.mjs";
import { costRow } from "../../lib/accounting.mjs";
import { priceRowByProvider, priceRowsByProvider } from "../../lib/price.mjs";
import { runSpec, planAndPrice, interimPriceGrid, spendToDate } from "./runner.mjs";
import { MockProvider } from "./provider.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-runner-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CFG = { harnessVersion: "0.0.1", engineSha: "test-sha", promptHash: "test-prompt", corpusHash: "test-corpus" };
const CFG_HASH = configHash(CFG);

const ARMS_CONFIG = {
  arms: {
    A: {
      mode: "solo",
      slots: [{ persona: "solo", model: "claude-sonnet-5" }],
    },
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

// ── issue #51: per-provider --max-spend fixtures ────────────────────────
// H2 (Anthropic-only panel), H3 (OpenAI-only panel), and G2 (a small arm-G
// shape: 1 Anthropic + 1 OpenAI slot, cross-provider IN ONE CELL) -- enough
// to exercise per-provider admission control and the mixed-arm attribution
// case without the real study's full 5-slot panels.
const ARMS_CONFIG_PROVIDERS = {
  arms: {
    H2: {
      mode: "panel",
      slots: [{ persona: "proposer_1", model: "claude-haiku-4-5" }],
    },
    H3: {
      mode: "panel",
      slots: [{ persona: "proposer_1", model: "gpt-5.6-terra" }],
    },
    G2: {
      mode: "panel",
      slots: [
        { persona: "proposer_1", model: "claude-opus-5" },
        { persona: "proposer_2", model: "gpt-5.6-sol" },
      ],
    },
  },
};
const SPEC_PROVIDERS = {
  arms: [{ id: "H2" }, { id: "H3" }, { id: "G2" }],
  briefs: [{ id: "b1" }],
  replicates: 1,
  config: CFG,
};

const silentLog = () => {};

// ── AC1: --dry-run prints a plan and spends nothing ─────────────────────────

test("dry-run on the full grid prints a plan and spends nothing -- no store writes, no provider calls", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const keysBefore = store.keys();

  const { dryRun } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider, // supplied but must NEVER be called
    dryRun: true,
    log: silentLog,
  });

  assert.ok(dryRun, "dry-run mode returns a { dryRun } result");
  assert.equal(dryRun.plan.todo.length, 4, "2 arms x 2 briefs x 1 replicate");
  assert.equal(dryRun.plan.reuse.length, 0);
  assert.ok(dryRun.projection.usd > 0, "the plan is priced");

  assert.deepEqual(provider.calls, [], "the mock provider spy recorded zero calls");
  assert.deepEqual(store.keys(), keysBefore, "the store is byte-for-byte unchanged -- no writes at all");
});

test("dry-run prints the plan and the reuse/todo/stale split via the injected logger", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const lines = [];

  await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    dryRun: true,
    log: (msg) => lines.push(msg),
  });

  const joined = lines.join("\n");
  assert.match(joined, /todo/, "prints the todo count");
  assert.match(joined, /reuse/, "prints the reuse count");
  assert.match(joined, /projected cost/, "prints the cost projection");
});

// ── AC2: --max-spend below the projection aborts before any API call ────────

test("max-spend below projection aborts before any API call -- mock provider records zero calls, cells are skipped not dropped", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  // Price the grid first so the test sets a ceiling that's genuinely below
  // the full projection, without hardcoding the interim rate table's numbers.
  const { projection } = planAndPrice(SPEC, { store, armsConfig: ARMS_CONFIG });
  assert.ok(projection.usd > 0, "sanity: the grid actually costs something to project against");

  const { summary } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    maxSpendUsd: 0, // strictly below any positive projection -- refuses to start
    log: silentLog,
  });

  assert.deepEqual(provider.calls, [], "zero API calls were made before the ceiling refusal");
  assert.equal(summary.planned, 4);
  assert.equal(summary.completed, 0);
  assert.equal(summary.skipped, 4, "every planned cell is accounted for as skipped, not dropped");
  assert.deepEqual(summary.byKind, {}, "skips are not counted under byKind (that's for `failed`)");
});

test("max-spend admits a prefix of cells and skips the remainder once the ceiling would be crossed", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const { projection } = planAndPrice(SPEC, { store, armsConfig: ARMS_CONFIG });

  // A per-cell price so a ceiling of "first cell's price" admits exactly one
  // cell (assuming per-cell costs are uniform within an arm; A and B differ,
  // so pick the single cheapest cell's price as the ceiling).
  const cheapest = Math.min(...projection.breakdown.map((b) => b.usd));

  const { summary } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    maxSpendUsd: cheapest,
    log: silentLog,
  });

  assert.equal(summary.planned, 4);
  assert.equal(summary.completed + summary.skipped, 4);
  assert.ok(summary.completed >= 1, "at least the cheapest cell was admitted");
  assert.ok(summary.skipped >= 1, "at least one cell was skipped once the ceiling was reached");
  assert.equal(provider.calls.length, summary.completed, "the provider was called exactly once per completed cell, never for a skipped one");
});

test("max-spend at or above the full projection runs every cell normally", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const { projection } = planAndPrice(SPEC, { store, armsConfig: ARMS_CONFIG });

  const { summary } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    maxSpendUsd: projection.usd,
    log: silentLog,
  });

  assert.equal(summary.completed, 4);
  assert.equal(summary.skipped, 0);
  assert.equal(provider.calls.length, 4);
});

// ── issue #51: --max-spend-anthropic / --max-spend-openai ───────────────────

test("a per-provider ceiling of $0 skips only that provider's cells, budget_exceeded:<provider> named -- the other provider's cells still run", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  const { summary, account } = await runSpec(SPEC_PROVIDERS, {
    store,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2", "H3"], // single-provider arms only -- isolates the per-provider skip from the mixed-arm case
    maxSpendByProviderUsd: { anthropic: 0 },
    log: silentLog,
  });

  assert.equal(summary.planned, 2);
  assert.equal(summary.completed, 1, "the OpenAI-only cell (H3) still ran");
  assert.equal(summary.skipped, 1, "the Anthropic-only cell (H2) was skipped");
  const h2Key = cellKey({ armId: "H2", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const h2State = account.states.get(h2Key);
  assert.equal(h2State.state, "skipped");
  assert.match(h2State.detail, /^budget_exceeded:anthropic$/, "the skip detail names the tripping provider");
  assert.equal(provider.calls.length, 1, "the provider was never called for the skipped Anthropic cell");
  assert.deepEqual(provider.calls.map((c) => c.armId), ["H3"]);
});

test("a cross-provider cell (arm-G shape) is admission-controlled against BOTH ceilings -- skipped if EITHER provider's ceiling would be crossed", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  const { summary, account } = await runSpec(SPEC_PROVIDERS, {
    store,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["G2"],
    // Anthropic has ample headroom; OpenAI is capped at $0 -- the cell must
    // still be skipped, because it also spends under OpenAI (the gpt-5.6-sol
    // slot). A bug that only checked the FIRST provider in the map, or
    // flat-assigned the whole cell to Anthropic, would wrongly admit this cell.
    maxSpendByProviderUsd: { anthropic: 1000, openai: 0 },
    log: silentLog,
  });

  assert.equal(summary.planned, 1);
  assert.equal(summary.skipped, 1);
  const g2Key = cellKey({ armId: "G2", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  assert.match(account.states.get(g2Key).detail, /^budget_exceeded:openai$/);
  assert.deepEqual(provider.calls, [], "the cross-provider cell was never sent to the provider");
});

test("mixed-arm attribution (the #51 subtlety): a completed cross-provider cell's ACTUAL spend is derived from tokens_by_model and lands on BOTH providers, never flat-assigned to whichever model is listed first", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  const { summary } = await runSpec(SPEC_PROVIDERS, {
    store,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["G2"], // the cross-provider arm alone -- isolates its attribution
    log: silentLog,
  });

  assert.equal(summary.completed, 1);
  assert.ok(summary.spendByProvider, "runSpec's summary exposes actual per-provider spend");
  assert.ok(summary.spendByProvider.anthropic > 0, "the claude-opus-5 slot's real tokens contributed a positive Anthropic total");
  assert.ok(summary.spendByProvider.openai > 0, "the gpt-5.6-sol slot's real tokens contributed a positive OpenAI total");
});

test("running per-provider totals are tracked between cells, not only in the pre-flight -- a later cell is skipped once EARLIER completed cells already exhausted its provider's ceiling", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  // Two Anthropic-only cells (H2 x 2 briefs). Price the first cell alone so
  // the ceiling admits exactly it and nothing more -- proving the SECOND
  // cell's skip decision is driven by the ACTUAL running total left behind
  // by the first cell's real tokens_by_model, not a static pre-flight number
  // computed once before either cell ran.
  const twoBriefSpec = { ...SPEC_PROVIDERS, briefs: [{ id: "b1" }, { id: "b2" }] };
  const { projection } = planAndPrice(twoBriefSpec, { store, armsConfig: ARMS_CONFIG_PROVIDERS, batch: true });
  const h2Cells = projection.breakdown.filter((b) => b.cellKey.includes("H2"));
  const firstCellUsd = h2Cells[0].usd;

  const { summary } = await runSpec(twoBriefSpec, {
    store,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2"],
    maxSpendByProviderUsd: { anthropic: firstCellUsd },
    log: silentLog,
  });

  assert.equal(summary.planned, 2);
  assert.equal(summary.completed, 1, "only the first cell fit under the ceiling once its ACTUAL cost was booked");
  assert.equal(summary.skipped, 1, "the second cell was skipped -- the running total already accounted for the first cell's real spend");
});

test("issue #62 BLOCKER 2: the runner's ACTUAL per-provider running total matches an INDEPENDENTLY computed expected amount -- not merely > 0", async (t) => {
  // MockProvider's defaultCompletion is deterministic: 500 input / 300
  // output tokens per slot model (see provider.mjs). H2 has exactly one
  // Anthropic slot (claude-haiku-4-5), so the expected total is computed
  // here directly via priceRowByProvider on an IDENTICAL synthetic row --
  // completely independent of runSpec's internal bookkeeping. A mutation
  // that scales the running total (e.g. x10) fails this exact-equality
  // check even though it would pass a bare "> 0" assertion.
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  const { summary } = await runSpec(SPEC_PROVIDERS, {
    store,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2"],
    briefIds: ["b1"],
    log: silentLog,
  });

  const expectedRow = costRow({
    cellKey: "expected",
    timestamp: "2026-08-01T00:00:00Z",
    billing_mode: "api",
    model: "claude-haiku-4-5",
    input_tokens: 500,
    output_tokens: 300,
  });
  // runSpec's default `batch` is true (batch-first, see runner.mjs) -- match
  // it here so the independent expectation prices the same discounted rate
  // the actual run did.
  const { byProvider: expected } = priceRowByProvider(expectedRow, undefined, { batch: true });

  assert.equal(summary.completed, 1);
  assert.equal(summary.spendByProvider.anthropic, expected.anthropic, "the actual running total must equal the independently-derived expected amount exactly, not merely be positive");
});

test("issue #62 HIGH/BLOCKER 2: --max-spend-<provider> requires every priced todo cell to carry byProvider, and fails loud (not merely 'within budget') when an injected priceGrid omits it", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  // A priceGrid that prices cells but never reports byProvider -- the exact
  // shape the pre-flight guard (runner.mjs) exists to reject.
  const brokenPriceGrid = (plannedCells) => ({
    usd: plannedCells.length,
    breakdown: plannedCells.map((c) => ({ cellKey: c.key, usd: 1 })), // no byProvider
  });

  await assert.rejects(
    () =>
      runSpec(SPEC_PROVIDERS, {
        store,
        armsConfig: ARMS_CONFIG_PROVIDERS,
        provider,
        armIds: ["H2"],
        priceGrid: brokenPriceGrid,
        maxSpendByProviderUsd: { anthropic: 1000 },
        log: silentLog,
      }),
    /requires every priced todo cell to carry a 'byProvider' breakdown/,
  );
});

test("issue #62 BLOCKER 1 (regression): once ONE provider's ceiling has been exhausted by real spend, a later cell that does NOT touch that provider still runs -- it must not be wrongly attributed to the exhausted provider", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  // H2 (Anthropic-only) first, tripping a near-zero Anthropic ceiling; H3
  // (OpenAI-only) second, under a wide-open OpenAI ceiling. Before the fix,
  // once `already > ceiling` for anthropic, EVERY remaining cell -- including
  // the OpenAI-only H3, whose projected anthropic share is $0 -- was skipped
  // and mislabeled `budget_exceeded:anthropic`.
  const { summary, account } = await runSpec(SPEC_PROVIDERS, {
    store,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2", "H3"],
    maxSpendByProviderUsd: { anthropic: 0, openai: 1000 },
    log: silentLog,
  });

  assert.equal(summary.completed, 1, "the OpenAI-only cell (H3) ran despite Anthropic's ceiling being exhausted");
  assert.equal(summary.skipped, 1, "the Anthropic-only cell (H2) was skipped");
  const h3Key = cellKey({ armId: "H3", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  assert.equal(account.states.get(h3Key).state, "completed", "H3 must not be misclassified as skipped:budget_exceeded:anthropic");
});

test("issue #62 MEDIUM: the spend-gating path fails loud (not a silent $0) when an actual cost row references a model with no RATE_TABLE entry, while a per-provider ceiling is active", async (t) => {
  // "claude-fake-model-62" carries a real `claude-` prefix (providerOf
  // resolves it to anthropic fine) but has no lib/price.mjs RATE_TABLE
  // entry -- exactly the "JUDGE_MODELS model never went through
  // runnerPriceGrid" gap the QA review names. A custom priceGrid stands in
  // for the pre-flight pricer (which would otherwise reject an unknown
  // model before the provider is ever called) so the failure under test is
  // specifically the ACTUAL-spend path, after the mock provider responds.
  const store = new ResultsStore(tempDir(t));
  const unratedArmsConfig = {
    arms: {
      NR: { mode: "panel", slots: [{ persona: "proposer_1", model: "claude-fake-model-62" }] },
    },
  };
  const unratedSpec = { arms: [{ id: "NR" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const provider = new MockProvider();
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
});

test("issue #78: the spend-gating path fails loud (not a silent $0) when an actual cost row references a model with no RATE_TABLE entry, on a GLOBAL-ONLY --max-spend (no per-provider ceiling)", async (t) => {
  // Same shape as the issue #62 MEDIUM test above, but the ONLY ceiling
  // supplied is the global `maxSpendUsd` -- `maxSpendByProviderUsd` is
  // deliberately omitted. Before the #78 fix, recordActualSpend's guard
  // checked `maxSpendByProviderUsd && hasMissingRate`, so with no
  // per-provider ceiling active this branch was unreachable and the
  // rate-less row silently priced at $0, landing in `runningTotal` without
  // ever tripping anything.
  //
  // The ceiling is set FAR above the fake $1/cell projection (1000 vs 1) so
  // the run is never within budget-shortfall distance of throwing for the
  // wrong reason -- the only way this test can throw is the missing-rate
  // guard itself. A ceiling set at or below the projection would make a
  // still-broken guard pass this test via the ORDINARY budget check instead
  // (the trap this repo has shipped before): that check runs on the
  // PROJECTED grid before any cell executes and would abort the whole run
  // with a "within budget"/skip outcome rather than the RATE_TABLE error
  // asserted below, so a regression back to the narrow `maxSpendByProviderUsd`
  // condition must be caught here, not masked by an unrelated ceiling trip.
  const store = new ResultsStore(tempDir(t));
  const unratedArmsConfig = {
    arms: {
      NR: { mode: "panel", slots: [{ persona: "proposer_1", model: "claude-fake-model-78" }] },
    },
  };
  const unratedSpec = { arms: [{ id: "NR" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const provider = new MockProvider();
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
        maxSpendUsd: 1000, // global-only ceiling -- no maxSpendByProviderUsd at all
        log: silentLog,
      }),
    /no RATE_TABLE entry/,
    "a rate-less model must be refused specifically for lacking a RATE_TABLE entry, not for tripping a low ceiling",
  );
});

// ── AC3: resume -- killing mid-grid and restarting re-runs only incomplete cells ──

test("resume: a killed run re-runs only incomplete cells on restart", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  const provider1 = new MockProvider();

  // "Kill" the run mid-grid: only run arm A (2 of the 4 cells), simulating a
  // process that completed half the grid before dying.
  const { summary: partial } = await runSpec(SPEC, {
    store: store1,
    armsConfig: ARMS_CONFIG,
    provider: provider1,
    armIds: ["A"],
    log: silentLog,
  });
  assert.equal(partial.completed, 2, "arm A x 2 briefs completed before the simulated kill");
  assert.equal(provider1.calls.length, 2);

  // Restart: open a FRESH store instance pointed at the same directory (as a
  // real restarted process would) and run the FULL spec again.
  const store2 = new ResultsStore(dir);
  const provider2 = new MockProvider();
  const { plan } = planAndPrice(SPEC, { store: store2, armsConfig: ARMS_CONFIG });
  assert.equal(plan.reuse.length, 2, "the 2 already-completed cells are recognized as reuse");
  assert.equal(plan.todo.length, 2, "only the 2 incomplete cells (arm B) are todo");

  const { summary: resumed } = await runSpec(SPEC, {
    store: store2,
    armsConfig: ARMS_CONFIG,
    provider: provider2,
    log: silentLog,
  });

  assert.equal(resumed.planned, 4, "the full grid is accounted for across both sessions combined");
  assert.equal(resumed.completed, 4);
  assert.equal(provider2.calls.length, 2, "the provider was hit ONLY for the 2 previously-incomplete (todo) cells");
  assert.deepEqual(
    new Set(provider2.calls.map((c) => c.armId)),
    new Set(["B"]),
    "arm A's already-completed cells were never re-sent to the provider",
  );
});

test("resume fails loudly on a stored cell with an unrecognized accounting.state, rather than silently treating it as skipped", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const corruptKey = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  // lib/store.mjs only requires accounting.state to be truthy -- it does not
  // validate membership in lib/accounting.mjs's TERMINAL_STATES, so a
  // corrupted or hand-edited store record with a typo'd state is
  // constructible. The runner must not silently absorb that as "skipped".
  store.put({
    key: corruptKey,
    armId: "A",
    briefId: "b1",
    replicate: 0,
    cfg: CFG_HASH,
    result: { candidates: [] },
    resolvedModels: { solo: "claude-sonnet-5" },
    accounting: { state: "not_a_real_state" },
    costRows: [],
  });

  await assert.rejects(
    () => runSpec(SPEC, { store, armsConfig: ARMS_CONFIG, provider: new MockProvider(), armIds: ["A"], briefIds: ["b1"], log: silentLog }),
    /unrecognized accounting\.state/,
  );
});

test("resume is a true no-op when the whole grid already completed", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  await runSpec(SPEC, { store: store1, armsConfig: ARMS_CONFIG, provider: new MockProvider(), log: silentLog });

  const store2 = new ResultsStore(dir);
  const provider2 = new MockProvider();
  const { summary } = await runSpec(SPEC, { store: store2, armsConfig: ARMS_CONFIG, provider: provider2, log: silentLog });

  assert.equal(summary.completed, 4);
  assert.deepEqual(provider2.calls, [], "nothing left to run -- the provider is never touched");
});

test("resume restores each reused cell's ORIGINAL stored result, not a synthetic placeholder -- so downstream metrics stay computable", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  await runSpec(SPEC, { store: store1, armsConfig: ARMS_CONFIG, provider: new MockProvider({ latencyMs: 42 }), log: silentLog });

  const store2 = new ResultsStore(dir);
  const provider2 = new MockProvider();
  const { account } = await runSpec(SPEC, { store: store2, armsConfig: ARMS_CONFIG, provider: provider2, log: silentLog });

  // Every cell in this second session's account is a REUSED cell (the whole
  // grid already completed in session 1) -- so this exercises the resume
  // hydration path exclusively. If resume ever regresses to synthesizing a
  // placeholder result (e.g. `{ reused: true }`) instead of restoring the
  // original, this is where it would show: operationalSummary()/
  // latencyPercentiles() require every completed cell's result to carry a
  // numeric latencyMs, and throw otherwise.
  const { latencyPercentiles } = await import("../metrics/operational.mjs");
  const percentiles = latencyPercentiles(account);
  assert.equal(percentiles.n, 4, "all 4 reused cells contributed a real latency reading");
  assert.equal(percentiles.p50, 42, "the ORIGINAL provider's latencyMs survived resume, not a placeholder");
});

// ── AC4: a forced provider failure surfaces as a classified failed cell ─────

test("a forced provider failure surfaces as a classified failed cell, never a missing one, and reconcile() still passes", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const targetKey = cellKey({ armId: "B", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const overrides = new Map([[targetKey, { terminalState: "failed", failureKind: "empty_pool", detail: "candidates: []" }]]);
  const provider = new MockProvider({ overrides });

  const { summary, account } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    log: silentLog,
  });

  // reconcile() already ran inside runSpec() without throwing -- that IS the
  // "reconcile() still passes" assertion (every planned cell reached a
  // terminal state). Re-derive it here too for an explicit, named check.
  assert.doesNotThrow(() => account.reconcile(), "every planned cell reached a terminal state");

  assert.equal(summary.planned, 4);
  assert.equal(summary.completed, 3);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.byKind, { empty_pool: 1 });

  // The failed cell is a STORED datum, not an absence -- fetchable from the
  // store like any other cell, per store.mjs's own contract ("a cell that
  // fails is classified, never discarded").
  assert.ok(store.has(targetKey), "the failed cell was written to the store, not dropped");
  const stored = store.get(targetKey);
  assert.equal(stored.accounting.state, "failed");
  assert.equal(stored.accounting.kind, "empty_pool");
});

test("a provider that returns a malformed response is classified harness_error, not an uncaught crash", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const malformedProvider = { async generate() { return { terminalState: "not_a_real_state" }; } };

  const { summary } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider: malformedProvider,
    log: silentLog,
  });

  assert.equal(summary.planned, 4);
  assert.equal(summary.failed, 4);
  assert.deepEqual(summary.byKind, { harness_error: 4 });
});

test("a provider that THROWS is classified harness_error, not silently swallowed", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const throwingProvider = {
    async generate(cell) {
      if (cell.armId === "B") throw new Error("simulated transport crash");
      return new (await import("./provider.mjs")).MockProvider().generate(...arguments);
    },
  };

  const { summary } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider: throwingProvider,
    log: silentLog,
  });

  assert.equal(summary.planned, 4);
  assert.equal(summary.failed, 2, "both arm-B cells (which threw) are classified failures");
  assert.deepEqual(summary.byKind, { harness_error: 2 });
});

// ── Batch-first modeling ─────────────────────────────────────────────────────

test("batch is the DEFAULT mode -- the provider sees mode: 'batch' without the caller asking for it", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  await runSpec(SPEC, { store, armsConfig: ARMS_CONFIG, provider, log: silentLog });

  assert.ok(provider.calls.length > 0);
  assert.ok(provider.calls.every((c) => c.mode === "batch"), "every call defaulted to batch mode with no explicit opt-in");
});

test("batch: false is an explicit opt-out to single mode -- and prices at full (non-discounted) rate", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  const { projection: batchProjection } = planAndPrice(SPEC, { store, armsConfig: ARMS_CONFIG, batch: true });
  const { projection: singleProjection } = planAndPrice(SPEC, { store, armsConfig: ARMS_CONFIG, batch: false });
  assert.ok(singleProjection.usd > batchProjection.usd, "single-mode pricing is higher than the batch-discounted price");

  await runSpec(SPEC, { store, armsConfig: ARMS_CONFIG, provider, batch: false, log: silentLog });
  assert.ok(provider.calls.every((c) => c.mode === "single"));
});

// ── --arms / --briefs / --replicates subsetting ──────────────────────────────

test("--arms and --briefs subset the grid; an unknown id throws rather than silently running less", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  const { summary } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    armIds: ["A"],
    briefIds: ["b1"],
    log: silentLog,
  });
  assert.equal(summary.planned, 1);

  await assert.rejects(
    () => runSpec(SPEC, { store, armsConfig: ARMS_CONFIG, provider, armIds: ["NOT_AN_ARM"], log: silentLog }),
    /unknown arm/,
  );
});

test("--replicates overrides the spec's replicate count", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();

  const { summary } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    armIds: ["A"],
    briefIds: ["b1"],
    replicates: 3,
    log: silentLog,
  });
  assert.equal(summary.planned, 3, "1 arm x 1 brief x 3 replicates");
});

// ── interimPriceGrid unit coverage ───────────────────────────────────────────

test("interimPriceGrid throws on an unknown arm id rather than silently pricing it at zero", () => {
  assert.throws(
    () => interimPriceGrid([{ key: "x", armId: "NOPE" }], ARMS_CONFIG.arms),
    /unknown arm/,
  );
});

test("interimPriceGrid applies the batch discount by default and prices single-mode higher", () => {
  const cells = [{ key: "x", armId: "B" }];
  const batchPrice = interimPriceGrid(cells, ARMS_CONFIG.arms, { batch: true }).usd;
  const singlePrice = interimPriceGrid(cells, ARMS_CONFIG.arms, { batch: false }).usd;
  assert.ok(batchPrice > 0);
  assert.equal(Math.round((singlePrice / batchPrice) * 100) / 100, 2, "single mode is 2x batch (batch is -50%)");
});

test("interimPriceGrid throws on an arm with no model slots rather than silently pricing it at $0", () => {
  const armsWithEmptySlots = { EMPTY: { mode: "panel", slots: [] } };
  assert.throws(
    () => interimPriceGrid([{ key: "x", armId: "EMPTY" }], armsWithEmptySlots),
    /no model slots/,
    "a misconfigured arm must not silently bypass --max-spend by costing nothing",
  );
});

test("runSpec throws if an injected priceGrid omits a planned cell from its breakdown, rather than treating it as free", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  // A deliberately buggy pricer: prices nothing at all. `priceByKey.get()`
  // would return `undefined` for every cell -- if the runner coerced that to
  // 0 via `|| 0`, every cell would run "for free" and --max-spend would be
  // meaningless.
  const brokenPriceGrid = () => ({ usd: 0, breakdown: [] });

  await assert.rejects(
    () => runSpec(SPEC, { store, armsConfig: ARMS_CONFIG, provider, priceGrid: brokenPriceGrid, maxSpendUsd: 100, log: silentLog }),
    /breakdown is missing an entry/,
  );
});

// ── issue #64: spend ceilings must be cumulative across invocations ─────────
// The defect: `runningTotalByProvider` (and the global `runningTotal`) seeded
// at `{}`/`0` on every runSpec() call, never read back from the store -- so a
// resumed run's ceiling gated only THAT invocation's spend, letting N
// invocations spend roughly N x the stated cap. The fix reconstructs
// spend-to-date from the store's own cost rows (the durable record) at the
// start of every runSpec() call and folds it into every admission decision.

/** Seed a store with an already-"spent" cost row directly (no provider call,
 *  no runSpec) -- a controlled, arithmetic-exact way to establish "prior
 *  spend of exactly $X" without depending on any pricing table's real
 *  numbers. Deliberately stores the row under `seedCfg` (which may differ
 *  from the config the test's real runSpec call uses) -- this is itself part
 *  of what these tests verify: cumulative spend-to-date is NOT scoped to the
 *  current configHash (see spendToDate's own header for why). */
function seedSpentRow(store, { key, armId, briefId, cfg, model, inputTokens, outputTokens }) {
  store.put({
    key,
    armId,
    briefId,
    replicate: 0,
    cfg,
    result: { candidates: [] },
    resolvedModels: { solo: model },
    accounting: { state: "completed" },
    costRows: [
      costRow({
        cellKey: key,
        timestamp: "2026-08-01T00:00:00.000Z",
        billing_mode: "api",
        tokens_by_model: { [model]: { input_tokens: inputTokens, output_tokens: outputTokens } },
      }),
    ],
  });
}

test("issue #64: spendToDate sums a store's cost rows across EVERY configHash and EVERY provider, never scoped to just one", async (t) => {
  const store = new ResultsStore(tempDir(t));

  // Two rows under TWO DIFFERENT configHashes ("old-cfg" and "new-cfg") and
  // TWO DIFFERENT providers (Anthropic and OpenAI) -- a store a real study
  // would produce after a harness bump plus a mixed-provider grid.
  seedSpentRow(store, {
    key: "arm=H2|brief=seed1|rep=0|cfg=old-cfg",
    armId: "H2",
    briefId: "seed1",
    cfg: "old-cfg",
    model: "claude-haiku-4-5",
    inputTokens: 1_000_000,
    outputTokens: 0,
  });
  seedSpentRow(store, {
    key: "arm=H3|brief=seed2|rep=0|cfg=new-cfg",
    armId: "H3",
    briefId: "seed2",
    cfg: "new-cfg",
    model: "gpt-5.6-terra",
    inputTokens: 1_000_000,
    outputTokens: 0,
  });

  const result = spendToDate(store, undefined, { batch: true });

  // Independently derive the expected totals via priceRowsByProvider over
  // the SAME two rows, built by hand rather than read back off the store --
  // an assertion that would still pass if spendToDate silently dropped a
  // provider bucket or a configHash's rows would be a useless test.
  const expected = priceRowsByProvider(
    [
      costRow({ cellKey: "a", timestamp: "2026-08-01T00:00:00.000Z", billing_mode: "api", tokens_by_model: { "claude-haiku-4-5": { input_tokens: 1_000_000, output_tokens: 0 } } }),
      costRow({ cellKey: "b", timestamp: "2026-08-01T00:00:00.000Z", billing_mode: "api", tokens_by_model: { "gpt-5.6-terra": { input_tokens: 1_000_000, output_tokens: 0 } } }),
    ],
    undefined,
    { batch: true },
  );

  assert.ok(result.byProvider.anthropic > 0, "the old-configHash Anthropic row was consulted");
  assert.ok(result.byProvider.openai > 0, "the new-configHash OpenAI row was consulted");
  assert.equal(result.byProvider.anthropic, expected.byProvider.anthropic, "Anthropic total matches an independently-derived expectation exactly");
  assert.equal(result.byProvider.openai, expected.byProvider.openai, "OpenAI total matches an independently-derived expectation exactly");
  assert.equal(result.totalUsd, expected.byProvider.anthropic + expected.byProvider.openai, "the global total is the sum across both providers and both configHashes");
});

test("issue #64: a per-provider ceiling fails loud when the STORE's own history holds a cost row for a model with no RATE_TABLE entry -- never a silent under-count of spend-to-date", async (t) => {
  const store = new ResultsStore(tempDir(t));
  seedSpentRow(store, {
    key: "arm=NR|brief=seed|rep=0|cfg=old-cfg",
    armId: "NR",
    briefId: "seed",
    cfg: "old-cfg",
    model: "claude-fake-model-64", // no lib/price.mjs RATE_TABLE entry
    inputTokens: 1000,
    outputTokens: 0,
  });

  const provider = new MockProvider();
  await assert.rejects(
    () =>
      runSpec(SPEC_PROVIDERS, {
        store,
        armsConfig: ARMS_CONFIG_PROVIDERS,
        provider,
        armIds: ["H2"],
        maxSpendByProviderUsd: { anthropic: 1000 },
        log: silentLog,
      }),
    /cumulative spend-to-date cannot be priced/,
  );
});

test("issue #64: a run with NO ceiling active does not fail loud on an unrated model in the store's history -- there is nothing to gate", async (t) => {
  const store = new ResultsStore(tempDir(t));
  seedSpentRow(store, {
    key: "arm=NR|brief=seed|rep=0|cfg=old-cfg",
    armId: "NR",
    briefId: "seed",
    cfg: "old-cfg",
    model: "claude-fake-model-64",
    inputTokens: 1000,
    outputTokens: 0,
  });

  const provider = new MockProvider();
  const { summary } = await runSpec(SPEC_PROVIDERS, {
    store,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2"],
    log: silentLog,
  });
  assert.equal(summary.completed, 1, "no ceiling active -- the unrated row in history does not block the run");
});

// ── issue #64 follow-up (PR #72 review, MEDIUM): `spendToDate` reads and
// JSON-parses EVERY stored body -- `store.get()` (`readFileSync` +
// `JSON.parse`, no tolerance) throws a bare `SyntaxError`/`ENOENT` on a
// truncated or missing body, and that read now happens on EVERY ceiling-
// gated invocation, not just for the current spec's reused cells. Two
// things to prove: (1) it is a DIAGNOSTIC, naming the offending key, not a
// raw parser exception; (2) it is paid ONLY when a ceiling is active -- a
// plain generation run must not be crashable by damage to a body (e.g. a
// Phase 0 record) it would otherwise never touch. ──

test("issue #64: a truncated body in the store surfaces as a DIAGNOSTIC naming the offending key -- never a bare SyntaxError -- and only when a ceiling is active", async (t) => {
  const dir = tempDir(t);
  const store = new ResultsStore(dir);
  seedSpentRow(store, {
    key: "arm=H2|brief=corrupt|rep=0|cfg=" + CFG_HASH,
    armId: "H2",
    briefId: "corrupt",
    cfg: CFG_HASH,
    model: "claude-haiku-4-5",
    inputTokens: 1000,
    outputTokens: 500,
  });

  // Corrupt the body file directly on disk -- exactly the "external damage"
  // shape the reviewer verified against a copy of the real Phase 0 store
  // (crash-safety means this needs external damage to trigger: store.put()
  // writes body-then-rename and appends the index line last).
  const entry = store.list()[0];
  writeFileSync(`${store.bodiesDir}/${entry.bodyFile}`, '{"key": "truncated, no closing brace');

  const freshStore = new ResultsStore(dir); // a NEW instance -- no cache from the seeding write above
  const provider = new MockProvider();

  await assert.rejects(
    () =>
      runSpec(SPEC_PROVIDERS, {
        store: freshStore,
        armsConfig: ARMS_CONFIG_PROVIDERS,
        provider,
        armIds: ["H2"],
        maxSpendByProviderUsd: { anthropic: 1000 }, // a ceiling IS active -- the store's full history must be read
        log: silentLog,
      }),
    (err) => {
      assert.match(err.message, /spendToDate: could not read the stored body/);
      assert.match(err.message, new RegExp(entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the offending KEY must be named, not just a generic failure");
      assert.match(err.message, /Original error:/, "the underlying parse/read error is preserved, not swallowed");
      return true;
    },
  );
});

test("issue #64: a truncated body in the store does NOT crash a run with NO ceiling active -- the store's history is never even read", async (t) => {
  const dir = tempDir(t);
  const store = new ResultsStore(dir);
  seedSpentRow(store, {
    key: "arm=H2|brief=corrupt|rep=0|cfg=" + CFG_HASH,
    armId: "H2",
    briefId: "corrupt",
    cfg: CFG_HASH,
    model: "claude-haiku-4-5",
    inputTokens: 1000,
    outputTokens: 500,
  });
  const entry = store.list()[0];
  writeFileSync(`${store.bodiesDir}/${entry.bodyFile}`, "not even json");

  const freshStore = new ResultsStore(dir);
  const provider = new MockProvider();
  const { summary } = await runSpec(SPEC_PROVIDERS, {
    store: freshStore,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H3"], // a DIFFERENT arm/brief than the corrupted record -- this run never needed that body
    log: silentLog,
  });

  assert.equal(summary.completed, 1, "a plain generation run with no ceiling must not be crashable by damage to a body it never otherwise touches");
});

test("issue #64: an empty store's spend-to-date is exactly zero, both globally and per-provider", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const result = spendToDate(store, undefined, { batch: true });
  assert.equal(result.totalUsd, 0);
  assert.deepEqual(result.byProvider, {});
  assert.equal(result.hasMissingRate, false);
});

// ── issue #64 follow-up (cwc PR #72 review): Phase 0 (#69) writes real
// `voyage-4-lite` cost rows to the SAME store a spend ceiling reads. Before
// this fix, `spendToDate` (via `priceRowsByProvider` -> `priceRowByProvider`
// -> `providerOf`) would THROW on a correctly-written embedder row, hard-
// failing a resumed study on exactly the path whose job is to stop an
// unbounded bill. ──

/** Seed a store with a cost row shaped EXACTLY like evals/metrics/phase0.mjs
 *  writes one -- `costRow({ cellKey, timestamp, billing_mode: "api", model,
 *  input_tokens })`, single `model` field (not `tokens_by_model`), no
 *  `output_tokens` at all (embeddings have none). Deliberately a SEPARATE
 *  helper from `seedSpentRow` above (which always uses `tokens_by_model`) so
 *  this test exercises the real shape the reviewer named, not an
 *  approximation of it. */
function seedPhase0Row(store, { key, cfg, model = "voyage-4-lite", inputTokens, briefId = "phase0" }) {
  store.put({
    key,
    briefId,
    cfg,
    result: { threshold: 0.23, provenance: { embedderId: model } },
    resolvedModels: { embedder: model },
    accounting: { state: "completed" },
    costRows: [
      costRow({
        cellKey: key,
        timestamp: "2026-09-01T12:00:00.000Z",
        billing_mode: "api",
        model,
        input_tokens: inputTokens,
      }),
    ],
  });
}

test("issue #64: spendToDate does NOT throw on a real Phase 0-shaped voyage-4-lite row -- it is cleanly excluded from byProvider, counted in totalUsd, and surfaced via excludedNonProviderUsd/Models", async (t) => {
  const store = new ResultsStore(tempDir(t));
  seedPhase0Row(store, { key: "phase0/dat-replication", cfg: "phase0-cfg", inputTokens: 50_000 });

  const result = spendToDate(store, undefined, { batch: true });

  assert.ok(result.totalUsd > 0, "the embedder spend is real, priced money -- it must show up in the grand total");
  assert.deepEqual(result.byProvider, {}, "voyage-4-lite must not land in anthropic or openai's bucket");
  assert.equal(result.hasMissingRate, false, "voyage-4-lite has a real RATE_TABLE entry -- excluding it from byProvider is not the same as failing to price it");
  assert.ok(result.excludedNonProviderUsd > 0, "the excluded spend is surfaced, not silently dropped");
  assert.deepEqual(result.excludedNonProviderModels, ["voyage-4-lite"]);
  assert.equal(result.totalUsd, result.excludedNonProviderUsd, "with ONLY an embedder row in the store, the grand total and the excluded-non-provider total must be identical");
});

test("issue #64: a store containing BOTH Phase 0 (embedder) rows AND generation rows prices cleanly end-to-end -- the embedder rows never trip, block, or get miscounted into a per-provider ceiling", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);

  // The exact shape Phase 0 produces per invocation: TWO embedder rows
  // (dat-replication + negative-controls), per evals/metrics/phase0.mjs.
  seedPhase0Row(store1, { key: "phase0/dat-replication", cfg: "phase0-cfg", inputTokens: 40_000, briefId: "dat" });
  seedPhase0Row(store1, { key: "phase0/negative-controls", cfg: "phase0-cfg", inputTokens: 25_000, briefId: "controls" });

  // A real generation cell runs NEXT, in the SAME store, under an ACTIVE
  // per-provider ceiling -- exactly the state the repo will be in once
  // Phase 0 has run and a resumed study invocation sets --max-spend-*.
  const provider = new MockProvider();
  const { summary } = await runSpec(SPEC_PROVIDERS, {
    store: store1,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2"], // Anthropic-only
    maxSpendByProviderUsd: { anthropic: 1000, openai: 1000 }, // generous -- this test is about NOT THROWING and NOT MISATTRIBUTING, not about tripping the ceiling
    log: silentLog,
  });

  assert.equal(summary.completed, 1, "the generation cell ran normally -- Phase 0's embedder rows in the same store did not block it");
  assert.ok(summary.cumulativeNonProviderSpendUsd > 0, "the embedder spend from Phase 0 is visible on the summary");
  assert.deepEqual(summary.cumulativeNonProviderModels, ["voyage-4-lite"]);
  // The embedder spend must NOT have leaked into either provider's
  // cumulative bucket -- only the one Anthropic generation cell's real spend
  // should appear there.
  assert.equal(Object.keys(summary.cumulativeSpendByProvider).length, 1);
  assert.ok(summary.cumulativeSpendByProvider.anthropic > 0);
  assert.equal(summary.cumulativeSpendByProvider.openai, undefined, "no openai spend at all -- neither from generation (H2 is Anthropic-only) nor misattributed embedder spend");

  // Grand-total invariant (PR #72 review, LOW -- the single-row test above
  // only pins `totalUsd === excludedNonProviderUsd` trivially, since that
  // store holds nothing else; a mutation dropping the embedder row from
  // `priceRows().totalUsd` survives that alone). Cross-check via a FRESH,
  // independent `spendToDate` read of the post-run store: `totalUsd` comes
  // from `priceRows()` (sums every row regardless of provider), while
  // `byProvider`/`excludedNonProviderUsd` come from the SEPARATE
  // `priceRowsByProvider()` code path -- two different reductions over the
  // same rows that must still agree, on a store that genuinely holds BOTH
  // provider-attributable AND non-provider rows (two Phase 0 rows plus one
  // real generation cell), not the degenerate single-row case.
  const postRun = spendToDate(store1, undefined, { batch: true });
  const providerSum = Object.values(postRun.byProvider).reduce((a, b) => a + b, 0);
  assert.equal(postRun.totalUsd, providerSum + postRun.excludedNonProviderUsd, "the grand total must equal provider spend plus embedder spend -- nothing double-counted or dropped between the two aggregation paths");
});

test("issue #64: embedder spend recorded in the store does NOT count against a per-provider ceiling -- a cell that would otherwise fit is NOT wrongly skipped", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);

  // Seed a LARGE embedder spend -- larger than the ceiling we're about to set
  // for Anthropic. If embedder spend were ever wrongly folded into a
  // provider's cumulative total (the exact regression this test guards
  // against), this alone would push the Anthropic "already spent" figure
  // over the ceiling and wrongly skip the cell below.
  seedPhase0Row(store1, { key: "phase0/dat-replication", cfg: "phase0-cfg", inputTokens: 50_000_000 });
  const embedderOnly = spendToDate(store1, undefined, { batch: true });
  assert.ok(embedderOnly.excludedNonProviderUsd > 0.05, "sanity: the seeded embedder spend is not trivially small");

  const store2 = new ResultsStore(dir);
  const provider = new MockProvider();
  const { summary } = await runSpec(SPEC_PROVIDERS, {
    store: store2,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2"],
    // A ceiling ABOVE what the single H2 cell will actually cost, but BELOW
    // the embedder spend seeded above -- only passes if embedder spend is
    // correctly excluded from the anthropic bucket.
    maxSpendByProviderUsd: { anthropic: embedderOnly.excludedNonProviderUsd / 2 },
    log: silentLog,
  });

  assert.equal(summary.completed, 1, "the Anthropic cell must be admitted -- embedder spend is not Anthropic spend, however large");
  assert.equal(summary.skipped, 0);
});

// ── issue #64 follow-up (PR #72 review, HIGH): --max-spend (the GLOBAL
// ceiling) and summary.cumulativeSpendUsd must agree on whether
// non-provider/embedder spend counts. Both tests below pair maxSpendUsd with
// an embedder-only store -- direction 1 proves the admission decision
// already counts it (unchanged, pre-existing behavior); direction 2 proves
// the REPORTED cumulative total now matches that same decision instead of
// silently excluding the very money that just stopped the run.
test("issue #64: a GLOBAL --max-spend ceiling IS tripped by embedder-only spend (direction 1: gating basis includes non-provider spend, by design -- a global ceiling is a total-dollars backstop)", async (t) => {
  const store1 = new ResultsStore(tempDir(t));
  seedPhase0Row(store1, { key: "phase0/dat-replication", cfg: "phase0-cfg", inputTokens: 50_000_000 });
  const embedderOnly = spendToDate(store1, undefined, { batch: true });
  assert.ok(embedderOnly.totalUsd > 0.05, "sanity: the seeded embedder spend is not trivially small");
  assert.deepEqual(embedderOnly.byProvider, {}, "sanity: this store has NO provider-attributable spend at all");

  const provider = new MockProvider();
  const { summary } = await runSpec(SPEC_PROVIDERS, {
    store: store1,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2"],
    // Below the embedder spend alone -- if the global ceiling did NOT count
    // non-provider spend, this cell (whose own projected cost is tiny)
    // would sail through. It must not.
    maxSpendUsd: embedderOnly.totalUsd / 2,
    log: silentLog,
  });

  assert.equal(summary.completed, 0, "the global ceiling must be tripped by embedder spend alone -- it is real money and --max-spend is a total-dollars cap");
  assert.equal(summary.skipped, 1);
  assert.equal(provider.calls.length, 0);
});

test("issue #64: summary.cumulativeSpendUsd matches what --max-spend actually gated against, embedder spend included (direction 2: the REPORTED basis agrees with the GATING basis)", async (t) => {
  const store1 = new ResultsStore(tempDir(t));
  seedPhase0Row(store1, { key: "phase0/dat-replication", cfg: "phase0-cfg", inputTokens: 50_000_000 });
  const embedderOnly = spendToDate(store1, undefined, { batch: true });

  const provider = new MockProvider();
  // A ceiling comfortably ABOVE the embedder spend so the run actually
  // proceeds and produces a real summary to inspect (direction 1 above
  // already covers the skip case).
  const { summary } = await runSpec(SPEC_PROVIDERS, {
    store: store1,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider,
    armIds: ["H2"],
    maxSpendUsd: embedderOnly.totalUsd + 1000,
    log: silentLog,
  });

  assert.equal(summary.completed, 1);
  // The embedder spend seeded BEFORE this run must show up in
  // cumulativeNonProviderSpendUsd (unchanged from spendToDate's own figure --
  // this run added none of its own) AND in cumulativeSpendUsd's total, per
  // the basis decision documented at runSpec's summary-assembly site and in
  // docs/PREREGISTRATION.md §12: cumulativeSpendUsd === sum(byProvider) +
  // cumulativeNonProviderSpendUsd, matching what --max-spend gates on.
  assert.equal(summary.cumulativeNonProviderSpendUsd, embedderOnly.excludedNonProviderUsd);
  const providerTotal = Object.values(summary.cumulativeSpendByProvider).reduce((a, b) => a + b, 0);
  assert.equal(summary.cumulativeSpendUsd, providerTotal + summary.cumulativeNonProviderSpendUsd, "cumulativeSpendUsd must equal the provider breakdown PLUS the non-provider breakdown -- no money unaccounted for between the two reported bases");
  assert.ok(summary.cumulativeSpendUsd > embedderOnly.totalUsd, "cumulativeSpendUsd must reflect at least the pre-existing embedder spend (plus this run's own H2 spend) -- not silently drop it the way the pre-fix cumulativeSpendUsd did");
});

test("issue #64: a per-provider ceiling is enforced against spend already recorded by an EARLIER invocation of the same store, not reset to zero", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  const provider1 = new MockProvider();

  const twoBriefSpec = { ...SPEC_PROVIDERS, briefs: [{ id: "b1" }, { id: "b2" }] };

  // First invocation: only H2/b1 admitted (no ceiling), spending real,
  // deterministic money (MockProvider's fixed 500 in / 300 out tokens).
  const { summary: first } = await runSpec(twoBriefSpec, {
    store: store1,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider: provider1,
    armIds: ["H2"],
    briefIds: ["b1"],
    log: silentLog,
  });
  assert.equal(first.completed, 1);
  const priorAnthropic = first.spendByProvider.anthropic;
  assert.ok(priorAnthropic > 0, "sanity: the first invocation actually spent something");

  // Second invocation: a DIFFERENT process (a fresh ResultsStore instance
  // opened on the SAME directory -- exactly how a resumed CLI invocation
  // would see it, never sharing in-memory state with the first). Plans a
  // NEW cell (H2/b2) and sets the per-provider ceiling to EXACTLY what the
  // first invocation spent. Ceiling logging in runner.mjs's own per-cell
  // loop only gates a cell whose projected share is positive, so first
  // confirm (via planAndPrice) that H2/b2 genuinely projects a positive
  // Anthropic share -- otherwise this test would pass for the wrong reason
  // (the "projected > 0" guard skipping the check entirely, not the
  // cumulative-total comparison this test targets).
  const store2 = new ResultsStore(dir);
  const provider2 = new MockProvider();
  const { projection } = planAndPrice(
    { ...twoBriefSpec, briefs: [{ id: "b2" }] },
    { store: store2, armsConfig: ARMS_CONFIG_PROVIDERS },
  );
  const b2Anthropic = projection.breakdown.find((b) => b.cellKey.includes("H2")).byProvider.anthropic;
  assert.ok(b2Anthropic > 0, "sanity: H2/b2 projects a positive Anthropic share");

  // The ceiling MUST sit strictly ABOVE the pre-flight projection alone
  // (b2Anthropic) -- otherwise a broken implementation that never consults
  // the store at all (already = 0) would ALSO skip this cell, just because
  // its own pre-flight estimate already exceeds a too-tight ceiling, and
  // this test would pass for the wrong reason. It must sit BELOW
  // projection + prior actual spend, so only folding the prior invocation's
  // real spend into the decision tips it over.
  const ceiling = b2Anthropic + priorAnthropic / 2;
  assert.ok(ceiling > b2Anthropic, "sanity: the ceiling alone would NOT be tripped by the pre-flight projection");

  const { summary: second } = await runSpec(twoBriefSpec, {
    store: store2,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider: provider2,
    armIds: ["H2"],
    briefIds: ["b2"],
    maxSpendByProviderUsd: { anthropic: ceiling },
    log: silentLog,
  });

  assert.equal(second.completed, 0, "H2/b2 must be skipped -- admitting it would push cumulative Anthropic spend past a ceiling only crossed once the first invocation's real spend is added in");
  assert.equal(second.skipped, 1);
  assert.equal(provider2.calls.length, 0, "the provider was never called for the budget-skipped cell");
});

test("issue #64: a GLOBAL --max-spend ceiling is also enforced cumulatively across invocations, not just the per-provider ceiling", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  const provider1 = new MockProvider();

  const twoBriefSpec = { ...SPEC_PROVIDERS, briefs: [{ id: "b1" }, { id: "b2" }] };

  const { summary: first } = await runSpec(twoBriefSpec, {
    store: store1,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider: provider1,
    armIds: ["H2"],
    briefIds: ["b1"],
    log: silentLog,
  });
  assert.equal(first.completed, 1);
  // The first invocation ran with NO ceiling active, so its OWN
  // `cumulativeSpendByProvider`/`cumulativeSpendUsd` are `null` by design
  // (spendToDate is only ever called when a ceiling is active -- see
  // runSpec's own comment on `priorSpend`/`anyCeilingActive`). Derive
  // "what was actually spent" from `spendByProvider` instead, which is
  // ALWAYS computed regardless of whether a ceiling was requested.
  assert.equal(first.cumulativeSpendByProvider, null, "sanity: no ceiling was active on the first invocation");
  const priorTotal = first.spendByProvider.anthropic;
  assert.ok(priorTotal > 0);

  const store2 = new ResultsStore(dir);
  const provider2 = new MockProvider();
  const { projection } = planAndPrice({ ...twoBriefSpec, arms: [{ id: "H2" }], briefs: [{ id: "b2" }] }, { store: store2, armsConfig: ARMS_CONFIG_PROVIDERS });

  // Same reasoning as the per-provider test above: the ceiling must sit
  // strictly above the pre-flight projection ALONE (projection.usd), or a
  // broken implementation that never consults the store would also trip it
  // for the wrong reason.
  const ceiling = projection.usd + priorTotal / 2;
  assert.ok(ceiling > projection.usd, "sanity: the ceiling alone would NOT be tripped by the pre-flight projection");

  const { summary: second } = await runSpec(twoBriefSpec, {
    store: store2,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider: provider2,
    armIds: ["H2"],
    briefIds: ["b2"],
    maxSpendUsd: ceiling,
    log: silentLog,
  });

  assert.equal(second.completed, 0, "the global ceiling must already be considered crossed once the first invocation's real spend is folded in");
  assert.equal(second.skipped, 1);
});

test("issue #64: cumulative admission uses strict '>' -- a cell that would land EXACTLY on the ceiling is admitted, one cent over is skipped", async (t) => {
  // A hand-rolled priceGrid gives an exact, round projected cost ($0.50 for
  // Anthropic) so the boundary math has no dependency on any real pricing
  // table's numbers -- isolates the comparison OPERATOR itself as the thing
  // under test, per the task's named mutation ("> where it needs >= or vice
  // versa").
  const exactPriceGrid = () => ({
    usd: 0.5,
    breakdown: [{ cellKey: "arm=H2|brief=bNew|rep=0|cfg=" + CFG_HASH, usd: 0.5, byProvider: { anthropic: 0.5 } }],
  });
  const newCellSpec = { arms: [{ id: "H2" }], briefs: [{ id: "bNew" }], replicates: 1, config: CFG };

  async function runSecondInvocation(ceiling) {
    const dir = tempDir(t);
    const store1 = new ResultsStore(dir);
    // Seed EXACTLY $1.00 of prior Anthropic spend, arithmetic-exact via a
    // custom rate table rather than a real MockProvider run.
    seedSpentRow(store1, {
      key: "arm=H2|brief=seedExact|rep=0|cfg=" + CFG_HASH,
      armId: "H2",
      briefId: "seedExact",
      cfg: CFG_HASH,
      model: "claude-haiku-4-5",
      inputTokens: 2_000_000,
      outputTokens: 0,
    });
    const exactRateTable = { "claude-haiku-4-5": { in: 1, out: 0, source: "test", date: "2026-08-01" } };
    // Sanity: this rate table x these tokens x the default batch discount
    // (0.5, since claude-haiku-4-5 has no override) prices the seeded row at
    // EXACTLY $1.00 -- (2,000,000/1e6 * 1) * (1 - 0.5) = $1.00.
    const seeded = spendToDate(store1, exactRateTable, { batch: true });
    assert.equal(seeded.byProvider.anthropic, 1, "sanity: the seeded row prices to exactly $1.00 under the test rate table");

    const store2 = new ResultsStore(dir);
    const provider = new MockProvider();
    const { summary } = await runSpec(newCellSpec, {
      store: store2,
      armsConfig: ARMS_CONFIG_PROVIDERS,
      provider,
      priceGrid: exactPriceGrid,
      rateTable: exactRateTable,
      maxSpendByProviderUsd: { anthropic: ceiling },
      log: silentLog,
    });
    return summary;
  }

  // $1.00 prior + $0.50 projected = $1.50 exactly. At ceiling === $1.50, the
  // cell lands EXACTLY on the ceiling and must be ADMITTED (`already +
  // projected > ceiling` is false when they're equal).
  const atBoundary = await runSecondInvocation(1.5);
  assert.equal(atBoundary.completed, 1, "exactly-at-the-ceiling must be admitted, not skipped -- '>' not '>='");
  assert.equal(atBoundary.skipped, 0);

  // One cent over: must now be skipped.
  const overBoundary = await runSecondInvocation(1.49);
  assert.equal(overBoundary.completed, 0, "one cent over the ceiling must be skipped");
  assert.equal(overBoundary.skipped, 1);
});

test("issue #64: summary exposes BOTH this-invocation spend (spendByProvider, unchanged) and cumulative spend (cumulativeSpendByProvider/cumulativeSpendUsd) -- only when a ceiling is active; null when it is not", async (t) => {
  const dir = tempDir(t);
  const store1 = new ResultsStore(dir);
  const provider1 = new MockProvider();
  const twoBriefSpec = { ...SPEC_PROVIDERS, briefs: [{ id: "b1" }, { id: "b2" }] };

  const { summary: first } = await runSpec(twoBriefSpec, {
    store: store1,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider: provider1,
    armIds: ["H2"],
    briefIds: ["b1"],
    log: silentLog,
  });
  // No ceiling on the first invocation -- cumulative fields are `null`, not
  // `{}`/`0` (PR #72 review: `null` means "not computed", never "computed as
  // zero", and the store's full history is deliberately never read for a
  // run that has nothing to gate against it).
  assert.equal(first.cumulativeSpendByProvider, null);
  assert.equal(first.cumulativeSpendUsd, null);
  assert.equal(first.cumulativeNonProviderSpendUsd, null);
  assert.equal(first.cumulativeNonProviderModels, null);

  const store2 = new ResultsStore(dir);
  const provider2 = new MockProvider();
  const { summary: second } = await runSpec(twoBriefSpec, {
    store: store2,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider: provider2,
    armIds: ["H2"],
    briefIds: ["b2"],
    // A ceiling generous enough to admit the cell, active only so the
    // cumulative fields actually get computed -- the point of this test.
    maxSpendByProviderUsd: { anthropic: 1000 },
    log: silentLog,
  });

  assert.equal(second.completed, 1);
  // spendByProvider stays THIS-INVOCATION-ONLY -- second invocation never ran
  // H2/b1, so it must not appear in second.spendByProvider's contribution
  // beyond what the second invocation itself spent.
  assert.equal(second.spendByProvider.anthropic, second.cumulativeSpendByProvider.anthropic - first.spendByProvider.anthropic, "cumulative = prior invocations' spend + this invocation's own spend, never conflating the two");
  assert.ok(second.cumulativeSpendByProvider.anthropic > second.spendByProvider.anthropic, "cumulative total is strictly larger than this invocation's own total once a prior invocation spent something");
  assert.equal(second.cumulativeSpendUsd, second.cumulativeSpendByProvider.anthropic, "no embedder spend in this store -- the global cumulative total equals the one provider's cumulative total");
  assert.equal(second.cumulativeNonProviderSpendUsd, 0, "no embedder rows in this store");
  assert.deepEqual(second.cumulativeNonProviderModels, []);
});

// ── issue #85: pool metrics wiring ──────────────────────────────────────────
// runSpec() had NO caller of evals/metrics/operational.mjs's
// poolMetricsSummary -- generation -> store -> judge -> store, with no
// distinct_k/embeddings ever computed for a real cell. These tests assert
// against a REAL ResultsStore (not a spy), reading `store.get(key).result`
// back the same way evals/analysis/frame.mjs does, so a test that passes
// with the wiring deleted is structurally impossible.

/** A hermetic embedder double matching evals/metrics/embedder.mjs's
 *  interface (embed/modelId/usage), including voyageEmbedder's CUMULATIVE
 *  `usage.total_tokens` contract -- a test asserting per-cell metering must
 *  see the same shape the real embedder exposes, or it would pass against a
 *  double that doesn't actually exercise the delta-metering logic. */
class MockEmbedder {
  constructor({ vectorFor = () => [1, 0], tokensPerText = 10, failOnText = new Set(), partialTokensBeforeFail = 0 } = {}) {
    this.modelId = "voyage-4-lite";
    this.usage = { total_tokens: 0 };
    this.vectorFor = vectorFor;
    this.tokensPerText = tokensPerText;
    this.failOnText = failOnText;
    this.partialTokensBeforeFail = partialTokensBeforeFail;
    this.calls = [];
  }
  async embed(texts) {
    this.calls.push(texts);
    if (texts.some((t) => this.failOnText.has(t))) {
      // Mirrors voyageEmbedder's per-chunk usage accounting: tokens already
      // consumed by chunks that succeeded BEFORE the failing one still land
      // on `.usage.total_tokens`, even though embed() itself throws.
      this.usage.total_tokens += this.partialTokensBeforeFail;
      throw new Error("MockEmbedder: forced failure");
    }
    this.usage.total_tokens += texts.length * this.tokensPerText;
    return texts.map((t) => this.vectorFor(t));
  }
}

// Orthogonal unit vectors: cosine distance 1 between any two distinct texts,
// 0 between identical texts -- deterministic clustering under threshold 0.5
// with no dependency on a real calibrated constant.
const ORTHOGONAL_BASIS = { "idea-1": [1, 0], "idea-2": [0, 1] };
function orthogonalVectorFor(text) {
  // MockProvider's default candidates are "mock-idea-1-<key>"/"mock-idea-2-<key>".
  if (text.includes("idea-1")) return ORTHOGONAL_BASIS["idea-1"];
  if (text.includes("idea-2")) return ORTHOGONAL_BASIS["idea-2"];
  return [1, 1];
}
const METRICS_THRESHOLD = 0.5;

test("issue #85: runSpec computes and persists pool metrics for a completed cell when opts.embedder is supplied", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const embedder = new MockEmbedder({ vectorFor: orthogonalVectorFor });

  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  await runSpec(oneCellSpec, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    embedder,
    clusterDistanceThreshold: METRICS_THRESHOLD,
    log: silentLog,
  });

  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const record = store.get(key);
  assert.equal(record.accounting.state, "completed");
  // Exactly what evals/analysis/frame.mjs reads: getPath(body.result, "distinct_k")
  // and (when poolField is supplied) getPath(body.result, "pool").
  assert.equal(record.result.distinct_k, 2, "two orthogonal candidates under threshold 0.5 never merge");
  assert.ok(Array.isArray(record.result.pool) && record.result.pool.length === 2, "result.pool is the embedded pool, one vector per candidate");
  assert.deepEqual(record.result.pool[0], [1, 0]);
  assert.deepEqual(record.result.pool[1], [0, 1]);
  assert.equal(record.result.rawCandidateCount, 2);
  assert.equal(record.result.postDedupPoolSize, 2);
  assert.equal(record.result.collapseRate, 0, "no collapse -- every candidate is its own equivalence class");
  assert.equal(record.result.poolDiversity, 1, "mean pairwise cosine distance between orthogonal unit vectors is 1");
  assert.equal(record.result.fluency, 2);
  assert.equal(record.result.flexibility, 2);
  assert.equal(embedder.calls.length, 1, "exactly one embed() call for this one completed cell");
});

test("issue #85: the embedder call is metered as a non-provider costRow (voyage-4-lite), excluded from byProvider, counted in totalUsd", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const embedder = new MockEmbedder({ vectorFor: orthogonalVectorFor, tokensPerText: 7 });

  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  await runSpec(oneCellSpec, { store, armsConfig: ARMS_CONFIG, provider, embedder, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const record = store.get(key);
  const embedderRow = record.costRows.find((r) => r.model === "voyage-4-lite");
  assert.ok(embedderRow, "a voyage-4-lite costRow is stored alongside the generation costRow");
  assert.equal(embedderRow.input_tokens, 14, "2 candidates x 7 tokens each -- the DELTA of this one embed() call, not a cumulative total");

  const spend = spendToDate(store);
  assert.ok(spend.excludedNonProviderUsd > 0, "embedder spend is priced and surfaced via excludedNonProviderUsd");
  assert.deepEqual(Object.keys(spend.byProvider).includes("voyage"), false, "embedder spend never lands in byProvider -- issue #72's basis split");
});

test("issue #85: embedder metering is DELTA, not cumulative -- a second cell's costRow is not inflated by the first cell's tokens", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const embedder = new MockEmbedder({ vectorFor: orthogonalVectorFor, tokensPerText: 10 });

  const twoCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }, { id: "b2" }], replicates: 1, config: CFG };
  await runSpec(twoCellSpec, { store, armsConfig: ARMS_CONFIG, provider, embedder, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  const key1 = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const key2 = cellKey({ armId: "A", briefId: "b2", replicate: 0, cfg: CFG_HASH });
  const row1 = store.get(key1).costRows.find((r) => r.model === "voyage-4-lite");
  const row2 = store.get(key2).costRows.find((r) => r.model === "voyage-4-lite");
  assert.equal(row1.input_tokens, 20, "cell 1: 2 candidates x 10 tokens");
  assert.equal(row2.input_tokens, 20, "cell 2 must NOT include cell 1's tokens too -- delta metering, not the embedder's running total");
  assert.equal(embedder.usage.total_tokens, 40, "the embedder's own cumulative counter is the sum of both cells, confirming the double's shape matches voyageEmbedder's contract");
});

test("issue #85: a failed generation cell has no candidates and is never embedded -- zero embedder calls, no distinct_k", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const overrides = new Map([[key, { terminalState: "failed", failureKind: "empty_pool", detail: "candidates: []" }]]);
  const provider = new MockProvider({ overrides });
  const embedder = new MockEmbedder({ vectorFor: orthogonalVectorFor });

  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const { summary } = await runSpec(oneCellSpec, { store, armsConfig: ARMS_CONFIG, provider, embedder, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  assert.equal(summary.failed, 1);
  assert.equal(embedder.calls.length, 0, "a classified generation failure is never embedded");
  const record = store.get(key);
  assert.equal(record.result.failed, true);
  assert.equal(record.result.distinct_k, undefined);
});

// ── PR #86 review fix round ──────────────────────────────────────────────────
// The original approach stored a `failed` record under cell.key on a metrics
// failure. lib/manifest.mjs's planRun receives only KEYS -- it cannot tell a
// completed cell from a failed one -- so once cell.key existed in the store
// AT ALL, every future invocation classified it `reuse` forever (append-only,
// no delete). A transient Voyage 429 would permanently destroy an already-paid
// cell with no way to retry it, and the loss would correlate with arm size
// (bigger pools embed more tokens -> more 429s -> panel arms lose cells
// preferentially), confounding H1. The fix: leave cell.key OUT of the store
// on a metrics failure so planRun keeps it `todo`; preserve the already-spent
// money under an attempt-scoped key instead (mirrors evals/judge/gate.mjs's
// meterJudgeCall fix for the identical shape of bug in the judge path, #76).

test("issue #85 fix round: a metrics-computation failure leaves the cell ABSENT from the store, and a subsequent planRun classifies it todo, not reuse", async (t) => {
  const dir = tempDir(t);
  const store = new ResultsStore(dir);
  const provider = new MockProvider();
  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const embedder = new MockEmbedder({
    vectorFor: orthogonalVectorFor,
    failOnText: new Set([`mock-idea-1-${key}`, `mock-idea-2-${key}`]),
    partialTokensBeforeFail: 5,
  });

  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };
  const { summary } = await runSpec(oneCellSpec, { store, armsConfig: ARMS_CONFIG, provider, embedder, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  assert.equal(summary.completed, 0, "generation succeeded but metrics did not -- this cell must NOT reconcile as completed");
  assert.equal(summary.skipped, 1, "a metrics failure is a SKIP (retryable), never a stored failure");
  assert.equal(summary.failed, 0, "the generation itself did not fail -- only metrics did, and that must not surface as a generation failure");

  assert.throws(() => store.get(key), /no stored record/, "cell.key must be completely absent from the store -- nothing to read back");

  // The real assertion this test exists for: planRun's ACTUAL output over a
  // FRESH store instance (re-reading index.jsonl from disk, exactly like a
  // real resumed session would), not an intermediate like store.has(key).
  const store2 = new ResultsStore(dir);
  const plan = planRun(oneCellSpec, store2.keys());
  assert.deepEqual(plan.todo.map((c) => c.key), [key], "the cell must be planned as todo");
  assert.deepEqual(plan.reuse, [], "the cell must NOT be classified reuse -- planRun has no accounting-state visibility and would treat any stored key as a completed reuse");
});

test("issue #85 fix round: the generation cost row survives a metrics failure under an attempt-scoped key, and is not double-counted when the retry succeeds", async (t) => {
  const dir = tempDir(t);
  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };

  // First invocation: metrics fails. Money must survive under an
  // attempt-scoped key, never under cell.key.
  const store1 = new ResultsStore(dir);
  const failingEmbedder = new MockEmbedder({
    vectorFor: orthogonalVectorFor,
    failOnText: new Set([`mock-idea-1-${key}`, `mock-idea-2-${key}`]),
    partialTokensBeforeFail: 5,
  });
  await runSpec(oneCellSpec, { store: store1, armsConfig: ARMS_CONFIG, provider: new MockProvider(), embedder: failingEmbedder, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  const attemptKey = `metrics-attempt|cell=${key}|attempt=0`;
  const attemptRecord = store1.get(attemptKey);
  assert.equal(attemptRecord.accounting.state, "failed");
  const embedderRow = attemptRecord.costRows.find((r) => r.model === "voyage-4-lite");
  assert.ok(embedderRow, "tokens the embedder actually consumed before failing are still durably metered");
  assert.equal(embedderRow.input_tokens, 5);
  assert.ok(attemptRecord.costRows.some((r) => r.model !== "voyage-4-lite"), "the generation cost row (real money already spent) survives under the attempt-scoped key");

  const spendAfterFailure = spendToDate(store1);
  const spentAfterFailure = spendAfterFailure.totalUsd;
  assert.ok(spentAfterFailure > 0, "spend from the failed attempt is real and priced");

  // Second invocation over the SAME store/spec, this time with a working
  // embedder: the cell is retried (todo again -- see the companion test
  // above), spending a SECOND real generation cost. The first attempt's
  // spend must still be there, undisturbed -- not double-counted, not
  // dropped.
  const store2 = new ResultsStore(dir);
  const workingEmbedder = new MockEmbedder({ vectorFor: orthogonalVectorFor });
  const { summary } = await runSpec(oneCellSpec, { store: store2, armsConfig: ARMS_CONFIG, provider: new MockProvider(), embedder: workingEmbedder, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });
  assert.equal(summary.completed, 1, "the retry succeeds");

  // The first attempt's record must be untouched (append-only store; a
  // second attempt gets attempt=1, never overwrites attempt=0).
  const attemptRecordAfterRetry = store2.get(attemptKey);
  assert.deepEqual(attemptRecordAfterRetry, attemptRecord, "the first failed attempt's record is never mutated by a later successful retry");

  const spendAfterRetry = spendToDate(store2).totalUsd;
  assert.ok(spendAfterRetry > spentAfterFailure, "the retry's own real spend (generation + embedder) is ADDED on top of the first attempt's preserved spend, never replacing or double-counting it");
});

test("issue #85 fix round: a retry after a metrics failure produces a complete, correctly-metered cell", async (t) => {
  const dir = tempDir(t);
  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };

  const store1 = new ResultsStore(dir);
  const failingEmbedder = new MockEmbedder({
    vectorFor: orthogonalVectorFor,
    failOnText: new Set([`mock-idea-1-${key}`, `mock-idea-2-${key}`]),
    partialTokensBeforeFail: 5,
  });
  await runSpec(oneCellSpec, { store: store1, armsConfig: ARMS_CONFIG, provider: new MockProvider(), embedder: failingEmbedder, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  const store2 = new ResultsStore(dir);
  const workingEmbedder = new MockEmbedder({ vectorFor: orthogonalVectorFor, tokensPerText: 7 });
  const { summary } = await runSpec(oneCellSpec, { store: store2, armsConfig: ARMS_CONFIG, provider: new MockProvider(), embedder: workingEmbedder, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  assert.equal(summary.completed, 1);
  assert.equal(summary.skipped, 0, "only the FIRST invocation records a skip -- the retry, run as its own invocation, has nothing to skip");
  assert.equal(workingEmbedder.calls.length, 1, "the retry actually re-embeds -- a fresh generation call, genuinely re-spending, exactly as intended");

  const record = store2.get(key);
  assert.equal(record.accounting.state, "completed");
  assert.equal(record.result.distinct_k, 2, "the retried cell carries real, complete metrics");
  assert.ok(Array.isArray(record.result.pool) && record.result.pool.length === 2);
  const embedderRow = record.costRows.find((r) => r.model === "voyage-4-lite");
  assert.ok(embedderRow, "the retry's own embedder call is metered on the cell's own record");
  assert.equal(embedderRow.input_tokens, 14, "2 candidates x 7 tokens -- this retry's own delta, unaffected by the first attempt's partial 5 tokens");
});

test("issue #85: resuming a run does not recompute metrics for an already-completed cell -- no re-embed, no double-meter", async (t) => {
  const dir = tempDir(t);
  const embedder1 = new MockEmbedder({ vectorFor: orthogonalVectorFor });
  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };

  const store1 = new ResultsStore(dir);
  await runSpec(oneCellSpec, { store: store1, armsConfig: ARMS_CONFIG, provider: new MockProvider(), embedder: embedder1, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });
  assert.equal(embedder1.calls.length, 1);

  // A second invocation over the SAME store/spec: the cell is now `reuse`,
  // not `todo` -- metrics must not be recomputed (the stored record is
  // append-only and already carries them).
  const store2 = new ResultsStore(dir);
  const embedder2 = new MockEmbedder({ vectorFor: orthogonalVectorFor });
  const { summary } = await runSpec(oneCellSpec, { store: store2, armsConfig: ARMS_CONFIG, provider: new MockProvider(), embedder: embedder2, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  assert.equal(summary.completed, 1, "the reused cell still reconciles as completed");
  assert.equal(embedder2.calls.length, 0, "no embed() call on the resumed invocation -- the cell was reused, not re-run");
});

test("issue #85: opts.embedder without opts.clusterDistanceThreshold fails loud before any provider call", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const embedder = new MockEmbedder({ vectorFor: orthogonalVectorFor });

  await assert.rejects(
    () => runSpec(SPEC, { store, armsConfig: ARMS_CONFIG, provider, embedder, log: silentLog }),
    /clusterDistanceThreshold/,
  );
  assert.deepEqual(provider.calls, [], "the pre-flight assertion fires before any generation spend");
});

test("issue #85: omitting opts.embedder leaves runSpec's behavior byte-for-byte unchanged -- no distinct_k, no pool, no embedder costRow", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const provider = new MockProvider();
  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };

  await runSpec(oneCellSpec, { store, armsConfig: ARMS_CONFIG, provider, log: silentLog });

  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const record = store.get(key);
  assert.equal(record.accounting.state, "completed");
  assert.equal(record.result.distinct_k, undefined);
  assert.equal(record.result.pool, undefined);
  assert.deepEqual(record.costRows.filter((r) => r.model === "voyage-4-lite"), []);
});

// ── PR #86 review, fix round 2 ────────────────────────────────────────────────────────────
// 1. Attempt-scoping was correct in shape but UNPINNED -- no test drove a
//    SECOND metrics failure on the same cell, which is exactly the scenario
//    the attempt counter exists for (ordinary operator flow: run 1 fails
//    metrics on cell X, operator re-runs, cell X is todo again, metrics
//    fails AGAIN). A hardcoded `attempt=0` key would make the second
//    store.put() collide with the first under DIFFERENT content -- the
//    exact store-bricking shape #76 fixed for judge retries, reappearing
//    here. This is verified RED under that exact mutation below.
// 2. Skip reasons were aggregated into one undifferentiated `skipped` count
//    -- `metrics_failed` and `budget_exceeded` mean opposite things to an
//    operator and Phase 2a's go/no-go depends on telling them apart.

test("issue #85 fix round 2: two metrics failures on the SAME cell each get their own attempt-scoped key, with their own cost rows, neither lost nor double-counted", async (t) => {
  const dir = tempDir(t);
  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const oneCellSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };

  // Attempt 1: fails.
  const store1 = new ResultsStore(dir);
  const failingEmbedder1 = new MockEmbedder({
    vectorFor: orthogonalVectorFor,
    failOnText: new Set([`mock-idea-1-${key}`, `mock-idea-2-${key}`]),
    partialTokensBeforeFail: 5,
  });
  await runSpec(oneCellSpec, { store: store1, armsConfig: ARMS_CONFIG, provider: new MockProvider(), embedder: failingEmbedder1, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });

  // Attempt 2, over the SAME store (a fresh instance, exactly like a real
  // resumed session re-reading index.jsonl from disk): fails AGAIN, with a
  // DIFFERENT partial-token count so the two attempt records are
  // distinguishable by content, not just by key.
  const store2 = new ResultsStore(dir);
  const failingEmbedder2 = new MockEmbedder({
    vectorFor: orthogonalVectorFor,
    failOnText: new Set([`mock-idea-1-${key}`, `mock-idea-2-${key}`]),
    partialTokensBeforeFail: 9,
  });
  // This is the call that would THROW (store-bricking, #76-shaped defect)
  // under a hardcoded attempt key, because the second store.put() would
  // collide with the first under different content (different tokens,
  // different timestamp).
  const { summary: summary2 } = await runSpec(oneCellSpec, { store: store2, armsConfig: ARMS_CONFIG, provider: new MockProvider(), embedder: failingEmbedder2, clusterDistanceThreshold: METRICS_THRESHOLD, log: silentLog });
  assert.equal(summary2.skipped, 1, "the second attempt is ALSO a retryable skip, not a crash");

  const attempt0Key = `metrics-attempt|cell=${key}|attempt=0`;
  const attempt1Key = `metrics-attempt|cell=${key}|attempt=1`;
  const record0 = store2.get(attempt0Key);
  const record1 = store2.get(attempt1Key);
  assert.equal(record0.costRows.find((r) => r.model === "voyage-4-lite").input_tokens, 5, "attempt 0's own tokens, untouched by attempt 1");
  assert.equal(record1.costRows.find((r) => r.model === "voyage-4-lite").input_tokens, 9, "attempt 1's own tokens -- a DISTINCT record, not a merge or an overwrite of attempt 0");
  assert.notDeepEqual(record0, record1, "the two attempts are genuinely distinct stored records");

  // Both attempts' generation spend is durably counted -- neither lost nor
  // double-counted (two real, separate generation calls really happened).
  const totalSpend = spendToDate(store2).totalUsd;
  const spendAfterOne = spendToDate(store1).totalUsd;
  assert.ok(totalSpend > spendAfterOne, "the second attempt's spend is ADDED on top of the first, never replacing it");

  // The cell itself is STILL absent and STILL todo after two failed
  // attempts -- a third attempt would retry it exactly the same way.
  assert.throws(() => store2.get(key), /no stored record/);
  const plan = planRun(oneCellSpec, store2.keys());
  assert.deepEqual(plan.todo.map((c) => c.key), [key]);
});

test("issue #85 fix round 2: in a single invocation, a budget_exceeded skip and a metrics_failed skip are counted under DISTINCT reasons in summary.skippedByReason, never merged", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const key1 = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const twoBriefSpec = { arms: [{ id: "A" }], briefs: [{ id: "b1" }, { id: "b2" }], replicates: 1, config: CFG };

  // b1's own projected cost, used to set a ceiling that admits b1 (and its
  // metrics-failing embedder call) but leaves no headroom for b2 at all --
  // b2 must be budget-skipped, never even reaching the provider.
  const { projection } = planAndPrice(twoBriefSpec, { store, armsConfig: ARMS_CONFIG });
  const perCellCost = projection.breakdown.find((b) => b.cellKey === key1).usd;

  const embedder = new MockEmbedder({
    vectorFor: orthogonalVectorFor,
    failOnText: new Set([`mock-idea-1-${key1}`, `mock-idea-2-${key1}`]), // fails ONLY b1's cell
  });

  const { summary } = await runSpec(twoBriefSpec, {
    store,
    armsConfig: ARMS_CONFIG,
    provider: new MockProvider(),
    embedder,
    clusterDistanceThreshold: METRICS_THRESHOLD,
    // Admits b1's own PROJECTED cost (so b1 is at least attempted), but b1's
    // ACTUAL post-hoc spend (MockProvider's real, fixed token count prices
    // at 1/5th the interim per-cell PROJECTION -- verified empirically:
    // interim projects $0.015/cell, MockProvider's real cost is $0.003/cell)
    // plus b2's own projected cost together exceed this -- b2 is
    // budget-skipped. 1.1x is deliberately tight to that measured ratio: a
    // wider margin (e.g. 1.5x) would let b2's projected cost slip in under
    // the ceiling even after b1's real spend, admitting it instead of
    // skipping it.
    maxSpendUsd: perCellCost * 1.1,
    log: silentLog,
  });

  assert.equal(summary.completed, 0);
  assert.equal(summary.skipped, 2, "both cells end up skipped, for TWO DIFFERENT reasons");
  assert.deepEqual(
    summary.skippedByReason,
    { metrics_failed: 1, budget_exceeded: 1 },
    "a metrics-failure wave must stay visibly distinct from a budget stop -- never conflated into one undifferentiated skip count",
  );
});
