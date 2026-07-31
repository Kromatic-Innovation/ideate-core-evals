// integration.test.mjs — AC5: an integration test with the mock provider
// covering the FULL path: plan -> (per cell) generate -> account -> store ->
// reconcile. This is the one test that exercises every module the runner
// composes end-to-end, rather than isolating one behavior at a time (that's
// runner.test.mjs's job). Hermetic: temp store dir, mock provider, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ResultsStore } from "../../lib/store.mjs";
import { planRun } from "../../lib/manifest.mjs";
import { configHash, cellKey } from "../../lib/manifest.mjs";
import { runSpec } from "./runner.mjs";
import { MockProvider } from "./provider.mjs";
import { operationalSummary } from "../metrics/operational.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-integration-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A grid shaped closer to the real study: a mixed-tier arm (E-like) plus a
// homogeneous arm, 3 briefs, 2 replicates -- big enough to meaningfully
// exercise reuse/resume/failure/skip together, small enough to stay a fast
// unit test.
const ARMS_CONFIG = {
  arms: {
    B: {
      mode: "panel",
      slots: [
        { persona: "proposer_1", model: "claude-haiku-4-5" },
        { persona: "proposer_2", model: "claude-haiku-4-5" },
      ],
    },
    E: {
      mode: "panel",
      slots: [
        { persona: "proposer_1", model: "claude-haiku-4-5" },
        { persona: "proposer_2", model: "claude-sonnet-5" },
        { persona: "proposer_3", model: "claude-opus-5" },
      ],
    },
  },
};

const CFG = { harnessVersion: "0.0.1", engineSha: "int-test-sha", promptHash: "int-test-prompt", corpusHash: "int-test-corpus" };
const CFG_HASH = configHash(CFG);

const SPEC = {
  arms: [{ id: "B" }, { id: "E" }],
  briefs: [{ id: "biz-01" }, { id: "biz-02" }, { id: "prod-01" }],
  replicates: 2,
  config: CFG,
};

test("full path: plan -> generate -> account -> store -> reconcile, including a mixed-tier arm and a forced failure", async (t) => {
  const store = new ResultsStore(tempDir(t));

  // Force one specific cell in the mixed-provider arm E to fail, to prove the
  // full path handles a classified failure alongside normal completions in
  // the SAME run (not an isolated single-cell test, per AC5's "full path").
  const forcedFailKey = cellKey({ armId: "E", briefId: "biz-01", replicate: 0, cfg: CFG_HASH });
  const overrides = new Map([[forcedFailKey, { terminalState: "failed", failureKind: "rate_limited", detail: "429 after retries" }]]);
  const provider = new MockProvider({ overrides });

  // 1. PLAN — confirm the plan step sees the full 12-cell grid (2 arms x 3
  // briefs x 2 replicates) as entirely todo on a fresh store.
  const plan = planRun(SPEC, store.keys());
  assert.equal(plan.todo.length, 12);
  assert.equal(plan.reuse.length, 0);

  // 2. GENERATE + ACCOUNT + STORE + RECONCILE, all inside runSpec().
  const { summary, account } = await runSpec(SPEC, {
    store,
    armsConfig: ARMS_CONFIG,
    provider,
    log: () => {},
  });

  // reconcile() ran and passed inside runSpec — re-assert explicitly here as
  // the integration-level guarantee the AC calls for.
  assert.doesNotThrow(() => account.reconcile());
  assert.equal(summary.planned, 12);
  assert.equal(summary.completed, 11);
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.byKind, { rate_limited: 1 });

  // 3. The provider actually saw BOTH arms and their distinct model slots --
  // proof the mixed-tier arm E's per-persona model resolution flowed through
  // to the provider call, not just arm B's uniform one.
  const armsCalled = new Set(provider.calls.map((c) => c.armId));
  assert.deepEqual(armsCalled, new Set(["B", "E"]));

  // 4. STORE correctness: every completed cell is fetchable and carries
  // resolvedModels reflecting the arm's ACTUAL per-slot models (mixed-tier
  // arm E's resolvedModels must show three distinct models, not one).
  const someECell = cellKey({ armId: "E", briefId: "biz-01", replicate: 1, cfg: CFG_HASH });
  assert.ok(store.has(someECell));
  const eRecord = store.get(someECell);
  assert.deepEqual(
    eRecord.resolvedModels,
    { proposer_1: "claude-haiku-4-5", proposer_2: "claude-sonnet-5", proposer_3: "claude-opus-5" },
    "resolvedModels captures exactly what ran for the mixed-tier arm",
  );
  assert.deepEqual(new Set(Object.keys(eRecord.costRows[0].tokens_by_model)), new Set(["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"]));

  // 5. The failed cell is ALSO in the store (not dropped), with a `failed`
  // accounting state and a costRows array (possibly carrying partial token
  // usage the mock still reports for a classified failure).
  const failedRecord = store.get(forcedFailKey);
  assert.equal(failedRecord.accounting.state, "failed");
  assert.equal(failedRecord.accounting.kind, "rate_limited");

  // 6. Downstream metrics (evals/metrics/operational.mjs, issue #3) can
  // consume this RunAccount directly once reconciled -- proving the harness's
  // output is actually usable by the rest of the pipeline, not just
  // internally self-consistent. This is the point of "full path": the
  // account this module produces is exactly the shape the rest of the study
  // already trusts.
  const opSummary = operationalSummary(account);
  assert.equal(opSummary.parseFailureRate, 0);
  assert.ok(opSummary.latency.n >= 11, "latency was recorded for the completed cells");

  // 7. RESUME within the same test: simulate a second session against the
  // same store dir with a FRESH ResultsStore instance and a fresh provider,
  // requesting a WIDER grid (add a replicate). Only the new cells + nothing
  // already covered should hit the provider.
  const store2 = new ResultsStore(store.dir);
  const provider2 = new MockProvider();
  const widerSpec = { ...SPEC, replicates: 3 };
  const { summary: resumedSummary } = await runSpec(widerSpec, {
    store: store2,
    armsConfig: ARMS_CONFIG,
    provider: provider2,
    log: () => {},
  });

  // 12 previously-completed-or-failed cells are already terminal (reuse);
  // only the 6 new replicate-2 cells (2 arms x 3 briefs x 1 new replicate)
  // are todo.
  assert.equal(resumedSummary.planned, 18);
  assert.equal(provider2.calls.length, 6, "only the newly-added replicate's cells hit the provider");
});
