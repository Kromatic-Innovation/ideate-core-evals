// operational.test.mjs — hermetic tests proving operational metrics are
// computed FROM lib/accounting.mjs's RunAccount, not recomputed independently
// (issue #3 AC: "Operational metrics computed from the accounting layer, not
// recomputed independently").
import { test } from "node:test";
import assert from "node:assert/strict";

import { RunAccount } from "../../lib/accounting.mjs";
import {
  failureRate,
  parseFailureRate,
  emptyPoolRate,
  refusalRate,
  latencyPercentiles,
  operationalSummary,
  poolFluency,
  poolFlexibility,
  poolMetricsSummary,
} from "./operational.mjs";

function makeReconciledAccount() {
  const keys = ["arm=A|brief=b1|rep=0|cfg=x", "arm=A|brief=b2|rep=0|cfg=x", "arm=A|brief=b3|rep=0|cfg=x", "arm=A|brief=b4|rep=0|cfg=x"];
  const acct = new RunAccount(keys);
  acct.complete(keys[0], { distinct_k: 5, latencyMs: 1200 });
  acct.fail(keys[1], "parse_failure", "extractCandidates returned []");
  acct.fail(keys[2], "empty_pool", "candidates: []");
  acct.complete(keys[3], { distinct_k: 8, latencyMs: 900 });
  acct.reconcile();
  return acct;
}

test("failureRate reads RunAccount's OWN classification, not a re-derivation", () => {
  const acct = makeReconciledAccount();
  // 1 parse_failure out of 4 planned cells.
  assert.equal(failureRate(acct, "parse_failure"), 0.25);
  assert.equal(failureRate(acct, "empty_pool"), 0.25);
  assert.equal(failureRate(acct, "refusal"), 0, "no refusals were recorded");
});

test("failureRate rejects a kind not in lib/accounting.mjs FAILURE_KINDS", () => {
  const acct = makeReconciledAccount();
  assert.throws(() => failureRate(acct, "not_a_real_kind"), /not a recognized FAILURE_KINDS/);
});

test("parseFailureRate / emptyPoolRate / refusalRate are thin wrappers over the same accounting facts", () => {
  const acct = makeReconciledAccount();
  assert.equal(parseFailureRate(acct), failureRate(acct, "parse_failure"));
  assert.equal(emptyPoolRate(acct), failureRate(acct, "empty_pool"));
  assert.equal(refusalRate(acct), failureRate(acct, "refusal"));
});

test("operational metrics REFUSE to run on an unreconciled account (incomplete set would understate rates)", () => {
  const acct = new RunAccount(["arm=A|brief=b1|rep=0|cfg=x", "arm=A|brief=b2|rep=0|cfg=x"]);
  acct.complete("arm=A|brief=b1|rep=0|cfg=x", { distinct_k: 5, latencyMs: 100 });
  // b2 deliberately left unterminal — reconcile() would throw.
  assert.throws(() => parseFailureRate(acct), /not reconciled/);
  assert.throws(() => latencyPercentiles(acct), /not reconciled/);
});

test("operational metrics reject a non-RunAccount input", () => {
  assert.throws(() => parseFailureRate({}), /RunAccount instance/);
  assert.throws(() => parseFailureRate(null), /RunAccount instance/);
});

// ── Latency ──────────────────────────────────────────────────────────────

test("latencyPercentiles computes over COMPLETED cells only, excluding failed/skipped", () => {
  const acct = makeReconciledAccount();
  const { p50, p95, n } = latencyPercentiles(acct);
  assert.equal(n, 2, "only the 2 completed cells contribute; the 2 failed cells are excluded");
  assert.ok(p50 === 900 || p50 === 1200, "p50 is one of the two completed latencies");
  assert.equal(p95, 1200, "p95 of a 2-point sample is the larger value under nearest-rank");
});

test("latencyPercentiles returns null (not 0) when no cells completed — absence is not zero", () => {
  const keys = ["arm=A|brief=b1|rep=0|cfg=x"];
  const acct = new RunAccount(keys);
  acct.fail(keys[0], "timeout");
  acct.reconcile();
  const { p50, p95, n } = latencyPercentiles(acct);
  assert.equal(n, 0);
  assert.equal(p50, null);
  assert.equal(p95, null);
});

test("latencyPercentiles throws if a completed cell is missing a numeric latencyMs", () => {
  const keys = ["arm=A|brief=b1|rep=0|cfg=x"];
  const acct = new RunAccount(keys);
  acct.complete(keys[0], { distinct_k: 3 }); // no latencyMs
  acct.reconcile();
  assert.throws(() => latencyPercentiles(acct), /missing a numeric latencyMs/);
});

test("latencyPercentiles p50/p95 over a larger sample use nearest-rank consistently", () => {
  const keys = Array.from({ length: 10 }, (_, i) => `arm=A|brief=b${i}|rep=0|cfg=x`);
  const acct = new RunAccount(keys);
  keys.forEach((k, i) => acct.complete(k, { distinct_k: 1, latencyMs: (i + 1) * 100 })); // 100..1000
  acct.reconcile();
  const { p50, p95, n } = latencyPercentiles(acct);
  assert.equal(n, 10);
  // nearest-rank: p50 index = ceil(0.5*10)-1 = 4 -> 500; p95 index = ceil(0.95*10)-1 = 9 -> 1000
  assert.equal(p50, 500);
  assert.equal(p95, 1000);
});

// ── Bundle ───────────────────────────────────────────────────────────────

test("operationalSummary bundles all four metrics from one reconciled account", () => {
  const acct = makeReconciledAccount();
  const summary = operationalSummary(acct);
  assert.deepEqual(Object.keys(summary).sort(), ["emptyPoolRate", "latency", "parseFailureRate", "refusalRate"]);
  assert.equal(summary.parseFailureRate, 0.25);
  assert.equal(summary.emptyPoolRate, 0.25);
  assert.equal(summary.refusalRate, 0);
  assert.equal(summary.latency.n, 2);
});

// ── Pool-level LiveIdeaBench metrics (issue #45 item 2) ─────────────────────

test("poolFluency is the count of already-extracted candidates", () => {
  assert.equal(poolFluency([{ text: "a" }, { text: "b" }, { text: "c" }]), 3);
  assert.equal(poolFluency([]), 0);
});

test("poolFluency rejects a non-array", () => {
  assert.throws(() => poolFluency("not an array"), /pool must be an array/);
  assert.throws(() => poolFluency(null), /pool must be an array/);
});

test("poolFlexibility passes through an already-computed distinct_k count", () => {
  assert.equal(poolFlexibility(5), 5);
  assert.equal(poolFlexibility(0), 0);
});

test("poolFlexibility rejects a non-integer or negative distinct_k", () => {
  assert.throws(() => poolFlexibility(-1), /non-negative integer/);
  assert.throws(() => poolFlexibility(2.5), /non-negative integer/);
  assert.throws(() => poolFlexibility("5"), /non-negative integer/);
});

test("poolMetricsSummary bundles fluency and flexibility for one pool", () => {
  const pool = [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }];
  const summary = poolMetricsSummary({ pool, distinctKCount: 2 });
  assert.deepEqual(summary, { fluency: 4, flexibility: 2 });
});

test("a cell recorded as skipped (e.g. budget_exceeded) counts toward the denominator but no failure kind", () => {
  const keys = ["arm=A|brief=b1|rep=0|cfg=x", "arm=A|brief=b2|rep=0|cfg=x"];
  const acct = new RunAccount(keys);
  acct.complete(keys[0], { distinct_k: 4, latencyMs: 100 });
  acct.skip(keys[1], "budget_exceeded pre-flight");
  acct.reconcile();
  assert.equal(parseFailureRate(acct), 0, "skipped is not a parse_failure");
  assert.equal(latencyPercentiles(acct).n, 1, "skipped cells don't contribute a latency point");
});
