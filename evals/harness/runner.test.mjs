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
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ResultsStore } from "../../lib/store.mjs";
import { configHash, cellKey } from "../../lib/manifest.mjs";
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
  const priorTotal = first.cumulativeSpendUsd;
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

test("issue #64: summary exposes BOTH this-invocation spend (spendByProvider, unchanged) and cumulative spend (cumulativeSpendByProvider/cumulativeSpendUsd)", async (t) => {
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

  const store2 = new ResultsStore(dir);
  const provider2 = new MockProvider();
  const { summary: second } = await runSpec(twoBriefSpec, {
    store: store2,
    armsConfig: ARMS_CONFIG_PROVIDERS,
    provider: provider2,
    armIds: ["H2"],
    briefIds: ["b2"],
    log: silentLog,
  });

  assert.equal(second.completed, 1);
  // spendByProvider stays THIS-INVOCATION-ONLY -- second invocation never ran
  // H2/b1, so it must not appear in second.spendByProvider's contribution
  // beyond what the second invocation itself spent.
  assert.equal(second.spendByProvider.anthropic, second.cumulativeSpendByProvider.anthropic - first.spendByProvider.anthropic, "cumulative = prior invocations' spend + this invocation's own spend, never conflating the two");
  assert.ok(second.cumulativeSpendByProvider.anthropic > second.spendByProvider.anthropic, "cumulative total is strictly larger than this invocation's own total once a prior invocation spent something");
  assert.equal(second.cumulativeSpendUsd, second.cumulativeSpendByProvider.anthropic, "single-provider grid: the global cumulative total equals the one provider's cumulative total");
});
