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
import { runSpec, planAndPrice, interimPriceGrid } from "./runner.mjs";
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
