// storeConfig.test.mjs — issue #91.
//
// The headline test in this file is the RUN -> ANALYSIS ROUND TRIP: it builds
// a spec exactly the way evals/run.mjs builds one, stores cells under the cfg
// that spec produces, and then asserts the ANALYSIS side selects them. That
// is the test that would have caught #91, and the one that stops the two
// sides drifting apart again — it never hardcodes a hash, so it fails the
// moment either side changes which fields enter configHash without the other
// following.
//
// Hermetic: temp stores only, no network, no sidecar.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeTempStore } from "../../lib/store.mjs";
import { planCells, cellKey, configHash } from "../../lib/manifest.mjs";
import {
  resolveStoreConfigHash,
  tallyStoredConfigs,
  NoStoredConfigError,
  AmbiguousStoredConfigError,
  UnknownStoredConfigError,
} from "./storeConfig.mjs";
import { buildFrame, assertCellsSelected, NoCellsSelectedError } from "./frame.mjs";

/** Store one completed study cell. `distinct_k` is arbitrary but numeric —
 *  buildFrame() requires a numeric response on any completed cell it fits. */
function putCell(store, { key, armId, briefId, replicate, cfg, distinctK = 7 }) {
  store.put({
    key,
    armId,
    briefId,
    replicate,
    cfg,
    result: { distinct_k: distinctK },
    resolvedModels: { proposer: "test-model" },
    accounting: { state: "completed" },
    costRows: [],
  });
}

// ── The round trip ──────────────────────────────────────────────────────────

/** The shape evals/run.mjs's main() builds — the same five CONFIG_FIELDS it
 *  actually sets, with placeholder values. Deliberately NOT the full nine:
 *  the point is that the analysis side must select whatever the runner wrote,
 *  whichever subset that happens to be. */
function runnerSpec() {
  return {
    arms: [{ id: "A" }, { id: "B" }],
    briefs: [{ id: "biz-01" }, { id: "biz-02" }],
    replicates: 2,
    config: {
      harnessVersion: "0.0.1",
      engineSha: "ideate-core@0.4.0",
      promptHash: "unpinned",
      embedderId: "voyage-4-lite",
      corpusHash: "55e05c2811a7",
    },
  };
}

test("round trip: cells stored under the runner's spec are selected by the analysis side, with no hash retyped anywhere", () => {
  const store = makeTempStore("storeconfig-roundtrip-");
  const spec = runnerSpec();
  const planned = planCells(spec);
  assert.equal(planned.length, 8);
  for (const cell of planned) {
    putCell(store, { key: cell.key, armId: cell.armId, briefId: cell.briefId, replicate: cell.replicate, cfg: cell.cfg });
  }

  // The analysis side is given NOTHING but the store — no config, no hash.
  const { configHash: selected } = resolveStoreConfigHash(store);
  const frame = buildFrame(store, { configHash: selected });

  // It agrees with what the runner wrote. Computed from the spec, never a
  // literal: if either side's field set changes, this equality is what breaks.
  assert.equal(selected, configHash(spec.config));
  assert.equal(frame.configHash, configHash(spec.config));
  assert.equal(frame.rows.length, 8);
  assert.deepEqual(frame.armLevels, ["A", "B"]);
  assert.equal(frame.excluded.stale.length, 0);
});

test("round trip: clusterDistanceThreshold does NOT enter the analysis side's selection — the two sides cannot disagree about a field only one of them sets", () => {
  // #91's second-order trap: clusterDistanceThreshold IS a CONFIG_FIELDS
  // entry, analysis.mjs used to set it, and run.mjs does not. Under
  // store-derived selection, analysis.mjs computes no hash at all, so the
  // field set is whatever the runner used — full stop.
  const store = makeTempStore("storeconfig-threshold-");
  const spec = runnerSpec();
  for (const cell of planCells(spec)) {
    putCell(store, { key: cell.key, armId: cell.armId, briefId: cell.briefId, replicate: cell.replicate, cfg: cell.cfg });
  }

  const withThreshold = configHash({ ...spec.config, clusterDistanceThreshold: 0.23141118234233987 });
  assert.notEqual(withThreshold, configHash(spec.config), "precondition: the threshold does change the hash at the manifest boundary");

  const { configHash: selected } = resolveStoreConfigHash(store);
  assert.equal(selected, configHash(spec.config));
  assert.notEqual(selected, withThreshold);
  assert.equal(buildFrame(store, { configHash: selected }).rows.length, 8);
});

// ── Resolution ──────────────────────────────────────────────────────────────

test("resolveStoreConfigHash: a store holding one configHash needs no operator input", () => {
  const store = makeTempStore("storeconfig-single-");
  putCell(store, { key: cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: "aaaaaaaaaaaa" }), armId: "A", briefId: "b1", replicate: 0, cfg: "aaaaaaaaaaaa" });
  assert.equal(resolveStoreConfigHash(store).configHash, "aaaaaaaaaaaa");
});

test("resolveStoreConfigHash: an empty store is NoStoredConfigError, not an empty frame", () => {
  const store = makeTempStore("storeconfig-empty-");
  assert.throws(() => resolveStoreConfigHash(store), NoStoredConfigError);
});

test("resolveStoreConfigHash: two configHashes are REFUSED, never chosen between — even when one has far more cells", () => {
  const store = makeTempStore("storeconfig-ambiguous-");
  for (let r = 0; r < 5; r++) {
    putCell(store, { key: cellKey({ armId: "A", briefId: "b1", replicate: r, cfg: "aaaaaaaaaaaa" }), armId: "A", briefId: "b1", replicate: r, cfg: "aaaaaaaaaaaa" });
  }
  putCell(store, { key: cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: "bbbbbbbbbbbb" }), armId: "A", briefId: "b1", replicate: 0, cfg: "bbbbbbbbbbbb" });

  assert.throws(
    () => resolveStoreConfigHash(store),
    (err) => {
      assert.ok(err instanceof AmbiguousStoredConfigError);
      // Both candidates named, with counts, plus the escape hatch.
      assert.match(err.message, /aaaaaaaaaaaa {2}5 cell\(s\)/);
      assert.match(err.message, /bbbbbbbbbbbb {2}1 cell\(s\)/);
      assert.match(err.message, /--config-hash/);
      return true;
    },
  );

  // ...and the operator's explicit choice resolves it, either way.
  assert.equal(resolveStoreConfigHash(store, { configHash: "bbbbbbbbbbbb" }).configHash, "bbbbbbbbbbbb");
  assert.equal(buildFrame(store, { configHash: "bbbbbbbbbbbb" }).rows.length, 1);
});

test("resolveStoreConfigHash: a --config-hash the store does not hold names expected-vs-held HERE, not as armLevels [] four modules later", () => {
  const store = makeTempStore("storeconfig-unknown-");
  putCell(store, { key: cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: "aaaaaaaaaaaa" }), armId: "A", briefId: "b1", replicate: 0, cfg: "aaaaaaaaaaaa" });

  assert.throws(
    () => resolveStoreConfigHash(store, { configHash: "560d764366bc", resultsDir: "results" }),
    (err) => {
      assert.ok(err instanceof UnknownStoredConfigError);
      assert.match(err.message, /expected cfg 560d764366bc/);
      assert.match(err.message, /holds aaaaaaaaaaaa \(1 cell\(s\)\)/);
      return true;
    },
  );
});

test("tallyStoredConfigs: judge-call and phase0 records are not candidates — a real store holds them alongside study cells", () => {
  // Observed on the #8 smoke study's store: a judge-call record's `cfg` is
  // the JUDGE MODEL ID and a phase0 record's `cfg` is an object. Counting
  // either would report a one-experiment store as ambiguous, and could hand
  // back a model id where a config hash belongs.
  const store = makeTempStore("storeconfig-nonstudy-");
  putCell(store, { key: cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: "aaaaaaaaaaaa" }), armId: "A", briefId: "b1", replicate: 0, cfg: "aaaaaaaaaaaa" });
  store.put({
    key: "judge-call|cell=arm=A|brief=b1|rep=0|cfg=aaaaaaaaaaaa|judge=claude-haiku-4-5|attempt=0",
    armId: "__judge-call__",
    briefId: "arm=A|brief=b1|rep=0|cfg=aaaaaaaaaaaa",
    replicate: 0,
    cfg: "claude-haiku-4-5",
    result: { scores: [] },
    resolvedModels: { judge: "claude-haiku-4-5" },
    accounting: { state: "completed" },
    costRows: [],
  });
  store.put({
    key: "phase0/dat-replication@2026-09-02T02:27:42.435Z-02c8b419",
    cfg: { passed: true, runId: "2026-09-02T02:27:42.435Z-02c8b419" },
    result: { passed: true },
    resolvedModels: {},
    accounting: { state: "completed" },
    costRows: [],
  });

  assert.deepEqual(tallyStoredConfigs(store), [{ cfg: "aaaaaaaaaaaa", count: 1, states: ["completed"] }]);
  assert.equal(resolveStoreConfigHash(store).configHash, "aaaaaaaaaaaa");
});

// ── Total exclusion, reported as itself ─────────────────────────────────────

test("assertCellsSelected: a frame that selected nothing names the exclusion, the expected hash, and what the store holds", () => {
  const store = makeTempStore("storeconfig-excluded-");
  for (let r = 0; r < 3; r++) {
    putCell(store, { key: cellKey({ armId: "A", briefId: "b1", replicate: r, cfg: "aaaaaaaaaaaa" }), armId: "A", briefId: "b1", replicate: r, cfg: "aaaaaaaaaaaa" });
  }
  // Reaching buildFrame() with a hash the store lacks is unreachable from the
  // CLI now (the resolver refuses first); this pins the backstop directly.
  const frame = buildFrame(store, { configHash: "560d764366bc" });
  assert.deepEqual(frame.armLevels, [], "precondition: this is exactly the state that used to read as a bad --reference-arm");

  assert.throws(
    () => assertCellsSelected(frame),
    (err) => {
      assert.ok(err instanceof NoCellsSelectedError);
      assert.match(err.message, /selected 0 cells: 3 excluded as stale/);
      assert.match(err.message, /expected cfg 560d764366bc, store holds aaaaaaaaaaaa \(3\)/);
      return true;
    },
  );
});

test("assertCellsSelected: a frame with rows passes through unchanged", () => {
  const store = makeTempStore("storeconfig-ok-");
  putCell(store, { key: cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: "aaaaaaaaaaaa" }), armId: "A", briefId: "b1", replicate: 0, cfg: "aaaaaaaaaaaa" });
  const frame = buildFrame(store, { configHash: "aaaaaaaaaaaa" });
  assert.equal(assertCellsSelected(frame), frame);
});

// ── The frame boundary's own guard ──────────────────────────────────────────

test("buildFrame: opts.config and opts.configHash together are refused — two sources of truth, one winner", () => {
  const store = makeTempStore("storeconfig-both-");
  assert.throws(
    () => buildFrame(store, { config: { harnessVersion: "0.0.1" }, configHash: "aaaaaaaaaaaa" }),
    /never both/,
  );
});
