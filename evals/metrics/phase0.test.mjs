// phase0.test.mjs — hermetic tests for phase0.mjs's orchestration/store-write
// wiring. No network: every dependency (embedder, datReplicationFn,
// negativeControlsFn, getGitSha) is injected, mirroring evals/run.mjs
// main()'s own deps-injection pattern (runSpecFn/store/getEngineVersion).
import { test } from "node:test";
import assert from "node:assert/strict";

import { runPhase0, DAT_REPLICATION_KEY_PREFIX, NEGATIVE_CONTROLS_KEY_PREFIX, phase0Key } from "./phase0.mjs";
import { makeTempStore } from "../../lib/store.mjs";
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD, VOYAGE_CALIBRATION_RECORD } from "./voyage-calibration.mjs";
import { CLUSTER_DISTANCE_THRESHOLD } from "./calibration.mjs";

const STUB_GIT_SHA = () => "stub-sha";

// A minimal fake embedder: usage.total_tokens increments by 1 per text
// embedded, so tests can assert an exact, predictable token split between
// the two stored cost rows without any real network call. modelId defaults
// to the REAL registered calibration record's embedderId so ordinary
// happy-path tests pass phase0.mjs's embedder/threshold-provenance check —
// see the dedicated mismatch test below for the case where it doesn't.
function fakeEmbedder({ apiKey, modelId = VOYAGE_CALIBRATION_RECORD.embedderId } = {}) {
  if (!apiKey) throw new Error("fakeEmbedder: apiKey required (mirrors the real voyageEmbedder contract)");
  return {
    modelId,
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

const BASE_DEPS = () => ({
  apiKey: "test-key",
  store: makeTempStore(),
  embedderFactory: fakeEmbedder,
  getGitSha: STUB_GIT_SHA,
});

test("runPhase0 requires apiKey and store", async () => {
  await assert.rejects(() => runPhase0({ store: makeTempStore(), getGitSha: STUB_GIT_SHA }), /apiKey is required/);
  await assert.rejects(() => runPhase0({ apiKey: "k", getGitSha: STUB_GIT_SHA }), /store .* is required/);
});

test("runPhase0 refuses to run when the embedder's modelId does not match the calibration record's embedderId", async () => {
  const capturedOpts = [];
  await assert.rejects(
    () =>
      runPhase0({
        ...BASE_DEPS(),
        embedderFactory: (opts) => fakeEmbedder({ ...opts, modelId: "some-other-embedder" }),
        datReplicationFn: passingDatFn(),
        negativeControlsFn: passingControlsFn(capturedOpts),
      }),
    /does not match the embedder the registered threshold was calibrated against/,
  );
});

test("runPhase0 stores both controls under run-discriminated keys, with token-based costRows, cfg.passed, and no cost_usd", async () => {
  const deps = BASE_DEPS();
  const capturedOpts = [];
  const summary = await runPhase0({
    ...deps,
    datReplicationFn: passingDatFn(),
    negativeControlsFn: passingControlsFn(capturedOpts),
  });

  assert.equal(summary.embedderId, VOYAGE_CALIBRATION_RECORD.embedderId);
  assert.equal(summary.allPassed, true);
  assert.equal(summary.totalTokens, 5); // 2 (dat) + 3 (controls)
  assert.equal(summary.gitSha, "stub-sha");
  assert.equal(summary.datKey, phase0Key(DAT_REPLICATION_KEY_PREFIX, summary.runId));
  assert.equal(summary.controlsKey, phase0Key(NEGATIVE_CONTROLS_KEY_PREFIX, summary.runId));

  const store = deps.store;
  assert.equal(store.has(summary.datKey), true);
  assert.equal(store.has(summary.controlsKey), true);

  const datRecord = store.get(summary.datKey);
  assert.equal(datRecord.result.low, 0.1);
  assert.equal(datRecord.result.marginIsDescriptiveOnly, true);
  assert.equal(datRecord.accounting.state, "completed");
  assert.equal(datRecord.costRows.length, 1);
  assert.equal(datRecord.costRows[0].model, VOYAGE_CALIBRATION_RECORD.embedderId);
  assert.equal(datRecord.costRows[0].billing_mode, "api");
  assert.equal(datRecord.costRows[0].input_tokens, 2);
  assert.equal("cost_usd" in datRecord.costRows[0], false);
  // issue #119: this embedder call has no batch code path in this codebase,
  // so its regime is always "single", regardless of any study-wide batch flag.
  assert.equal(datRecord.costRows[0].pricing_regime, "single");

  // cfg is INDEX-visible metadata (lib/store.mjs put()) -- a reader must be
  // able to see pass/fail by scanning list() alone, without opening a body.
  const listEntry = store.list().find((e) => e.key === summary.datKey);
  assert.equal(listEntry.cfg.passed, true);
  assert.equal(listEntry.cfg.runId, summary.runId);

  const controlsRecord = store.get(summary.controlsKey);
  assert.equal(controlsRecord.result.duplicate.passed, true);
  assert.equal(controlsRecord.result.random.verdict.failed, false);
  assert.equal(controlsRecord.costRows[0].input_tokens, 3);
  assert.equal(controlsRecord.costRows[0].billing_mode, "api");
  assert.equal(controlsRecord.costRows[0].pricing_regime, "single"); // issue #119
  assert.equal(controlsRecord.result.threshold, VOYAGE_CLUSTER_DISTANCE_THRESHOLD);
  assert.equal(controlsRecord.result.thresholdProvenance.pairSetHash, VOYAGE_CALIBRATION_RECORD.pairSetHash);
  assert.equal(controlsRecord.result.provenance.gitSha, "stub-sha");

  const controlsListEntry = store.list().find((e) => e.key === summary.controlsKey);
  assert.equal(controlsListEntry.cfg.passed, true);
});

// ── The discriminating test: the VOYAGE threshold must reach negativeControls,
// not its MiniLM-space default ──────────────────────────────────────────────
test("runPhase0 passes the Voyage-calibrated threshold to negativeControls, not the MiniLM default", async () => {
  assert.notEqual(
    VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
    CLUSTER_DISTANCE_THRESHOLD,
    "the two calibrated thresholds must actually differ for this test to be meaningful",
  );

  const deps = BASE_DEPS();
  const capturedOpts = [];
  await runPhase0({ ...deps, datReplicationFn: passingDatFn(), negativeControlsFn: passingControlsFn(capturedOpts) });

  assert.equal(capturedOpts.length, 1);
  assert.equal(capturedOpts[0].threshold, VOYAGE_CLUSTER_DISTANCE_THRESHOLD);
  assert.notEqual(capturedOpts[0].threshold, CLUSTER_DISTANCE_THRESHOLD);
});

test("runPhase0 reports allPassed=false when DAT ordering does not hold, even if the negative controls look fine", async () => {
  const deps = BASE_DEPS();
  const capturedOpts = [];
  const failingDatFn = async (embedder) => {
    await embedder.embed(["x"]);
    return { low: 0.3, average: 0.2, high: 0.1, orderingHolds: false, margin: -0.2 };
  };

  const summary = await runPhase0({ ...deps, datReplicationFn: failingDatFn, negativeControlsFn: passingControlsFn(capturedOpts) });

  assert.equal(summary.dat.orderingHolds, false);
  assert.equal(summary.allPassed, false, "a broken DAT ordering must fail Phase 0 as a whole, per §4.4's control table");
  const listEntry = deps.store.list().find((e) => e.key === summary.datKey);
  assert.equal(listEntry.cfg.passed, false);
});

// ── BLOCKING 2 (Quine, PR #69): the random-pool control must actually gate ──
// Prior to this fix, `allPassed` had no dependency on `randomVerdict.failed`
// reachable by a test in this file -- randomPoolVerdict itself was well
// covered (validation.test.mjs), but nothing drove a FAILING random pool
// through runPhase0 end-to-end. This closes that gap directly.
test("runPhase0 reports allPassed=false when the random-text pool fails its verdict, even with a passing DAT and duplicate pool", async () => {
  const deps = BASE_DEPS();
  const failingRandomControlsFn = async (embedder) => {
    await embedder.embed(["dup"]);
    return {
      duplicate: { distinctK: 1, diversity: 0, collapseRate: 1 }, // passes
      random: { distinctK: 10, diversity: 0.1, collapseRate: 0.7 }, // well below the 90% bound and the DAT-high floor
    };
  };

  const summary = await runPhase0({ ...deps, datReplicationFn: passingDatFn(), negativeControlsFn: failingRandomControlsFn });

  assert.equal(summary.duplicatePassed, true);
  assert.equal(summary.randomVerdict.failed, true);
  assert.equal(summary.allPassed, false, "a failing random-pool verdict must fail Phase 0 even when every other control passes");
});

// ── Duplicate-pool gate: BOTH conjuncts must be exercised independently ────
test("runPhase0 fails when distinct_k != 1, even with near-zero diversity", async () => {
  const deps = BASE_DEPS();
  const notCollapsingControlsFn = async (embedder) => {
    await embedder.embed(["dup"]);
    return {
      duplicate: { distinctK: 3, diversity: 0.01, collapseRate: 0.9 }, // diversity looks fine, distinctK does not
      random: { distinctK: 30, diversity: 0.5, collapseRate: 0.0 },
    };
  };

  const summary = await runPhase0({ ...deps, datReplicationFn: passingDatFn(), negativeControlsFn: notCollapsingControlsFn });

  assert.equal(summary.dupVerdict.distinctKPass, false);
  assert.equal(summary.dupVerdict.diversityPass, true);
  assert.equal(summary.duplicatePassed, false);
  assert.equal(summary.allPassed, false);
});

test("runPhase0 fails when diversity is >= the 0.05 bound, even with distinct_k exactly 1 (pins the diversity conjunct, not just distinct_k)", async () => {
  const deps = BASE_DEPS();
  const highDiversityControlsFn = async (embedder) => {
    await embedder.embed(["dup"]);
    return {
      duplicate: { distinctK: 1, diversity: 0.06, collapseRate: 1 }, // distinctK is exactly 1, diversity is over the bound
      random: { distinctK: 30, diversity: 0.5, collapseRate: 0.0 },
    };
  };

  const summary = await runPhase0({ ...deps, datReplicationFn: passingDatFn(), negativeControlsFn: highDiversityControlsFn });

  assert.equal(summary.dupVerdict.distinctKPass, true);
  assert.equal(summary.dupVerdict.diversityPass, false);
  assert.equal(summary.duplicatePassed, false);
  assert.equal(summary.allPassed, false);

  const controlsRecord = deps.store.get(summary.controlsKey);
  assert.equal(controlsRecord.result.duplicate.passed, false, "the STORED passed field must reflect the real verdict, not a hardcoded true");
});

// ── poolSize must be the REAL random-pool size, not a stand-in ─────────────
// distinctK=26 is < Math.ceil(30 * 0.9) = 27 (the real bound), so it must
// FAIL. If poolSize were ever hardcoded to something small (e.g. 1),
// Math.ceil(1 * 0.9) = 1 and 26 >= 1 would wrongly PASS -- this test
// distinguishes the two.
test("runPhase0 evaluates the random-pool distinct_k bound against the real 30-item pool size, not a stand-in", async () => {
  const deps = BASE_DEPS();
  const capturedOpts = [];
  const nearMissControlsFn = async (embedder) => {
    await embedder.embed(["dup"]);
    return {
      duplicate: { distinctK: 1, diversity: 0, collapseRate: 1 },
      random: { distinctK: 26, diversity: 0.9, collapseRate: 0.1 },
    };
  };

  const summary = await runPhase0({ ...deps, datReplicationFn: passingDatFn(), negativeControlsFn: nearMissControlsFn });

  assert.equal(summary.randomVerdict.distinctKPass, false, "26 < ceil(30*0.9)=27 must fail against the real pool size");
  assert.equal(summary.allPassed, false);
});

// ── cfg.passed on the negative-controls row for the FAILING case (Quine,
// PR #69 second fix round) ───────────────────────────────────────────
// A passing cfg.passed=true was already covered (the happy-path test
// above); nothing previously pinned the FAILING value at the index level,
// which is exactly the field #48 AC1 ("the study stops here with the
// failure recorded") depends on being legible without opening a body.
test("runPhase0 sets cfg.passed=false (index-visible) on the negative-controls row when a control fails", async () => {
  const deps = BASE_DEPS();
  const failingControlsFn = async (embedder) => {
    await embedder.embed(["dup"]);
    return {
      duplicate: { distinctK: 3, diversity: 0.5, collapseRate: 0.5 }, // fails both conjuncts
      random: { distinctK: 30, diversity: 0.5, collapseRate: 0.0 },
    };
  };

  const summary = await runPhase0({ ...deps, datReplicationFn: passingDatFn(), negativeControlsFn: failingControlsFn });

  assert.equal(summary.allPassed, false);
  const controlsListEntry = deps.store.list().find((e) => e.key === summary.controlsKey);
  assert.equal(controlsListEntry.cfg.passed, false, "cfg.passed must reflect the real (failing) verdict, not a hardcoded true");
  // the DAT row passed independently -- confirms this isn't a blanket flag
  // shared across both rows.
  const datListEntry = deps.store.list().find((e) => e.key === summary.datKey);
  assert.equal(datListEntry.cfg.passed, true);
});

// ── storedAt pinning (Quine, PR #69 second fix round) ─────────────────
// storedAt must be the plain ISO `timestamp` (the value costRow's
// `timestamp` also carries), NOT the compound `runId` (which has a random
// suffix appended purely for key uniqueness -- see phase0.mjs's "Re-run /
// retry safety" header section). Pinned here with an injected `now` so the
// expected value is exact, not just "truthy".
test("runPhase0 stores storedAt as the plain ISO timestamp, not the compound runId", async () => {
  const FIXED_TIMESTAMP = "2026-09-02T12:00:00.000Z";
  const deps = BASE_DEPS();
  const capturedOpts = [];
  const summary = await runPhase0({
    ...deps,
    now: () => FIXED_TIMESTAMP,
    datReplicationFn: passingDatFn(),
    negativeControlsFn: passingControlsFn(capturedOpts),
  });

  assert.ok(summary.runId.startsWith(FIXED_TIMESTAMP), "runId must still be PREFIXED by the timestamp");
  assert.notEqual(summary.runId, FIXED_TIMESTAMP, "runId must carry a suffix beyond the bare timestamp (key-uniqueness entropy)");

  const datListEntry = deps.store.list().find((e) => e.key === summary.datKey);
  const controlsListEntry = deps.store.list().find((e) => e.key === summary.controlsKey);
  assert.equal(datListEntry.storedAt, FIXED_TIMESTAMP);
  assert.equal(controlsListEntry.storedAt, FIXED_TIMESTAMP);

  const datRecord = deps.store.get(summary.datKey);
  const controlsRecord = deps.store.get(summary.controlsKey);
  assert.equal(datRecord.costRows[0].timestamp, FIXED_TIMESTAMP);
  assert.equal(controlsRecord.costRows[0].timestamp, FIXED_TIMESTAMP);
});

// ── Provenance ───────────────────────────────────────────────────────────
test("runPhase0 records calibration pair-set hash and git SHA provenance on the negative-controls row", async () => {
  const deps = BASE_DEPS();
  const capturedOpts = [];
  const summary = await runPhase0({ ...deps, datReplicationFn: passingDatFn(), negativeControlsFn: passingControlsFn(capturedOpts) });

  const controlsRecord = deps.store.get(summary.controlsKey);
  assert.equal(controlsRecord.result.thresholdProvenance.pairSetHash, VOYAGE_CALIBRATION_RECORD.pairSetHash);
  assert.equal(controlsRecord.result.thresholdProvenance.embedderId, VOYAGE_CALIBRATION_RECORD.embedderId);

  const datRecord = deps.store.get(summary.datKey);
  assert.equal(datRecord.result.provenance.gitSha, "stub-sha");
  assert.equal(datRecord.result.provenance.embedderId, VOYAGE_CALIBRATION_RECORD.embedderId);
});

// ── Re-run / retry safety (BLOCKING 1, Quine, PR #69) ───────────────────────
// These tests exercise the SHIPPED default `now` (no injection) -- a prior
// version of this test suite only ever exercised a fixed injected `now`,
// which papered over a real collision in the shipped path. Confirmed red
// against the pre-fix phase0.mjs by hand before landing this fix.

test("runPhase0 with the SHIPPED default `now` (no override): two independent full runs against the same store never collide", async () => {
  const store = makeTempStore();
  const capturedOpts1 = [];
  const capturedOpts2 = [];

  const summary1 = await runPhase0({
    apiKey: "test-key",
    store,
    embedderFactory: fakeEmbedder,
    getGitSha: STUB_GIT_SHA,
    datReplicationFn: passingDatFn(),
    negativeControlsFn: passingControlsFn(capturedOpts1),
  });

  let summary2;
  await assert.doesNotReject(async () => {
    summary2 = await runPhase0({
      apiKey: "test-key",
      store,
      embedderFactory: fakeEmbedder,
      getGitSha: STUB_GIT_SHA,
      datReplicationFn: passingDatFn(),
      negativeControlsFn: passingControlsFn(capturedOpts2),
    });
  });

  assert.notEqual(summary1.runId, summary2.runId, "two separate invocations must get distinct run discriminators");
  assert.notEqual(summary1.datKey, summary2.datKey);
  assert.notEqual(summary1.controlsKey, summary2.controlsKey);
  assert.equal(store.has(summary1.datKey), true, "the first run's rows must still be present, not overwritten");
  assert.equal(store.has(summary2.datKey), true);
});

test("runPhase0 retries cleanly after a PARTIAL failure (DAT stored, negativeControls throws), using the shipped default `now`", async () => {
  const store = makeTempStore();
  const capturedOpts = [];

  const throwingControlsFn = async () => {
    throw new Error("simulated Voyage 429 during negativeControls");
  };

  const failedRun = await assert.rejects(() =>
    runPhase0({
      apiKey: "test-key",
      store,
      embedderFactory: fakeEmbedder,
      getGitSha: STUB_GIT_SHA,
      datReplicationFn: passingDatFn(),
      negativeControlsFn: throwingControlsFn,
    }),
    /simulated Voyage 429/,
  );

  // The DAT row landed (it's written before negativeControls runs); the
  // controls row does not exist -- a legible, orphaned partial run, not a
  // silent loss.
  const keysAfterPartialRun = store.keys();
  assert.equal(keysAfterPartialRun.length, 1);
  assert.ok(keysAfterPartialRun[0].startsWith("phase0/dat-replication@"));

  // Retry: a FRESH invocation, no `now` override -- must succeed cleanly,
  // never throw a "different content" collision against the orphaned row.
  const retrySummary = await runPhase0({
    apiKey: "test-key",
    store,
    embedderFactory: fakeEmbedder,
    getGitSha: STUB_GIT_SHA,
    datReplicationFn: passingDatFn(),
    negativeControlsFn: passingControlsFn(capturedOpts),
  });

  assert.equal(retrySummary.allPassed, true);
  assert.equal(store.has(retrySummary.datKey), true);
  assert.equal(store.has(retrySummary.controlsKey), true);
  // The retry's DAT key must differ from the orphaned partial run's DAT key
  // -- a fresh runId, not a collision.
  assert.notEqual(retrySummary.datKey, keysAfterPartialRun[0]);
});
