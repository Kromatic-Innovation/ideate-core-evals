// phase0.test.mjs — hermetic tests for phase0.mjs's orchestration/store-write
// wiring. No network: every dependency (embedder, datReplicationFn,
// negativeControlsFn) is injected, mirroring evals/run.mjs main()'s own
// deps-injection pattern (runSpecFn/store/getEngineVersion) and
// live-validation.test.mjs's rationale for why the SHIPPED wiring, not just
// the pure math underneath it, needs direct coverage.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runPhase0, DAT_REPLICATION_KEY, NEGATIVE_CONTROLS_KEY } from "./phase0.mjs";
import { makeTempStore } from "../../lib/store.mjs";
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD } from "./voyage-calibration.mjs";
import { CLUSTER_DISTANCE_THRESHOLD } from "./calibration.mjs";

// A minimal fake embedder: usage.total_tokens increments by 1 per text
// embedded, so tests can assert an exact, predictable token split between
// the two stored cost rows without any real network call.
function fakeEmbedder({ apiKey } = {}) {
  if (!apiKey) throw new Error("fakeEmbedder: apiKey required (mirrors the real voyageEmbedder contract)");
  return {
    modelId: "fake-voyage-4-lite",
    usage: { total_tokens: 0 },
    async embed(texts) {
      this.usage.total_tokens += texts.length;
      return texts.map(() => [1, 0]);
    },
  };
}

function passingDatFn() {
  return async (embedder) => {
    await embedder.embed(["low1", "low2"]); // 2 tokens
    return { low: 0.1, average: 0.2, high: 0.3, orderingHolds: true, margin: 0.2 };
  };
}

function passingControlsFn(capturedOpts) {
  return async (embedder, opts) => {
    capturedOpts.push(opts);
    await embedder.embed(["dup1", "dup2", "dup3"]); // 3 tokens
    return {
      duplicate: { distinctK: 1, diversity: 0, collapseRate: 1 },
      random: { distinctK: 30, diversity: 0.5, collapseRate: 0.0 },
    };
  };
}

test("runPhase0 requires apiKey and store", async () => {
  await assert.rejects(() => runPhase0({ store: makeTempStore() }), /apiKey is required/);
  await assert.rejects(() => runPhase0({ apiKey: "k" }), /store .* is required/);
});

test("runPhase0 stores both controls under the documented keys, with token-based costRows and no cost_usd", async () => {
  const store = makeTempStore();
  const capturedOpts = [];
  const summary = await runPhase0({
    apiKey: "test-key",
    store,
    embedderFactory: fakeEmbedder,
    datReplicationFn: passingDatFn(),
    negativeControlsFn: passingControlsFn(capturedOpts),
  });

  assert.equal(summary.embedderId, "fake-voyage-4-lite");
  assert.equal(summary.allPassed, true);
  assert.equal(summary.totalTokens, 5); // 2 (dat) + 3 (controls)

  assert.equal(store.has(DAT_REPLICATION_KEY), true);
  assert.equal(store.has(NEGATIVE_CONTROLS_KEY), true);

  const datRecord = store.get(DAT_REPLICATION_KEY);
  assert.deepEqual(datRecord.result, { low: 0.1, average: 0.2, high: 0.3, orderingHolds: true, margin: 0.2 });
  assert.equal(datRecord.accounting.state, "completed");
  assert.equal(datRecord.costRows.length, 1);
  assert.equal(datRecord.costRows[0].model, "fake-voyage-4-lite");
  assert.equal(datRecord.costRows[0].input_tokens, 2);
  assert.equal("cost_usd" in datRecord.costRows[0], false);

  const controlsRecord = store.get(NEGATIVE_CONTROLS_KEY);
  assert.equal(controlsRecord.result.duplicate.passed, true);
  assert.equal(controlsRecord.result.random.verdict.failed, false);
  assert.equal(controlsRecord.costRows[0].input_tokens, 3);
  assert.equal(controlsRecord.result.threshold, VOYAGE_CLUSTER_DISTANCE_THRESHOLD);
});

// ── The discriminating test: the VOYAGE threshold must reach negativeControls,
// not its MiniLM-space default ──────────────────────────────────────────────
// negativeControls() (./validation.mjs) defaults its `threshold` param to
// CLUSTER_DISTANCE_THRESHOLD (MiniLM-space) when the caller omits it — the
// correct default ONLY for the hermetic fixture-embedder call sites. If
// phase0.mjs ever stopped passing { threshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD }
// explicitly (e.g. a refactor that forwards `opts` incompletely), a live
// Phase 0 run would silently validate the study's diversity metric against
// the WRONG cut -- exactly the defect issue #48 calls out by name ("running
// against the MiniLM threshold would validate a cut the study will not
// use"). This test fails loudly if that wiring regresses.
test("runPhase0 passes the Voyage-calibrated threshold to negativeControls, not the MiniLM default", async () => {
  assert.notEqual(
    VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
    CLUSTER_DISTANCE_THRESHOLD,
    "the two calibrated thresholds must actually differ for this test to be meaningful",
  );

  const store = makeTempStore();
  const capturedOpts = [];
  await runPhase0({
    apiKey: "test-key",
    store,
    embedderFactory: fakeEmbedder,
    datReplicationFn: passingDatFn(),
    negativeControlsFn: passingControlsFn(capturedOpts),
  });

  assert.equal(capturedOpts.length, 1);
  assert.equal(capturedOpts[0].threshold, VOYAGE_CLUSTER_DISTANCE_THRESHOLD);
  assert.notEqual(capturedOpts[0].threshold, CLUSTER_DISTANCE_THRESHOLD);
});

test("runPhase0 reports allPassed=false when DAT ordering does not hold, even if the negative controls look fine", async () => {
  const store = makeTempStore();
  const capturedOpts = [];
  const failingDatFn = async (embedder) => {
    await embedder.embed(["x"]);
    return { low: 0.3, average: 0.2, high: 0.1, orderingHolds: false, margin: -0.2 };
  };

  const summary = await runPhase0({
    apiKey: "test-key",
    store,
    embedderFactory: fakeEmbedder,
    datReplicationFn: failingDatFn,
    negativeControlsFn: passingControlsFn(capturedOpts),
  });

  assert.equal(summary.dat.orderingHolds, false);
  assert.equal(summary.allPassed, false, "a broken DAT ordering must fail Phase 0 as a whole, per §4.4's control table");
});

test("runPhase0 reports allPassed=false when the duplicate pool does not collapse to distinct_k=1", async () => {
  const store = makeTempStore();
  const notCollapsingControlsFn = async (embedder, opts) => {
    await embedder.embed(["dup"]);
    return {
      duplicate: { distinctK: 3, diversity: 0.1, collapseRate: 0.9 }, // did NOT collapse to 1
      random: { distinctK: 30, diversity: 0.5, collapseRate: 0.0 },
    };
  };

  const summary = await runPhase0({
    apiKey: "test-key",
    store,
    embedderFactory: fakeEmbedder,
    datReplicationFn: passingDatFn(),
    negativeControlsFn: notCollapsingControlsFn,
  });

  assert.equal(summary.duplicatePassed, false);
  assert.equal(summary.allPassed, false);
});

test("runPhase0's stored records are byte-identical no-ops on a second call with the same inputs (store append-only contract)", async () => {
  const store = makeTempStore();
  const capturedOpts = [];
  const deps = {
    apiKey: "test-key",
    store,
    embedderFactory: fakeEmbedder,
    datReplicationFn: passingDatFn(),
    negativeControlsFn: passingControlsFn(capturedOpts),
    now: () => "2026-09-02T00:00:00.000Z",
  };

  await runPhase0(deps);
  // Second call with a fresh fake embedder (fresh usage counters) but the
  // same fixed `now`, dat, and controls results -- store.put() must accept
  // this as a verified no-op, not throw "already exists with DIFFERENT
  // content" (see lib/store.mjs put()).
  await assert.doesNotReject(() => runPhase0(deps));
});
